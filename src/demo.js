import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { mockDirectory, policy, row } from './mock.js';
import { syncCatalog } from './catalog.js';
import { searchCatalog } from './model.js';
const directory = await mkdtemp(join(tmpdir(), 'pingroom-catalog-demo-'));
try {
  const server = mockDirectory({ rows: Array.from({ length: 12 }, (_, n) => row(n + 1)) });
  const saved = await syncCatalog({ client: server.client, input: policy, directory, paceMs: 0 });
  console.log(`Saved ${saved.entries.length} public workflow references from ${saved.coverage.pagesRead} mocked pages.`);
  const found = searchCatalog(saved, 'Build guide 12', 'ci'); assert.equal(found.entries.length, 1);
  console.log(`Offline literal search found ${found.entries[0].handle}; observed at ${saved.observedAt}.`);
  const before = await readFile(join(directory, 'catalog.json'));
  server.failHandle = 'agt_demo2';
  await assert.rejects(syncCatalog({ client: server.client, input: policy, directory, paceMs: 0 }));
  assert.deepEqual(await readFile(join(directory, 'catalog.json')), before);
  console.log('A simulated missing profile preserved the previous complete snapshot.');
  console.log('No credentials, network requests, instructions executed, or live pings.');
} finally { await rm(directory, { recursive: true, force: true }); }
