// In-memory job tracking for status endpoint
export class JobManager {
  constructor() {
    this.jobs = new Map();
  }

  create(username) {
    const job = {
      username,
      status: 'running',
      progress: {
        total: 0,
        downloaded: 0,
        failed: 0,
        skipped: 0
      },
      startTime: Date.now(),
      endTime: null,
      errors: []
    };

    this.jobs.set(username, job);
    return job;
  }

  update(username, updates) {
    const job = this.jobs.get(username);
    if (job) {
      Object.assign(job, updates);
    }
  }

  updateProgress(username, progress) {
    const job = this.jobs.get(username);
    if (job) {
      job.progress = { ...progress };
    }
  }

  complete(username, stats) {
    const job = this.jobs.get(username);
    if (job) {
      job.status = 'completed';
      job.endTime = Date.now();
      job.progress = stats;
    }
  }

  fail(username, error) {
    const job = this.jobs.get(username);
    if (job) {
      job.status = 'failed';
      job.endTime = Date.now();
      job.error = error;
    }
  }

  get(username) {
    return this.jobs.get(username);
  }

  getAll() {
    return Array.from(this.jobs.values());
  }
}

export const jobManager = new JobManager();
