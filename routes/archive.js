import fs from 'fs/promises';
import path from 'path';
import { PassThrough } from 'stream';
import { ensureUserDirs, sanitizeName, cleanToken, tokenExpiry } from '../utils/fileHelpers.js';
import { DownloadManager, EXTRA_FOLDERS } from '../utils/downloadManager.js';
import { writeLibraryCsv } from '../utils/exportCsv.js';
import { Logger } from '../utils/logger.js';
import { jobManager } from '../utils/jobManager.js';
import { LibraryDB } from '../utils/database.js';
import { migrateJsonToDb } from '../utils/migrateToDb.js';
import archiver from 'archiver';

export default async function archiveRoutes(fastify, opts) {
  const { dataDir } = opts;

  // Download managers for runs in progress, so a fresh token can be handed over mid-run
  const activeRuns = new Map();

  fastify.post('/run', async (req, reply) => {
    const { username, cookie, limit, rateLimitMs, format, fullSync, verifyFiles, extras = {} } = req.body;
    if (!cookie || !username)
      return reply.code(400).send({ error: 'Missing username or token' });

    const user = sanitizeName(username);
    if (activeRuns.has(user))
      return reply.code(409).send({ error: 'An archive run is already in progress for this user' });

    const token = cleanToken(cookie);
    const { baseDir, dlDir } = await ensureUserDirs(dataDir, user);

    // Use rate limit from request, or fall back to env var, or default to 2000ms (2 seconds)
    const effectiveRateLimit = rateLimitMs ?? (process.env.RATE_LIMIT_MS ? parseInt(process.env.RATE_LIMIT_MS) : 2000);
    const effectiveConcurrency = process.env.CONCURRENCY ? parseInt(process.env.CONCURRENCY) : 3;
    const effectiveMaxRetries = process.env.MAX_RETRIES ? parseInt(process.env.MAX_RETRIES) : 3;
    const effectiveFormat = format || process.env.DEFAULT_FORMAT || 'mp3';

    // Initialize job tracking
    jobManager.create(user);
    jobManager.update(user, { tokenExpiresAt: tokenExpiry(token) });

    // Initialize logger
    const logger = new Logger({
      dataDir,
      username: user,
      fastifyLogger: fastify.log
    });
    await logger.init();

    try {
      // Migrate from JSON to database if needed
      await migrateJsonToDb(dataDir, user);

      // Initialize database
      const db = new LibraryDB(dataDir, user);

      // Get existing clip IDs from database
      const oldIds = new Set(db.getAllIds());

      // Smart pagination is only safe if the previous run reached the end of
      // the library. Databases from older versions have no flag, so they get a
      // full sync once to pick up anything an interrupted run left behind.
      const lastSyncComplete = db.getMeta('sync_complete') === '1';
      const resumePage = parseInt(db.getMeta('resume_page')) || 0;
      // Extras the user asked for: art, video, lyrics, metadata, sources
      const wantedExtras = EXTRA_FOLDERS.filter(folder => extras[folder]);
      // Every archived song has to be revisited once to fill in a newly chosen extra
      const extrasDone = (db.getMeta('extras_complete') || '').split(',').filter(Boolean);
      const extrasBackfill = wantedExtras.some(folder => !extrasDone.includes(folder));

      const shouldFullSync = fullSync || verifyFiles || oldIds.size === 0 || !lastSyncComplete || extrasBackfill;

      // Resume an unfinished sync a couple of pages early, in case songs
      // were deleted and shifted the pages since then
      const startPage = !lastSyncComplete && resumePage > 0 ? Math.max(0, resumePage - 2) : 0;

      if (oldIds.size === 0) {
        await logger.info('First run detected: full sync mode enabled automatically');
      } else if (!lastSyncComplete) {
        await logger.info(`Previous run did not reach the end of the library: full sync enabled, resuming at page ${startPage}`);
      } else if (shouldFullSync) {
        await logger.info('Full sync mode enabled: fetching all pages');
      }

      if (verifyFiles) {
        await logger.info('Verify files mode enabled: checking filesystem for existing files');
      }

      if (wantedExtras.length > 0) {
        await logger.info(`Saving extras: ${wantedExtras.join(', ')}${extrasBackfill ? ' (checking every archived song for missing extras)' : ''}`);
      }

      // Initialize download manager
      const dm = new DownloadManager({
        dataDir,
        username: user,
        cookie: token,
        logger,
        concurrency: effectiveConcurrency,
        maxRetries: effectiveMaxRetries,
        rateLimitMs: effectiveRateLimit,
        limit: limit || null, // Stop after this many downloads (testing)
        format: effectiveFormat,
        existingIds: oldIds,
        db: db, // Pass database for incremental writes
        fullSync: shouldFullSync,
        verifyFiles: verifyFiles || false, // Enable filesystem verification if requested
        dlDir: dlDir, // Pass download directory for file checks
        onProgress: progress => jobManager.updateProgress(user, progress),
        extras: Object.fromEntries(wantedExtras.map(folder => [folder, true])),
        userDir: baseDir,
        tokenWaitMs: process.env.TOKEN_WAIT_MS ? parseInt(process.env.TOKEN_WAIT_MS) : undefined
      });
      activeRuns.set(user, dm);

      if (verifyFiles) {
        await dm.indexFilesOnDisk();
      }

      if (wantedExtras.length > 0) {
        await dm.indexExtrasOnDisk();
      }

      // Mark the sync as in progress until it reaches the end of the library
      db.setMeta('sync_complete', '0');
      db.setMeta('resume_page', startPage);

      // Extras filled in for every song visited by this walk through the library,
      // carried over when an interrupted walk is resumed
      const carriedExtras = (db.getMeta('walk_extras') || '').split(',');
      const walkExtras = startPage === 0 ? wantedExtras : wantedExtras.filter(folder => carriedExtras.includes(folder));
      db.setMeta('walk_extras', walkExtras.join(','));

      // Retry anything that failed in earlier runs
      await dm.retryFailed(db.getFailed());

      // Fetch the library page by page, downloading as we go.
      // Database writes happen incrementally during downloads.
      const result = await dm.syncLibrary({
        startPage,
        onPage: nextPage => db.setMeta('resume_page', nextPage)
      });

      if (result.reachedEnd) {
        db.setMeta('sync_complete', '1');
        db.setMeta('resume_page', null);
        // Only a walk through the whole library has filled in extras for every song
        if (shouldFullSync) {
          db.setMeta('extras_complete', [...new Set([...extrasDone, ...walkExtras])].join(','));
        }
        db.setMeta('walk_extras', null);
      }

      // Spreadsheet of the whole library, for Excel or another app
      try {
        await writeLibraryCsv(db, baseDir);
      } catch (err) {
        await logger.warn(`Could not write library.csv: ${err.message}`);
      }

      const totalCount = db.count();
      const failedCount = db.failedCount();
      await logger.info(`Library updated: ${totalCount} total items, ${failedCount} still failing`);
      if (!result.reachedEnd) {
        await logger.warn('Did not reach the end of the library; the next run will resume where this one stopped');
      }

      // Complete job
      const stats = dm.getProgress();
      await logger.complete(stats);
      jobManager.update(user, { complete: result.reachedEnd, stillFailing: failedCount, libraryTotal: totalCount });
      jobManager.complete(user, stats);

      db.close();

      return {
        user,
        downloaded: stats.downloaded,
        failed: stats.failed,
        skipped: stats.skipped,
        extrasSaved: stats.extrasSaved,
        extrasFailed: stats.extrasFailed,
        total: totalCount,
        listed: result.listed,
        stillFailing: failedCount,
        complete: result.reachedEnd,
        errors: dm.getErrors()
      };
    } catch (err) {
      await logger.error(`Archive failed: ${err.message}`);
      jobManager.fail(user, err.message);
      return reply.code(500).send({ error: err.message });
    } finally {
      activeRuns.delete(user);
    }
  });

  // Hand a fresh token to a run that is waiting for one
  fastify.post('/token/:username', async (req, reply) => {
    const user = sanitizeName(req.params.username);
    const { cookie } = req.body || {};
    if (!cookie) return reply.code(400).send({ error: 'Missing token' });

    const dm = activeRuns.get(user);
    if (!dm) return reply.code(404).send({ error: 'No archive run in progress for this user' });

    const token = cleanToken(cookie);
    dm.supplyToken(token);
    jobManager.update(user, { tokenExpiresAt: tokenExpiry(token) });
    return { ok: true };
  });

  // Return current user library metadata
  fastify.get('/library/:username', async (req, reply) => {
    const user = sanitizeName(req.params.username);
    try {
      const db = new LibraryDB(dataDir, user);
      const clips = db.getAll();
      db.close();
      return clips;
    } catch {
      return reply.code(404).send({ error: 'No library found' });
    }
  });

  // Get job status
  fastify.get('/status/:username', async (req, reply) => {
    const user = sanitizeName(req.params.username);
    const job = jobManager.get(user);

    if (!job) {
      return reply.code(404).send({ error: 'No job found for this user' });
    }

    return job;
  });

  // Check if user database exists and has data
  fastify.get('/db-status/:username', async (req, reply) => {
    const user = sanitizeName(req.params.username);
    try {
      const db = new LibraryDB(dataDir, user);
      const count = db.count();
      const status = {
        exists: true,
        count,
        isEmpty: count === 0,
        syncComplete: db.getMeta('sync_complete') === '1',
        resumePage: parseInt(db.getMeta('resume_page')) || null,
        failedCount: db.failedCount()
      };
      db.close();
      return status;
    } catch {
      return { exists: false, count: 0, isEmpty: true };
    }
  });

  // Export user archive as ZIP
  fastify.get('/export/:username', async (req, reply) => {
    const user = sanitizeName(req.params.username);
    const userDir = path.join(dataDir, user);

    if (activeRuns.has(user))
      return reply.code(409).send({ error: 'Wait for the archive run to finish before exporting' });

    try {
      await fs.access(userDir);
    } catch {
      return reply.code(404).send({ error: 'User archive not found' });
    }

    // Audio and video are already compressed, so store files as-is for speed
    const archive = archiver('zip', { store: true });

    archive.on('error', (err) => {
      fastify.log.error(`Archive error for ${user}: ${err.message}`);
      reply.code(500).send({ error: 'Failed to create archive' });
    });

    // Skip half-written files from an interrupted run
    archive.glob('**/*', { cwd: userDir, ignore: ['**/*.part'] });
    archive.finalize();

    // Hand Fastify a core Node stream; it sends archiver's own stream as an empty body
    const body = new PassThrough();
    archive.pipe(body);

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${user}-archive.zip"`);
    return reply.send(body);
  });
}