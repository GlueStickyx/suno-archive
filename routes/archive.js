import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';
import { ensureUserDirs, sanitizeName } from '../utils/fileHelpers.js';

export default async function archiveRoutes(fastify, opts) {
  const { dataDir } = opts;

  fastify.post('/run', async (req, reply) => {
    const { username, cookie } = req.body;
    if (!cookie || !username)
      return reply.code(400).send({ error: 'Missing username or cookie' });

    const user = sanitizeName(username);
    const { baseDir, libPath, dlDir } = await ensureUserDirs(dataDir, user);

    // Load existing library JSON
    let oldLib = [];
    try {
      oldLib = JSON.parse(await fs.readFile(libPath, 'utf8'));
    } catch {}

    const oldIds = new Set(oldLib.map(i => i.id));

    // Fetch latest library from Suno
    const res = await fetch('https://suno.com/api/library?limit=9999', {
      headers: { Cookie: cookie },
    });
    if (!res.ok) return reply.code(res.status).send({ error: 'Failed to fetch library' });
    const lib = await res.json();

    const newItems = lib.items.filter(i => !oldIds.has(i.id));
    let downloaded = 0;

    for (const item of newItems) {
      if (!item.audio_url) continue;
      const fileName = `${item.id}.mp3`;
      const outPath = path.join(dlDir, fileName);

      const audio = await fetch(item.audio_url, { headers: { Cookie: cookie } });
      if (!audio.ok) continue;

      const buf = Buffer.from(await audio.arrayBuffer());
      await fs.writeFile(outPath, buf);
      downloaded++;
      fastify.log.info(`[${user}] downloaded ${fileName}`);
    }

    const merged = [...oldLib, ...newItems];
    await fs.writeFile(libPath, JSON.stringify(merged, null, 2));

    return { user, downloaded, total: merged.length };
  });

  // Return current user library metadata
  fastify.get('/library/:username', async (req, reply) => {
    const user = sanitizeName(req.params.username);
    const libPath = path.join(dataDir, user, 'library.json');
    try {
      const json = await fs.readFile(libPath, 'utf8');
      return JSON.parse(json);
    } catch {
      return { error: 'No library found' };
    }
  });
}