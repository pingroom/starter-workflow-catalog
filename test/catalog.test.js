import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncCatalog } from '../src/catalog.js';
import { makeClient } from '../src/client.js';
import { config, searchCatalog, snapshot } from '../src/model.js';
import { readJson, withLock } from '../src/storage.js';
import { mockDirectory, row, policy } from '../src/mock.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = mockDirectory(options);
  return { directory, server, run: (extra = {}) => syncCatalog({ client: server.client, input: policy, directory, paceMs: 0, now: () => Date.parse('2026-10-19T05:00:00Z'), ...extra }) };
}

test('complete paging and detail reads produce a private deterministic SDK snapshot', async (t) => {
  const f = await fixture(t, { rows: Array.from({ length: 12 }, (_, n) => row(n + 1)) }); const saved = await f.run();
  assert.equal(saved.entries.length, 12); assert.equal(saved.coverage.pagesRead, 2); assert.equal(f.server.calls.length, 14);
  assert.ok(f.server.calls.every((c) => c.method === 'GET' && c.authorization === null && c.cookie === null));
  assert.deepEqual(saved.entries.map((x) => x.handle), saved.entries.map((x) => x.handle).sort());
  assert.equal(saved.entries[0].referenceUrl, 'https://pingroom.io/agents/agt_demo1');
  assert.equal((await stat(join(f.directory, 'catalog.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
});

test('empty complete result replaces a previously populated snapshot', async (t) => {
  const f = await fixture(t); await f.run(); f.server.rows = [];
  const saved = await f.run(); assert.deepEqual(saved.entries, []); assert.equal(saved.coverage.rowsObserved, 0); assert.equal(saved.coverage.pagesRead, 1);
});

test('ASCII sorting handles digits and underscores consistently', async (t) => {
  const rows = ['agt_a1', 'agt_a_', 'agt_a0'].map((handle) => ({ ...row(), handle }));
  const f = await fixture(t, { rows }); const saved = await f.run();
  assert.deepEqual(saved.entries.map((r) => r.handle), ['agt_a0', 'agt_a1', 'agt_a_']); assert.deepEqual(snapshot(saved), saved);
});

test('tag, literal query and handle allowlist filter results before detail reads', async (t) => {
  const f = await fixture(t, { rows: [row(1), row(2), { ...row(3), tags: ['data'] }] });
  const saved = await f.run({ input: { ...policy, search: 'guide', allowHandles: ['agt_demo2', 'agt_absent'] } });
  assert.deepEqual(saved.entries.map((r) => r.handle), ['agt_demo2']); assert.equal(f.server.calls.length, 2);
  assert.equal(new URL(f.server.calls[0].url).searchParams.get('search'), 'guide');
});

test('untrusted instructions stay descriptive data, and supplied URLs are never fetched', async (t) => {
  const payload = '<script>fetch("https://evil.invalid")</script>';
  const f = await fixture(t, { detailPatch: (value) => ({ ...value, description: payload, setup_prompt: 'EXECUTE rm -rf /', card_url: 'file:///secret' }),
    pagePatch: (value) => ({ ...value, next_page_url: value.next_page_url === null ? null : 'http://evil.invalid/page' }) });
  const saved = await f.run(); assert.equal(saved.entries[0].description, payload);
  const output = await readFile(join(f.directory, 'catalog.json'), 'utf8'); assert.ok(!output.includes('EXECUTE')); assert.ok(!output.includes('file:///secret'));
  assert.ok(f.server.calls.every((c) => new URL(c.url).origin === 'https://api.pingroom.io'));
});

test('pagination links are ignored even when they target another host', async (t) => {
  const f = await fixture(t, { rows: Array.from({ length: 11 }, (_, n) => row(n + 1)), pagePatch: (value) => ({ ...value, next_page_url: value.next_page_url ? 'https://evil.invalid/?token=bad' : null }) });
  await f.run(); assert.ok(f.server.calls.every((c) => new URL(c.url).origin === 'https://api.pingroom.io'));
});

test('ambient credentials and base URL do not affect public requests', async (t) => {
  const oldToken = process.env.PINGROOM_TOKEN; const oldUrl = process.env.PINGROOM_API_URL;
  process.env.PINGROOM_TOKEN = 'must-not-send'; process.env.PINGROOM_API_URL = 'http://evil.invalid';
  try { const f = await fixture(t); await f.run(); assert.ok(f.server.calls.every((c) => c.authorization === null && c.url.startsWith('https://api.pingroom.io/'))); }
  finally { if (oldToken === undefined) delete process.env.PINGROOM_TOKEN; else process.env.PINGROOM_TOKEN = oldToken; if (oldUrl === undefined) delete process.env.PINGROOM_API_URL; else process.env.PINGROOM_API_URL = oldUrl; }
});

for (const [label, patch] of [
  ['wrong page', (p) => ({ ...p, current_page: 2 })],
  ['missing rows', (p) => ({ ...p, data: [] })],
  ['invalid total', (p) => ({ ...p, total: '2' })],
  ['missing next-page metadata', (p) => ({ ...p, last_page: 2, total: 11, next_page_url: null })],
  ['invalid handle', (p) => ({ ...p, data: [{ ...p.data[0], handle: '../private' }, ...p.data.slice(1)] })],
  ['duplicate handles', (p) => ({ ...p, data: [p.data[0], p.data[0]] })],
]) {
  test(`failed refresh preserves the old snapshot: ${label}`, async (t) => {
    const f = await fixture(t); await f.run(); const before = await readFile(join(f.directory, 'catalog.json'));
    f.server.pagePatch = patch; await assert.rejects(f.run()); assert.deepEqual(await readFile(join(f.directory, 'catalog.json')), before);
  });
}

test('changed totals across pages fail before publishing', async (t) => {
  const f = await fixture(t, { rows: Array.from({ length: 11 }, (_, n) => row(n + 1)), pagePatch: (p) => p.current_page === 2 ? { ...p, total: 12 } : p });
  await assert.rejects(f.run(), { code: 'incomplete_scan' }); await assert.rejects(readFile(join(f.directory, 'catalog.json')), { code: 'ENOENT' });
});

test('configured page and 50-profile caps refuse partial exports', async (t) => {
  const f = await fixture(t, { rows: Array.from({ length: 11 }, (_, n) => row(n + 1)) });
  await assert.rejects(f.run({ input: { ...policy, maxPages: 1 } }), { code: 'incomplete_scan' });
  f.server.rows = Array.from({ length: 51 }, (_, n) => row(n + 1)); await assert.rejects(f.run(), { code: 'incomplete_scan' });
});

test('detail 404 and metadata drift preserve the old generation', async (t) => {
  const f = await fixture(t); await f.run(); const before = await readFile(join(f.directory, 'catalog.json'));
  f.server.failHandle = 'agt_demo2'; await assert.rejects(f.run());
  f.server.failHandle = null; f.server.detailPatch = (v) => ({ ...v, tagline: 'Changed' }); await assert.rejects(f.run(), { code: 'profile_changed' });
  assert.deepEqual(await readFile(join(f.directory, 'catalog.json')), before);
});

test('oversized and control-bearing descriptions fail validation', async (t) => {
  const f = await fixture(t, { detailPatch: (v) => ({ ...v, description: 'x'.repeat(2001) }) }); await assert.rejects(f.run(), { code: 'invalid_profile' });
  f.server.detailPatch = (v) => ({ ...v, description: '\u001b[2J' }); await assert.rejects(f.run(), { code: 'invalid_profile' });
});

test('search is offline, literal, tagged, and labels age without availability claims', async (t) => {
  const f = await fixture(t, { detailPatch: (v) => ({ ...v, description: 'Use [CI]+ templates.' }) }); const saved = await f.run(); const calls = f.server.calls.length;
  const result = searchCatalog(saved, '[ci]+', 'ci', Date.parse('2026-10-19T05:01:00Z'));
  assert.equal(result.entries.length, 2); assert.equal(result.ageSeconds, 60); assert.equal(result.currentAvailabilityVerified, false); assert.equal(f.server.calls.length, calls);
  assert.equal(searchCatalog(saved, '.*').entries.length, 0);
  assert.equal(searchCatalog(saved, '', null, 0).clockBeforeObservation, true);
});

test('offline command searches saved catalog from a different working directory', async (t) => {
  const f = await fixture(t); await f.run(); const main = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const child = spawnSync(process.execPath, [main, 'search', 'guide 1', '--tag', 'ci'], { cwd: tmpdir(), env: { ...process.env, CATALOG_DIRECTORY: f.directory, PINGROOM_API_URL: 'http://127.0.0.1:1' }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).entries[0].handle, 'agt_demo1');
});

test('saved snapshot tampering or unsafe reference URLs are refused', async (t) => {
  const f = await fixture(t); const saved = await f.run(); saved.entries[0].referenceUrl = 'javascript:alert(1)';
  assert.throws(() => searchCatalog(saved), { code: 'invalid_snapshot' }); assert.throws(() => searchCatalog(null), { code: 'invalid_snapshot' });
});

test('malformed config, duplicate allowlist and unsafe search arguments are refused', () => {
  for (const value of [null, { ...policy, maxPages: 6 }, { ...policy, allowHandles: ['agt_x', 'agt_x'] }, { ...policy, tag: 5 }, { ...policy, search: '\u001battack' }, { ...policy, url: 'https://evil' }]) assert.throws(() => config(value), { code: 'invalid_config' });
});

test('concurrent sync is locked and cancellation preserves completed snapshot', async (t) => {
  const f = await fixture(t); await f.run(); const before = await readFile(join(f.directory, 'catalog.json'));
  await withLock(f.directory, async () => assert.rejects(f.run(), { code: 'locked' }));
  const ac = new AbortController(); ac.abort(); await assert.rejects(f.run({ signal: ac.signal }));
  assert.deepEqual(await readFile(join(f.directory, 'catalog.json')), before);
});

test('local reads reject duplicate keys, oversized files, and symlinks', async (t) => {
  const f = await fixture(t); const path = join(f.directory, 'bad.json');
  await writeFile(path, '{"a":1,"a":2}'); await assert.rejects(readJson(path, 100), { code: 'invalid_json' });
  await writeFile(path, ' '.repeat(101)); await assert.rejects(readJson(path, 100), { code: 'input_limit' });
  await symlink(path, join(f.directory, 'link')); await assert.rejects(readJson(join(f.directory, 'link'), 100));
});

test('transport rejects redirects, oversized JSON bodies, and invalid UTF8', async () => {
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }), new Response('x'.repeat(128 * 1024 + 1)), new Response(new Uint8Array([255]))]) {
    const client = makeClient({ fetchImpl: async () => response }); await assert.rejects(client.directory.list());
  }
});

test('infinitely ready empty chunks cannot starve the request deadline', { timeout: 2000 }, async () => {
  let cancelled = false;
  const client = makeClient({ deadlineMs: 30, fetchImpl: async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array()); }, cancel() { cancelled = true; } })) });
  const started = performance.now(); await assert.rejects(client.directory.list());
  assert.ok(performance.now() - started < 1000); assert.equal(cancelled, true);
});

test('stalled body responds to abort even when its cancellation callback stalls', { timeout: 2000 }, async () => {
  const ac = new AbortController();
  const client = makeClient({ signal: ac.signal, fetchImpl: async () => new Response(new ReadableStream({ start() {}, cancel() { return new Promise(() => {}); } })) });
  const pending = client.directory.list(); setTimeout(() => ac.abort(), 20);
  await assert.rejects(pending);
});

test('stalled custom fetch is bounded by the request deadline', { timeout: 2000 }, async () => {
  const client = makeClient({ deadlineMs: 20, fetchImpl: async () => new Promise(() => {}) }); await assert.rejects(client.directory.list());
});
