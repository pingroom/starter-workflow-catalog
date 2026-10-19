import { constants } from 'node:fs';
import { mkdir, chmod, open, rename, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CatalogError } from './model.js';

export function parseJson(source) {
  let parsed;
  try { parsed = JSON.parse(source); } catch { throw new CatalogError('invalid_json', 'Input is not valid JSON.'); }
  // JSON.parse accepts duplicate keys; an catalog configuration must not hide earlier values.
  const stack = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '{') stack.push(new Set());
    else if (source[i] === '[') stack.push(null);
    else if (source[i] === '}' || source[i] === ']') stack.pop();
    else if (source[i] === '"') {
      const start = i++;
      while (i < source.length && source[i] !== '"') { if (source[i] === '\\') i++; i++; }
      let next = i + 1;
      while (/\s/.test(source[next] ?? '') && next < source.length) next++;
      if (source[next] === ':') {
        const key = JSON.parse(source.slice(start, i + 1));
        const keys = stack.at(-1);
        if (keys.has(key)) throw new CatalogError('invalid_json', 'Duplicate JSON object keys are not accepted.');
        keys.add(key);
      }
    }
    if (stack.length > 20) throw new CatalogError('invalid_json', 'JSON nesting exceeds 20 levels.');
  }
  return parsed;
}

export async function readJson(path, limit) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new CatalogError('invalid_file', 'Input must be a regular file.');
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new CatalogError('input_limit', 'Input exceeds its byte limit.');
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)); }
    catch { throw new CatalogError('invalid_json', 'Input must contain valid UTF-8.'); }
    return parseJson(source);
  } finally { await file.close(); }
}

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new CatalogError('invalid_directory', 'Private output directory must be a real directory.');
  await chmod(directory, 0o700);
}

export async function atomicJson(directory, name, value) {
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync(); await file.close(); file = undefined;
    await rename(temporary, join(directory, name));
    // Flush the directory entry on platforms that permit it.
    let parent;
    try { parent = await open(directory, 'r'); await parent.sync(); }
    catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF', 'EPERM'].includes(error.code)) throw error; }
    finally { await parent?.close(); }
  } finally { await file?.close(); await rm(temporary, { force: true }); }
}

export async function withLock(directory, work) {
  await privateDirectory(directory);
  const lock = join(directory, 'run.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new CatalogError('locked', 'Another command owns the catalog lock. Verify it stopped before removing the lock.');
    throw error;
  }
  try {
    await atomicJson(lock, 'owner.json', { pid: process.pid, startedAt: new Date().toISOString() });
    return await work();
  } finally { await rm(lock, { recursive: true }); }
}
