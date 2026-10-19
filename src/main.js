import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { makeClient } from './client.js';
import { syncCatalog } from './catalog.js';
import { readJson } from './storage.js';
import { searchCatalog, fail } from './model.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const controller = new AbortController();
let interrupted = 0;
for (const [event, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(event, () => { interrupted = code; controller.abort(); });
let timer;
try {
  try { process.loadEnvFile(resolve(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const directory = resolve(root, process.env.CATALOG_DIRECTORY ?? '.catalog');
  const [command, ...args] = process.argv.slice(2);
  if (command === 'sync') {
    if (args.length) fail('invalid_command', 'sync takes no command-line arguments; edit catalog.config.json.');
    const input = await readJson(resolve(root, process.env.CATALOG_CONFIG ?? 'catalog.config.json'), 16 * 1024);
    timer = setTimeout(() => controller.abort(), 120_000);
    const result = await syncCatalog({ client: makeClient({ signal: controller.signal }), input, directory, signal: controller.signal });
    console.log(JSON.stringify({ observedAt: result.observedAt, ...result.coverage, snapshot: 'catalog.json' }, null, 2));
  } else if (command === 'search') {
    const query = args[0] ?? ''; const filterTag = args.length === 3 && args[1] === '--tag' ? args[2] : null;
    if (![0, 1, 3].includes(args.length) || (args.length === 3 && args[1] !== '--tag')) fail('invalid_command', 'Use search -- "literal text" [--tag TAG].');
    const saved = await readJson(resolve(directory, 'catalog.json'), 512 * 1024);
    console.log(JSON.stringify(searchCatalog(saved, query, filterTag), null, 2));
  } else fail('invalid_command', 'Use sync or search.');
} catch (error) {
  console.error(error.name === 'CatalogError' ? `${error.code}: ${error.message}` : 'Catalog operation failed. Check configuration, network, and saved data; failed reads do not publish a new snapshot.');
  process.exitCode = interrupted || 1;
} finally { clearTimeout(timer); }
