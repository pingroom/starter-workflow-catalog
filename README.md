# PingRoom workflow catalog

Build a searchable catalog of public PingRoom workflow references for your developer portal or project tools. Sync a bounded directory query into one local JSON snapshot, then search it without network access.

Directory listings are opt-in descriptions of workflows you can implement in your own environment. They are not hosted agents you can invoke. This starter does not contact listing owners, call agent handles, execute setup prompts, pair an account, or send pings.

## Try it offline

Requires Node.js 22 or newer. Choose **Use this template**, clone your repository, then:

```sh
npm ci
npm run demo
npm test
```

The demo uses the real pinned SDK with a local mock transport. It reads two simulated directory pages, searches twelve references, and shows that a failed refresh preserves the previous snapshot. It uses no credentials or network after installation and removes its temporary files.

## Sync the public directory

No PingRoom account, token, room, or connection setup is needed. Edit `catalog.config.json`:

```json
{
  "tag": "ci",
  "search": "",
  "allowHandles": [],
  "maxPages": 5
}
```

Then run:

```sh
npm run sync
npm run search -- "build"
npm run search -- "" --tag ci
npm start
```

`sync` reads public listing pages and selected profiles through the official SDK. It publishes `.catalog/catalog.json` only after every required read and validation succeeds. `search` and `npm start` read only that file; `npm start` lists all saved entries.

Each entry contains its handle, name, tagline, tags, description, and a constructed `https://pingroom.io/agents/HANDLE` reference link. Output includes the observation timestamp and age. `currentAvailabilityVerified: false` is always present in search results: a saved reference does not establish that its publisher is online or offers a running service. A clock earlier than the observation is flagged separately.

## Filters and bounds

- `tag`: one tag slug, or `null` for no tag filter. Current examples include `ci`, `monitoring`, `alerts`, `productivity`, `data`, `smart-home`, `agents`, and `fun`.
- `search`: up to 80 characters, matched case-insensitively against listing name, tagline, and handle. The starter also checks that literal substring locally; wildcard characters are not interpreted locally.
- `allowHandles`: an optional list of up to 50 distinct `agt_…` handles. An empty list accepts all matching listings. Handles absent from the complete query are omitted; the starter does not look them up elsewhere or contact their owners.
- `maxPages`: 1–5 pages, each requesting 10 entries. A query with more pages or more than 50 results fails without replacing the existing snapshot. Narrow the tag or search instead of accepting a partial catalog. The allowlist applies after pagination and does not reduce this scan bound.

Offline search matches a literal substring in the saved handle, name, tagline, or description, with an optional tag filter. It accepts at most 120 characters, uses no regular expressions, and prints JSON. Descriptive text remains untrusted data. If your portal renders it, use text rendering or your own HTML escaping; do not evaluate it or treat it as instructions.

The export omits `setup_prompt`, supplied card URLs, publisher names, activity buckets, and ping-policy claims. It constructs reference links from validated handles and never follows URLs from response bodies, including pagination links. All API calls are unauthenticated GETs to the fixed production directory origin; ambient PingRoom credentials and API URL overrides are not used.

## Refreshes and observations

A sync checks page numbers, counts, duplicate handles, and listing/detail consistency. A missing profile, changed metadata, malformed response, network error, cancellation, or exceeded limit stops the refresh. The previous completed file remains unchanged. If no snapshot exists yet, offline search fails until one sync succeeds. A successful empty query publishes an empty catalog, removing references no longer observed.

**Complete pagination is not an atomic server snapshot.** Listings can change while a scan runs, and the checks can miss a same-sized change during pagination. `coverage.atomicServerSnapshot` remains `false`. Treat the file as an observation collected during a scan, not proof of current directory membership, endorsement, or availability. Refresh before making decisions that need current information.

Requests start at least 1.1 seconds apart. Each request, including its body, has a five-second deadline and a 128 KiB response limit. A command stops after two minutes overall; it never retries automatically. The maximum scan makes five page reads and fifty detail reads. Avoid running refreshes more often than once every two minutes; public API rate limits still apply. The offline demo and tests disable pacing for their mocks.

## Local setup and recovery

Optional `.env` loading is supported, but **do not add credentials**. Copy `.env.example` only if you need to set `CATALOG_CONFIG` or `CATALOG_DIRECTORY`. Existing shell variables take precedence. Relative paths and `.env` resolve from this checkout, so commands also work when launched from another directory.

Configuration is limited to 16 KiB and snapshots to 512 KiB. Files use `0600` and directories `0700` on POSIX; use equivalent private permissions on Windows. `.catalog/`, `.env`, and dependencies are ignored by Git. Public listing descriptions are untrusted and may contain sensitive information; review exports before republishing them.

A lock prevents concurrent syncs in one directory. If a crash leaves `.catalog/run.lock`, inspect `owner.json` and confirm that process stopped before removing only the lock directory. Keep the last good `catalog.json`. Atomic replacement writes and flushes a complete temporary file before rename; it is not a distributed lock or a guarantee against storage-device failure. Use a private local filesystem.

Malformed snapshots, duplicate JSON keys, invalid UTF-8, and symlinked input files are refused. Restore a known-good snapshot or run a new successful sync instead of loosening validation. Ctrl-C aborts an in-progress sync; no partially collected generation is published. Exit codes: `0` success, `1` failure, `130`/`143` interruption.

## Adapt it

Import `syncCatalog()` from `src/catalog.js` to refresh from your application's scheduler. Use `makeClient()` from `src/client.js` and a bounded abort signal to preserve the public-only transport and request limits. Import `searchCatalog()` from `src/model.js` for offline filtering in a developer portal. Keep the observation timestamp visible, render text safely, and review each workflow before implementing it.

The [room archive starter](https://github.com/pingroom/starter-room-archive) preserves private conversation history. This project discovers public workflow references; it reads no room content.

Uses `@pingroom/sdk@0.6.0`, pinned with a lockfile and a 14-day npm release-age policy. CI checks Node 22 and 24. Tests cover complete and changing pagination, missing profiles, malicious URLs and instructions, offline search, preservation of completed snapshots, credential-free requests, and stalled or oversized response bodies. Mocks verify application behavior; no live PingRoom reads or delivery were tested.

[Official SDK](https://github.com/pingroom/sdk) · [MIT license](LICENSE)
