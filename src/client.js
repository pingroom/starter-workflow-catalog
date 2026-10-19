import { PingRoom } from '@pingroom/sdk';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { fail } from './model.js';
export const API_URL = 'https://api.pingroom.io';

function interruptible(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Public GETs only. Never forward credentials or follow URLs from profiles. */
export function makeClient({ fetchImpl = globalThis.fetch, signal, deadlineMs = 5000 } = {}) {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5000) fail('invalid_deadline', 'Request deadline must be 1–5000 ms.');
  return new PingRoom({ baseUrl: API_URL, token: null, timeoutMs: deadlineMs,
    fetch: async (rawUrl, init) => {
      const url = new URL(rawUrl);
      if (url.origin !== API_URL || !/^\/api\/agents\/directory(?:\/agt_[a-z0-9_]{1,40})?$/.test(url.pathname)
        || init.method !== 'GET' || new Headers(init.headers).has('authorization') || new Headers(init.headers).has('cookie')) {
        fail('transport_rejected', 'Only unauthenticated public directory GETs are permitted.');
      }
      const started = performance.now(); const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new Error('Directory request deadline exceeded.')), deadlineMs);
      const combined = AbortSignal.any([init.signal, signal, deadline.signal].filter(Boolean));
      const check = () => {
        if (performance.now() - started >= deadlineMs) deadline.abort(new Error('Directory request deadline exceeded.'));
        combined.throwIfAborted();
      };
      let reader;
      try {
        const response = await interruptible(() => fetchImpl(url.toString(), { ...init, redirect: 'manual', signal: combined }), combined);
        check();
        if (response.status >= 300 && response.status < 400) fail('redirect_rejected', 'Directory redirects are refused.');
        reader = response.body?.getReader();
        const chunks = []; let size = 0; let reads = 0;
        if (reader) for (;;) {
          check();
          // Real fetch honors AbortSignal. The race also bounds a custom stream
          // that stalls; yielding keeps cancellation responsive on ready chunks.
          const part = await interruptible(() => reader.read(), combined);
          check();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 128 * 1024) fail('response_limit', 'Directory response exceeds 128 KiB.');
          if (part.value.byteLength) chunks.push(part.value);
          if (++reads % 64 === 0) await yieldTurn(undefined, { signal: combined });
        }
        check();
        const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
        new TextDecoder('utf-8', { fatal: true }).decode(data);
        return new Response(data, { status: response.status, statusText: response.statusText, headers: response.headers });
      } finally {
        clearTimeout(timer);
        // A hostile custom stream's cancel callback can itself stall.
        if (reader) void reader.cancel().catch(() => {});
      }
    } });
}
