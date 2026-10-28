import fs from 'fs/promises';
import path from 'path';
import { safeFileBase, sourceIds } from './downloadManager.js';

const COLUMNS = [
  ['id', c => c.id],
  ['title', c => c.title],
  ['created_at', c => c.created_at],
  ['style', c => c.metadata?.tags],
  ['excluded_styles', c => c.metadata?.negative_tags],
  ['description', c => c.metadata?.gpt_description_prompt],
  ['lyrics', c => c.metadata?.prompt],
  ['duration_seconds', c => c.metadata?.duration],
  ['type', c => c.metadata?.type],
  ['model', c => c.model_name || c.major_model_version],
  ['made_from', c => sourceIds(c).join(' ')],
  ['liked', c => c.is_liked],
  ['play_count', c => c.play_count],
  ['upvotes', c => c.upvote_count],
  ['public', c => c.is_public],
  ['file_name', c => safeFileBase(c)]
];

function cell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Write library.csv next to the downloads folder, newest songs first
export async function writeLibraryCsv(db, userDir) {
  const rows = [COLUMNS.map(([name]) => name).join(',')];
  for (const clip of db.getAll()) {
    rows.push(COLUMNS.map(([, get]) => cell(get(clip))).join(','));
  }
  // The BOM makes Excel read the file as UTF-8
  const outPath = path.join(userDir, 'library.csv');
  await fs.writeFile(`${outPath}.part`, '﻿' + rows.join('\r\n') + '\r\n');
  await fs.rename(`${outPath}.part`, outPath);
}
