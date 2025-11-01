import fs from 'fs/promises';
import path from 'path';

export class Logger {
  constructor({ dataDir, username, fastifyLogger }) {
    this.dataDir = dataDir;
    this.username = username;
    this.fastifyLogger = fastifyLogger;
    this.logPath = null;
  }

  async init() {
    const logsDir = path.join(this.dataDir, this.username, 'logs');
    await fs.mkdir(logsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.logPath = path.join(logsDir, `run-${timestamp}.log`);

    await this.write(`=== Archive Run Started: ${new Date().toISOString()} ===\n`);
  }

  async write(message) {
    if (this.logPath) {
      try {
        await fs.appendFile(this.logPath, message + '\n');
      } catch (err) {
        this.fastifyLogger?.error(`Failed to write log: ${err.message}`);
      }
    }
  }

  timestamp() {
    return new Date().toISOString();
  }

  async info(message) {
    const log = `[${this.timestamp()}] INFO: ${message}`;
    this.fastifyLogger?.info(message);
    await this.write(log);
  }

  async warn(message) {
    const log = `[${this.timestamp()}] WARN: ${message}`;
    this.fastifyLogger?.warn(message);
    await this.write(log);
  }

  async error(message) {
    const log = `[${this.timestamp()}] ERROR: ${message}`;
    this.fastifyLogger?.error(message);
    await this.write(log);
  }

  async complete(stats) {
    await this.write(`\n=== Archive Run Completed: ${new Date().toISOString()} ===`);
    await this.write(`Total: ${stats.total}`);
    await this.write(`Downloaded: ${stats.downloaded}`);
    await this.write(`Failed: ${stats.failed}`);
    await this.write(`Skipped: ${stats.skipped}`);
  }
}
