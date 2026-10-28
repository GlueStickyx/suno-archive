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

// Accept tokens pasted with or without the "Bearer " prefix
export function cleanToken(token) {
  return token.trim().replace(/^bearer\s+/i, '');
}

// Read the expiry time from a JWT without verifying it. Returns ms since epoch, or null.
export function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
