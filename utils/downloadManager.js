import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';

export class DownloadManager {
  constructor({ dataDir, username, cookie, logger, concurrency = 3, maxRetries = 3, rateLimitMs = 1000, limit = null, format = 'mp3', existingIds = new Set(), db = null, fullSync = false, verifyFiles = false, dlDir = null, onProgress = null, tokenWaitMs = 30 * 60 * 1000, extras = {}, userDir = null }) {
    this.dataDir = dataDir;
    this.username = username;
    this.cookie = cookie;
    this.logger = logger;
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;
    this.rateLimitMs = rateLimitMs; // Delay between downloads to respect rate limits
    this.limit = limit; // Optional limit for testing
    this.format = format; // 'mp3', 'wav', or 'both'
    this.existingIds = existingIds; // Set of existing IDs for smart pagination
    this.db = db; // Database instance for incremental writes
    this.fullSync = fullSync; // If true, disable smart pagination and fetch all pages
    this.verifyFiles = verifyFiles; // If true, check filesystem for existing files
    this.dlDir = dlDir; // Download directory for filesystem checks
    this.filesOnDisk = null; // Map of clip id -> formats on disk, built when verifyFiles is on
    this.attempted = 0; // Clips queued for download this run, for the limit
    this.onProgress = onProgress; // Called with getProgress() whenever something changes
    this.tokenWaitMs = tokenWaitMs; // How long to wait for a fresh token before giving up
    this.newToken = null; // Set by supplyToken() while waiting
    this.extras = extras; // Which extras to save: { art, video, lyrics, metadata, sources }
    this.userDir = userDir; // Parent folder of downloads/, where the extras folders live
    this.extrasOnDisk = null; // Map of folder -> Set of clip ids, built by indexExtrasOnDisk()

    this.progress = {
      total: 0,
      downloaded: 0,
      failed: 0,
      skipped: 0,
      status: 'idle',
      phase: 'starting', // starting, retrying_failed, listing, waiting_for_token, done
      page: 0,
      startPage: 0,
      listed: 0,
      currentTrack: null,
      extrasSaved: 0,
      extrasFailed: 0
    };

    this.errors = [];
  }

  /**
   * Walk the library page by page, downloading each page's new clips before
   * fetching the next one, so progress is saved even if the token expires
   * partway through a large library.
   *
   * onPage(nextPage) is called after each page is fully processed, so the
   * caller can persist where to resume from.
   *
   * Returns { reachedEnd, listed, lastPage }. reachedEnd is true only when
   * Suno ran out of pages or smart pagination legitimately stopped early.
   */
  async syncLibrary({ startPage = 0, onPage = null } = {}) {
    this.logger.info(`[${this.username}] Fetching library from Suno starting at page ${startPage}...`);

    let page = startPage;
    let listed = 0;
    this.progress.startPage = startPage;
    this.setPhase('listing');
    let consecutiveExistingPages = 0;
    const EARLY_STOP_THRESHOLD = 2; // Stop after 2 consecutive pages of all-existing content

    while (true) {
      // Stop once the download limit (testing) has been reached
      if (this.limit && this.attempted >= this.limit) {
        this.logger.info(`[${this.username}] Download limit of ${this.limit} reached`);
        return { reachedEnd: false, listed, lastPage: page };
      }

      // Rate limit between page requests (after first page)
      if (page > startPage) {
        await this.sleep(2000); // 2 seconds between page requests to avoid rate limits
      }

      this.progress.page = page;
      this.report();

      const url = `https://studio-api.prod.suno.com/api/feed/v2?hide_disliked=false&hide_gen_stems=true&hide_studio_clips=true&page=${page}`;

      const res = await this.retryFetch(url, {
        headers: {
          'Authorization': `Bearer ${this.cookie}`,
          'Content-Type': 'application/json'
        },
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status === 401 || res.status === 403) {
          // Pause and let the user paste a fresh token instead of ending the run
          if (await this.waitForToken(page)) continue;
          throw new Error(`Suno rejected the token on page ${page} (HTTP ${res.status}). Tokens expire - paste a fresh one and run again. Progress is saved and the next run resumes near page ${page}.`);
        }
        throw new Error(`Failed to fetch library (page ${page}): ${res.status} ${res.statusText}\n${text}`);
      }

      const data = await res.json();
      const clips = data.clips || data.songs || data.data || data.items || [];

      if (page === startPage) {
        const reportedTotal = data.num_total_results ?? data.total ?? data.total_count;
        if (reportedTotal !== undefined) {
          this.logger.info(`[${this.username}] Suno reports ${reportedTotal} clips in this library`);
        }
        if (clips.length > 0) {
          this.logger.info(`[${this.username}] Sample clip fields: ${Object.keys(clips[0]).join(', ')}`);
        }
      }

      if (clips.length === 0) {
        this.logger.info(`[${this.username}] Reached end of library at page ${page} (${listed} clips listed this run)`);
        this.setPhase('done');
        return { reachedEnd: true, listed, lastPage: page };
      }

      listed += clips.length;
      this.progress.listed = listed;
      this.report();

      // With verifyFiles, already-archived clips are checked on disk too.
      // Already-archived clips are also revisited when they are missing extras.
      const newClips = clips.filter(c => !this.existingIds.has(c.id));
      let toProcess = this.verifyFiles
        ? clips
        : clips.filter(c => !this.existingIds.has(c.id) || this.needsExtras(c));
      if (this.limit) {
        toProcess = toProcess.slice(0, Math.max(0, this.limit - this.attempted));
      }

      this.logger.info(`[${this.username}] Page ${page}: ${clips.length} items, ${newClips.length} new (listed so far: ${listed})`);

      if (toProcess.length > 0) {
        this.progress.total += toProcess.length;
        this.attempted += toProcess.length;
        await this.downloadBatch(toProcess, this.dlDir);
      }

      page++;
      if (onPage) onPage(page);

      // Smart pagination: stop after consecutive pages of already-archived content.
      // Only safe when the previous run reached the end of the library.
      if (!this.fullSync) {
        if (newClips.length === 0) {
          consecutiveExistingPages++;
          if (consecutiveExistingPages >= EARLY_STOP_THRESHOLD) {
            this.logger.info(`[${this.username}] Early stop: ${EARLY_STOP_THRESHOLD} consecutive pages of existing content`);
            this.setPhase('done');
            return { reachedEnd: true, listed, lastPage: page };
          }
        } else {
          consecutiveExistingPages = 0;
        }
      }
    }
  }

  // Retry clips that failed in earlier runs
  async retryFailed(clips) {
    const pending = clips.filter(c => !this.existingIds.has(c.id));
    if (pending.length === 0) return;

    this.logger.info(`[${this.username}] Retrying ${pending.length} clips that failed in earlier runs`);
    this.setPhase('retrying_failed');
    this.progress.total += pending.length;
    await this.downloadBatch(pending, this.dlDir);
  }

  // Index files already on disk by clip id, so verifyFiles still matches
  // when a song's title has changed since it was downloaded
  async indexFilesOnDisk() {
    this.filesOnDisk = new Map();
    const names = await fs.readdir(this.dlDir);
    for (const name of names) {
      const match = name.match(/ - ([^ ]+)\.(mp3|wav)$/);
      if (!match) continue;
      const [, id, fmt] = match;
      if (!this.filesOnDisk.has(id)) this.filesOnDisk.set(id, new Set());
      this.filesOnDisk.get(id).add(fmt);
    }
    this.logger.info(`[${this.username}] Found files for ${this.filesOnDisk.size} clips on disk`);
  }

  // Wait for supplyToken() to be called. Returns true if a new token arrived.
  async waitForToken(page) {
    this.logger.warn(`[${this.username}] Token rejected on page ${page}, waiting up to ${Math.round(this.tokenWaitMs / 60000)} min for a fresh token`);
    this.newToken = null;
    this.setPhase('waiting_for_token');

    const deadline = Date.now() + this.tokenWaitMs;
    while (!this.newToken && Date.now() < deadline) {
      await this.sleep(1000);
    }

    if (!this.newToken) return false;

    this.cookie = this.newToken;
    this.newToken = null;
    this.logger.info(`[${this.username}] Received a fresh token, continuing from page ${page}`);
    this.setPhase('listing');
    return true;
  }

  supplyToken(token) {
    this.newToken = token;
  }

  setPhase(phase) {
    this.progress.phase = phase;
    this.report();
  }

  report() {
    if (this.onProgress) this.onProgress(this.getProgress());
  }

  hasExtras() {
    return Object.values(this.extras).some(Boolean);
  }

  // Index the extras folders by clip id, so clips that already have them are skipped
  async indexExtrasOnDisk() {
    this.extrasOnDisk = new Map();
    for (const folder of EXTRA_FOLDERS) {
      const ids = new Set();
      const dir = path.join(this.userDir, folder);
      await fs.mkdir(dir, { recursive: true });
      for (const name of await fs.readdir(dir)) {
        const match = folder === 'sources' ? name.match(/^(.+)\.json$/) : name.match(/ - ([^ ]+)\.\w+$/);
        if (match) ids.add(match[1]);
      }
      this.extrasOnDisk.set(folder, ids);
    }
  }

  extraDone(folder, id) {
    return this.extrasOnDisk?.get(folder)?.has(id) ?? false;
  }

  // Which extras this clip still needs, as a list of folder names
  missingExtras(item) {
    const missing = [];
    if (this.extras.art && artUrl(item) && !this.extraDone('art', item.id)) missing.push('art');
    if (this.extras.video && item.video_url && !this.extraDone('video', item.id)) missing.push('video');
    if (this.extras.lyrics && !this.extraDone('lyrics', item.id)) missing.push('lyrics');
    if (this.extras.metadata && !this.extraDone('metadata', item.id)) missing.push('metadata');
    if (this.extras.sources && this.missingSources(item).length > 0) missing.push('sources');
    return missing;
  }

  needsExtras(item) {
    return this.hasExtras() && this.missingExtras(item).length > 0;
  }

  // Songs this clip was remixed, covered or extended from that aren't in the library
  missingSources(item) {
    return sourceIds(item).filter(id => !this.existingIds.has(id) && !this.extraDone('sources', id));
  }

  async saveExtras(item) {
    const fileBase = safeFileBase(item);

    for (const folder of this.missingExtras(item)) {
      try {
        if (folder === 'art') {
          const url = artUrl(item);
          await this.downloadTo(url, path.join(this.userDir, 'art', `${fileBase}.${urlExtension(url, 'jpg')}`));
        } else if (folder === 'video') {
          await this.downloadTo(item.video_url, path.join(this.userDir, 'video', `${fileBase}.${urlExtension(item.video_url, 'mp4')}`));
        } else if (folder === 'lyrics') {
          await writeFileSafely(path.join(this.userDir, 'lyrics', `${fileBase}.txt`), lyricsText(item));
        } else if (folder === 'metadata') {
          await writeFileSafely(path.join(this.userDir, 'metadata', `${fileBase}.json`), JSON.stringify(item, null, 2));
        } else if (folder === 'sources') {
          await this.saveSources(item);
        }

        if (folder !== 'sources') this.extrasOnDisk.get(folder).add(item.id);
        this.progress.extrasSaved++;
      } catch (err) {
        this.progress.extrasFailed++;
        this.logger.warn(`[${this.username}] Could not save ${folder} for ${fileBase}: ${err.message}`);
      }
    }
  }

  // Save details of the songs a clip was made from, which may belong to other users
  // and can't be looked up once the account is gone
  async saveSources(item) {
    for (const id of this.missingSources(item)) {
      if (this.rateLimitMs > 0) await this.sleep(this.rateLimitMs);

      const res = await this.retryFetch(`https://studio-api.prod.suno.com/api/clip/${id}`, {
        headers: { 'Authorization': `Bearer ${this.cookie}` }
      });

      let data;
      if (res.ok) {
        data = await res.json();
      } else if (res.status === 404) {
        data = { id, unavailable: true, note: 'Suno returned 404 for this source song' };
      } else {
        throw new Error(`source ${id}: HTTP ${res.status}`);
      }

      await writeFileSafely(path.join(this.userDir, 'sources', `${id}.json`), JSON.stringify(data, null, 2));
      this.extrasOnDisk.get('sources').add(id);
    }
  }

  async downloadTo(url, outPath) {
    const res = await this.retryFetch(url, {});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFileSafely(outPath, Buffer.from(await res.arrayBuffer()));
  }

  async retryFetch(url, options, attempt = 1) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      if (attempt < this.maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        this.logger.warn(`[${this.username}] Retry ${attempt}/${this.maxRetries} after ${delay}ms: ${err.message}`);
        await this.sleep(delay);
        return this.retryFetch(url, options, attempt + 1);
      }
      throw err;
    }

    // Rate limited or server error: back off and retry instead of giving up
    if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
      const retryAfter = parseInt(response.headers.get('retry-after'));
      const delay = retryAfter > 0
        ? Math.min(retryAfter * 1000, 120000)
        : Math.min(5000 * Math.pow(2, attempt), 60000);
      this.logger.warn(`[${this.username}] HTTP ${response.status}, retry ${attempt}/${this.maxRetries} after ${delay}ms`);
      await this.sleep(delay);
      return this.retryFetch(url, options, attempt + 1);
    }

    return response;
  }

  async downloadItem(item, dlDir) {
    if (!item.audio_url) {
      this.logger.warn(`[${this.username}] No audio URL for item ${item.id}, skipping`);
      this.progress.skipped++;
      this.errors.push({ id: item.id, error: 'No audio URL' });
      return false;
    }

    // Create safe filename base: "title - id"
    const fileBase = safeFileBase(item);
    this.progress.currentTrack = item.title || item.id;

    // Determine which formats to download
    const formats = this.format === 'both' ? ['mp3', 'wav'] : [this.format];

    // If verifyFiles is enabled, check if all required files exist
    if (this.verifyFiles && this.filesOnDisk) {
      const onDisk = this.filesOnDisk.get(item.id);
      const allFilesExist = formats.every(fmt => onDisk && onDisk.has(fmt));

      if (allFilesExist) {
        this.progress.skipped++;
        return true; // File exists, consider it a success
      }
    }

    let successCount = 0;
    const formatErrors = [];

    for (const fmt of formats) {
      try {
        // Rate limiting: wait before each download
        if (this.rateLimitMs > 0) {
          await this.sleep(this.rateLimitMs);
        }

        const fileName = `${fileBase}.${fmt}`;
        const outPath = path.join(dlDir, fileName);

        // Construct URL for the format (wav URLs typically end with .wav, mp3 with .mp3)
        const audioUrl = item.audio_url.replace(/\.(mp3|wav)$/, `.${fmt}`);

        const audio = await this.retryFetch(audioUrl, {
          headers: {
            'Authorization': `Bearer ${this.cookie}`
          }
        });

        if (!audio.ok) {
          // Handle format-specific errors (e.g., WAV restricted by plan)
          if (audio.status >= 400 && audio.status < 500 && audio.status !== 429) {
            formatErrors.push(`${fmt.toUpperCase()} not available (HTTP ${audio.status})`);
            this.logger.warn(`[${this.username}] ${fmt.toUpperCase()} format not available for ${item.id} (plan restriction?)`);
            continue; // Try next format without failing
          }
          throw new Error(`HTTP ${audio.status} for ${fmt}`);
        }

        const buf = Buffer.from(await audio.arrayBuffer());
        await writeFileSafely(outPath, buf);

        this.logger.info(`[${this.username}] ✓ ${fileName} (${this.progress.downloaded}/${this.progress.total})`);
        successCount++;
      } catch (err) {
        formatErrors.push(`${fmt}: ${err.message}`);
        this.logger.error(`[${this.username}] Failed to download ${fmt} for ${fileBase}: ${err.message}`);
      }
    }

    // Consider it successful if at least one format downloaded
    if (successCount > 0) {
      this.progress.downloaded++;
      if (formatErrors.length > 0) {
        // Log partial success
        this.logger.warn(`[${this.username}] Partial success for ${item.id}: ${formatErrors.join(', ')}`);
      }
      return true;
    } else {
      // All formats failed
      this.progress.failed++;
      this.errors.push({ id: item.id, error: formatErrors.join('; ') });
      this.logger.error(`[${this.username}] ✗ ${fileBase}: All formats failed - ${formatErrors.join('; ')}`);
      return false;
    }
  }

  async downloadBatch(items, dlDir) {
    const queue = [...items];
    const workers = [];

    for (let i = 0; i < this.concurrency; i++) {
      workers.push(this.worker(queue, dlDir));
    }

    await Promise.all(workers);
  }

  async worker(queue, dlDir) {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) {
        // Clips already archived are only here to fill in missing extras
        let success = true;
        if (!this.existingIds.has(item.id) || this.verifyFiles) {
          success = await this.downloadItem(item, dlDir);
        } else {
          this.progress.currentTrack = item.title || item.id;
          this.progress.skipped++;
        }

        if (success && this.hasExtras()) {
          await this.saveExtras(item);
        }
        this.report();

        // Write to database immediately after each download attempt
        if (this.db) {
          try {
            if (success) {
              this.db.insert(item);
              this.db.removeFailed(item.id);
              this.existingIds.add(item.id); // Update in-memory set for smart pagination
            } else {
              // Remember failures so later runs retry them even if smart pagination stops early
              const error = this.errors.find(e => e.id === item.id)?.error || 'unknown error';
              this.db.addFailed(item, error);
            }
          } catch (err) {
            this.logger.error(`[${this.username}] Failed to write ${item.id} to database: ${err.message}`);
          }
        }
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getProgress() {
    return { ...this.progress };
  }

  getErrors() {
    return [...this.errors];
  }
}

export const EXTRA_FOLDERS = ['art', 'video', 'lyrics', 'metadata', 'sources'];

// "title - id", the shared name for a clip's files in every folder
export function safeFileBase(item) {
  const safeTitle = (item.title || 'untitled')
    .replace(/[/\\?%*:|"<>]/g, '-') // Replace invalid chars
    .replace(/\s+/g, ' ')            // Normalize whitespace
    .trim()
    .slice(0, 100);                   // Limit length
  return `${safeTitle} - ${item.id}`;
}

function artUrl(item) {
  return item.image_large_url || item.image_url || null;
}

function urlExtension(url, fallback) {
  const match = new URL(url).pathname.match(/\.(\w{2,4})$/);
  return match ? match[1].toLowerCase() : fallback;
}

// Ids of songs this clip was remixed, covered, extended or edited from
export function sourceIds(item) {
  const meta = item.metadata || {};
  const ids = new Set();
  for (const [key, value] of Object.entries(meta)) {
    if (key.endsWith('_clip_id') && typeof value === 'string' && value) ids.add(value);
  }
  for (const list of [meta.history, meta.concat_history]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry && typeof entry.id === 'string') ids.add(entry.id);
    }
  }
  ids.delete(item.id);
  return [...ids];
}

function lyricsText(item) {
  const meta = item.metadata || {};
  const lines = [
    `Title: ${item.title || 'untitled'}`,
    `Date: ${item.created_at || ''}`,
    `Style: ${meta.tags || ''}`
  ];
  if (meta.negative_tags) lines.push(`Excluded styles: ${meta.negative_tags}`);
  if (meta.gpt_description_prompt) lines.push(`Description: ${meta.gpt_description_prompt}`);
  lines.push('', meta.prompt ? meta.prompt : '(no lyrics)');
  return lines.join('\n') + '\n';
}

// Write to a temporary file first, so an interrupted run never leaves a
// half-written file that later looks complete
async function writeFileSafely(outPath, data) {
  const tmpPath = `${outPath}.part`;
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, outPath);
}
