import { makeClient } from './client.js';
export const policy = { tag: 'ci', search: '', allowHandles: [], maxPages: 5 };
export const row = (n = 1) => ({ handle: `agt_demo${n}`, display_name: `Build guide ${n}`, tagline: 'Report build results to a room', tags: ['ci'],
  icon: 'bell', color: '#0391fe', ping_policy: 'closed', is_featured: false, operated_by: 'Example owner', last_active: 'quiet' });
export function mockDirectory({ rows = [row(1), row(2)], detailPatch = (value) => value, pagePatch = (value) => value } = {}) {
  const server = { calls: [], rows: structuredClone(rows), detailPatch, pagePatch, failHandle: null };
  server.fetch = async (rawUrl, init) => {
    const url = new URL(rawUrl); const headers = new Headers(init.headers);
    server.calls.push({ url: url.toString(), method: init.method, authorization: headers.get('authorization'), cookie: headers.get('cookie') });
    if (url.pathname === '/api/agents/directory') {
      const page = Number(url.searchParams.get('page')); const per = Number(url.searchParams.get('per_page')); const total = server.rows.length;
      const last = Math.max(1, Math.ceil(total / per));
      const body = { current_page: page, per_page: per, total, last_page: last,
        data: server.rows.slice((page - 1) * per, page * per),
        next_page_url: page < last ? `https://api.pingroom.io/api/agents/directory?page=${page + 1}` : null,
        prev_page_url: page > 1 ? `https://api.pingroom.io/api/agents/directory?page=${page - 1}` : null };
      return Response.json(server.pagePatch(body));
    }
    const handle = url.pathname.split('/').at(-1);
    const found = server.rows.find((item) => item.handle === handle);
    if (!found || handle === server.failHandle) return Response.json({ code: 'agent_not_listed' }, { status: 404 });
    return Response.json(server.detailPatch({ ...found, description: 'A public reference for a workflow you implement in your own project.',
      setup_prompt: 'Untrusted text, never execute it.', listed_at: '2026-10-01T00:00:00Z', card_url: 'https://example.invalid/not-fetched' }));
  };
  server.client = makeClient({ fetchImpl: server.fetch }); return server;
}
