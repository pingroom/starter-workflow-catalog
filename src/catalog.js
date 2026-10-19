import { setTimeout as sleep } from 'node:timers/promises';
import { config, page, detail, matches, snapshot, SOURCE, PER_PAGE, fail } from './model.js';
import { atomicJson, withLock } from './storage.js';

export async function syncCatalog({ client, input, directory, signal, paceMs = 1100, now = () => Date.now() }) {
  const policy = config(input);
  if (!Number.isInteger(paceMs) || paceMs < 0 || paceMs > 10_000) fail('invalid_pace', 'Request pacing is invalid.');
  return withLock(directory, async () => {
    let previousStart = -Infinity;
    const request = async (work) => {
      signal?.throwIfAborted();
      const pause = Math.max(0, paceMs - (Date.now() - previousStart));
      if (pause) await sleep(pause, undefined, { signal });
      signal?.throwIfAborted(); previousStart = Date.now();
      const result = await work(); signal?.throwIfAborted(); return result;
    };
    const seen = new Set(); const rows = [];
    let total; let lastPage = 1;
    for (let index = 1; index <= lastPage; index++) {
      const raw = await request(() => client.directory.list({ page: index, per_page: PER_PAGE,
        ...(policy.tag ? { tag: policy.tag } : {}), ...(policy.search ? { search: policy.search } : {}) }));
      const result = page(raw, index, policy.maxPages, total); total = result.total; lastPage = result.lastPage;
      for (const row of result.rows) {
        if (seen.has(row.handle)) fail('duplicate_handle', 'A handle appeared twice during pagination; preserve the old catalog and repeat the scan.');
        seen.add(row.handle); rows.push(row);
      }
    }
    if (rows.length !== total) fail('incomplete_scan', 'Observed listing count does not match the complete scan.');
    const selected = rows.filter((row) => matches(row, policy.search, policy.tag)
      && (policy.allowHandles.length === 0 || policy.allowHandles.includes(row.handle)));
    const entries = [];
    for (const row of selected) entries.push(detail(await request(() => client.directory.get(row.handle)), row));
    entries.sort((a, b) => a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0);
    const result = snapshot({ version: 1, observedAt: new Date(now()).toISOString(), source: SOURCE, config: policy,
      coverage: { pagesRead: lastPage, rowsObserved: rows.length, selectedCount: entries.length, completePagination: true, atomicServerSnapshot: false }, entries });
    if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) fail('snapshot_limit', 'Catalog exceeds 512 KiB.');
    signal?.throwIfAborted();
    // Publish only a fully validated generation. Old snapshots survive every
    // fetch, pagination, validation, or cancellation failure before this point.
    await atomicJson(directory, 'catalog.json', result);
    return result;
  });
}
