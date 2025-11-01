import fs from 'fs/promises';
import path from 'path';

export async function ensureUserDirs(baseDir, user) {
  const base = path.join(baseDir, user);
  const dlDir = path.join(base, 'downloads');
  const libPath = path.join(base, 'library.json');
  await fs.mkdir(dlDir, { recursive: true });
  return { baseDir: base, dlDir, libPath };
}

export function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '');
}