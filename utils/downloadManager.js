import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';

export class DownloadManager {
  constructor({ dataDir, username, cookie, logger, concurrency = 3, maxRetries = 3, rateLimitMs = 1000 }) {
    this.dataDir = dataDir;
    this.username = username;
    this.cookie = cookie;
    this.logger = logger;
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;
    this.rateLimitMs = rateLimitMs; // Delay between downloads to respect rate limits

    this.progress = {
      total: 0,
      downloaded: 0,
      failed: 0,
      skipped: 0,
      status: 'idle'
    };

    this.errors = [];
  }

  async fetchLibrary() {
    this.logger.info(`[${this.username}] Fetching library from Suno...`);

    const res = await this.retryFetch('https://suno.com/api/library?limit=9999', {
      headers: { Cookie: this.cookie },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch library: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    this.logger.info(`[${this.username}] Found ${data.items?.length || 0} total items`);
    return data;
  }

  async retryFetch(url, options, attempt = 1) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (err) {
      if (attempt < this.maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        this.logger.warn(`[${this.username}] Retry ${attempt}/${this.maxRetries} after ${delay}ms: ${err.message}`);
        await this.sleep(delay);
        return this.retryFetch(url, options, attempt + 1);
      }
      throw err;
    }
  }

  async downloadItem(item, dlDir) {
    if (!item.audio_url) {
      this.logger.warn(`[${this.username}] No audio URL for item ${item.id}, skipping`);
      this.progress.skipped++;
      return false;
    }

    const fileName = `${item.id}.mp3`;
    const outPath = path.join(dlDir, fileName);

    try {
      // Rate limiting: wait before each download
      if (this.rateLimitMs > 0) {
        await this.sleep(this.rateLimitMs);
      }

      const audio = await this.retryFetch(item.audio_url, {
        headers: { Cookie: this.cookie }
      });

      if (!audio.ok) {
        throw new Error(`HTTP ${audio.status}`);
      }

      const buf = Buffer.from(await audio.arrayBuffer());
      await fs.writeFile(outPath, buf);

      this.progress.downloaded++;
      this.logger.info(`[${this.username}] ✓ ${fileName} (${this.progress.downloaded}/${this.progress.total})`);
      return true;
    } catch (err) {
      this.progress.failed++;
      this.errors.push({ id: item.id, error: err.message });
      this.logger.error(`[${this.username}] ✗ ${fileName}: ${err.message}`);
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
        await this.downloadItem(item, dlDir);
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
