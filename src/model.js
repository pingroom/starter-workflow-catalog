export class CatalogError extends Error {
  constructor(code, message) { super(message); this.name = 'CatalogError'; this.code = code; }
}
export const fail = (code, message) => { throw new CatalogError(code, message); };
export const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const keys = (v, names) => object(v) && Object.keys(v).sort().join(',') === [...names].sort().join(',');
export const handle = (v) => typeof v === 'string' && /^agt_[a-z0-9_]{1,40}$/.test(v);
export const tag = (v) => typeof v === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(v);
export const plain = (v, max, empty = false) => typeof v === 'string' && [...v].length <= max && (empty || v.trim().length > 0)
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v);
export const SOURCE = 'https://api.pingroom.io/api/agents/directory';
export const PER_PAGE = 10;
export const MAX_ENTRIES = 50;

export function config(v) {
  if (!keys(v, ['tag', 'search', 'allowHandles', 'maxPages']) || !(v.tag === null || tag(v.tag))
    || !plain(v.search, 80, true) || /[\n\r\t]/.test(v.search)
    || !Array.isArray(v.allowHandles) || v.allowHandles.length > 50 || !v.allowHandles.every(handle)
    || new Set(v.allowHandles).size !== v.allowHandles.length || !Number.isInteger(v.maxPages) || v.maxPages < 1 || v.maxPages > 5) {
    fail('invalid_config', 'Use an optional tag, search text up to 80 characters, up to 50 unique handles, and maxPages 1–5.');
  }
  return { tag: v.tag, search: v.search, allowHandles: [...v.allowHandles].sort(), maxPages: v.maxPages };
}

export function summary(v) {
  if (!object(v) || !handle(v.handle) || !plain(v.display_name, 48) || !plain(v.tagline, 80, true)
    || !Array.isArray(v.tags) || v.tags.length > 3 || !v.tags.every(tag) || new Set(v.tags).size !== v.tags.length) {
    fail('invalid_profile', 'Directory profile identity or descriptive fields are invalid.');
  }
  return { handle: v.handle, name: v.display_name, tagline: v.tagline, tags: [...v.tags].sort() };
}

export function detail(v, before) {
  const current = summary(v);
  if (JSON.stringify(current) !== JSON.stringify(before)) fail('profile_changed', 'A listing changed between pagination and its detail read; repeat the full sync.');
  if (!(v.description === null || plain(v.description, 2000, true))) fail('invalid_profile', 'Profile description exceeds supported text limits.');
  // Deliberately ignore setup_prompt, card_url, activity, ping_policy and unknown
  // fields. This data is a workflow reference, never an instruction or endpoint.
  return { ...current, description: v.description ?? '', referenceUrl: `https://pingroom.io/agents/${current.handle}` };
}

export function page(v, expected, maxPages, expectedTotal) {
  if (!object(v) || v.current_page !== expected || v.per_page !== PER_PAGE || !Number.isInteger(v.total)
    || v.total < 0 || v.total > MAX_ENTRIES || v.last_page !== Math.max(1, Math.ceil(v.total / PER_PAGE))
    || v.last_page > maxPages || !Array.isArray(v.data)
    || v.data.length !== Math.min(PER_PAGE, Math.max(0, v.total - (expected - 1) * PER_PAGE))
    || (expectedTotal !== undefined && v.total !== expectedTotal)
    || (expected < v.last_page ? typeof v.next_page_url !== 'string' : v.next_page_url !== null)
    || (expected === 1 ? v.prev_page_url !== null : typeof v.prev_page_url !== 'string')) {
    fail('incomplete_scan', 'Pagination changed, is malformed, or exceeds the configured complete-scan bound.');
  }
  return { total: v.total, lastPage: v.last_page, rows: v.data.map(summary) };
}

export function snapshot(v) {
  if (!keys(v, ['version', 'observedAt', 'source', 'config', 'coverage', 'entries']) || v.version !== 1 || v.source !== SOURCE
    || typeof v.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.observedAt)
    || !Number.isFinite(Date.parse(v.observedAt)) || !Array.isArray(v.entries) || v.entries.length > MAX_ENTRIES) fail('invalid_snapshot', 'Saved catalog is invalid.');
  const policy = config(v.config);
  if (!keys(v.coverage, ['pagesRead', 'rowsObserved', 'selectedCount', 'completePagination', 'atomicServerSnapshot'])
    || !Number.isInteger(v.coverage.rowsObserved) || v.coverage.rowsObserved < 0 || v.coverage.rowsObserved > MAX_ENTRIES
    || v.coverage.pagesRead !== Math.max(1, Math.ceil(v.coverage.rowsObserved / PER_PAGE)) || v.coverage.pagesRead > policy.maxPages
    || v.coverage.selectedCount !== v.entries.length || v.entries.length > v.coverage.rowsObserved
    || v.coverage.completePagination !== true || v.coverage.atomicServerSnapshot !== false) fail('invalid_snapshot', 'Saved catalog coverage is invalid.');
  const seen = new Set();
  for (const item of v.entries) {
    if (!keys(item, ['handle', 'name', 'tagline', 'tags', 'description', 'referenceUrl']) || seen.has(item.handle)) fail('invalid_snapshot', 'Saved catalog entries are invalid or duplicated.');
    const normalized = detail({ handle: item.handle, display_name: item.name, tagline: item.tagline, tags: item.tags, description: item.description },
      summary({ handle: item.handle, display_name: item.name, tagline: item.tagline, tags: item.tags }));
    if (JSON.stringify(normalized) !== JSON.stringify(item) || !matches(item, policy.search, policy.tag)
      || (policy.allowHandles.length > 0 && !policy.allowHandles.includes(item.handle))) fail('invalid_snapshot', 'Saved catalog entry does not match its policy or canonical link.');
    seen.add(item.handle);
  }
  if (v.entries.map((x) => x.handle).join(',') !== [...seen].sort().join(',')) fail('invalid_snapshot', 'Saved catalog ordering is invalid.');
  return v;
}

export function matches(item, search = '', filterTag = null) {
  const term = search.toLocaleLowerCase('en-US');
  // Online search is defined only over name, tagline and handle; descriptions
  // are included separately by the offline search function.
  return (!filterTag || item.tags.includes(filterTag))
    && [item.handle, item.name, item.tagline].some((text) => text.toLocaleLowerCase('en-US').includes(term));
}

export function searchCatalog(raw, query = '', filterTag = null, now = Date.now()) {
  const saved = snapshot(raw);
  if (!plain(query, 120, true) || /[\n\r\t]/.test(query) || !(filterTag === null || tag(filterTag)) || !Number.isFinite(now)) fail('invalid_search', 'Use literal search text up to 120 characters and an optional tag.');
  const needle = query.toLocaleLowerCase('en-US');
  return { observedAt: saved.observedAt, ageSeconds: Math.max(0, Math.floor((now - Date.parse(saved.observedAt)) / 1000)),
    clockBeforeObservation: now < Date.parse(saved.observedAt), currentAvailabilityVerified: false,
    entries: saved.entries.filter((row) => (!filterTag || row.tags.includes(filterTag))
      && [row.handle, row.name, row.tagline, row.description].some((text) => text.toLocaleLowerCase('en-US').includes(needle))) };
}
