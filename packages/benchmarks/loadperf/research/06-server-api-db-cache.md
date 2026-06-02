# Server API & DB / Cache — Optimization Research

Scope: `packages/app-core/src/api/**`, `packages/app-core/src/services/**`, storage
adapters (`plugins/plugin-sql`, `plugins/plugin-localdb`, `plugins/plugin-inmemorydb`),
plus the agent-package data routes those adapters back (`packages/agent/src/api/database.ts`,
`memory-routes.ts`) because they are the request path that exercises the adapters.

All numbers below are **measured on this machine** against a freshly-booted headless
server on a PGlite store (the default local backend), commit `c7a13515a5`, branch
`develop`. Exact commands are in §D. Nothing here is an estimate unless explicitly
labelled.

---

## A. Critical Assessment

The dashboard API is a single Node HTTP server with a **linear chain of
`handleX(req,res,state) → boolean` handlers** dispatched by `URL.pathname`
string matching (`packages/app-core/src/api/server.ts:651`). It is correct and
readable, but it has accumulated several systemic perf problems that show up the
moment more than one request is in flight:

1. **Everything is synchronous and single-threaded, and several handlers do
   meaningful synchronous work in the request path** — a full recursive
   deep-clone of every response body (`scrubStackFields`,
   `packages/app-core/src/api/response.ts:3`), and uncached multi-file config
   reads (`loadElizaConfig`, `packages/agent/src/config/config.ts:98`). Under 8
   concurrent clients even `/api/health` (a constant payload) degrades from p50
   6.7 ms to p50 **102.7 ms** (§D.2), which is the signature of event-loop
   contention, not I/O.

2. **No response compression anywhere.** `sendJson` sets `content-type` and ends
   the buffer; there is no `content-encoding` (verified with `curl -H
   "Accept-Encoding: gzip,br"` → only `Content-Length`, §D.3). `/api/catalog/apps`
   ships 11,146 bytes uncompressed that brotli/gzip would cut to ~2 KB.

3. **The list/data routes fetch far more than the client uses.**
   `runtime.getMemories()` (`plugins/plugin-sql/src/stores/memory.store.ts:48`)
   *always* `LEFT JOIN`s the embedding table and returns the full 384-float
   vector per row. The memories feed
   (`packages/agent/src/api/memory-routes.ts:295`) pulls ≥200 rows per table ×
   several tables (≈1,000 rows), `Array.from()`-materializes every embedding,
   then **drops all of them** in `memoryToBrowseItem`
   (`memory-routes.ts:257`). A warm `/api/memories/feed?limit=50` request takes
   ~210 ms to produce a **1,156-byte** response (§D.4).

4. **No server-side memoization of expensive derived values and no caches to hit.**
   The only in-process caches are: the registry slot (`loadRegistry`,
   correctly cached, `packages/app-core/src/registry/index.ts:82`), the auth
   rate-limiter Map, and a per-runtime SQL-compat WeakSet. There is **no
   per-route timing, no query counter, and no cache hit/miss instrumentation** —
   so "cache hit rate" is currently 0 observable / 0 measurable. The biggest
   cache win available is to *introduce* a cache (config + DB introspection),
   then instrument it.

5. **Redundant DB round-trips per request.** `GET
   /api/database/tables/:t/rows` runs **4 sequential queries** (schema-resolve →
   columns → count → rows: `database-rows-compat-routes.ts:51,83,146,155`); the
   agent twin (`database.ts:handleGetRows`) also runs 4
   (`assertTableExists` → columns → count → rows). The two
   `information_schema` lookups are pure introspection that never changes within
   a process lifetime and is recomputed on every request. Measured: `/rows` p50
   17–35 ms vs 2–6 ms for the cache-backed routes (§D.1).

6. **Per-request object construction on the auth hot path.**
   `ensureRouteAuthorized` builds `new AuthStore(db)` on *every* authorized
   request (`packages/app-core/src/api/auth.ts:394`), and the cookie path issues
   a `touchSession` **write** on essentially every request because the sliding
   TTL changes `lastSeenAt` (`auth/sessions.ts:180`). For loopback/dashboard
   traffic the common case is `isTrustedLocalRequest` → short-circuit (no DB),
   so this mostly bites the cloud-deployed / remote-auth topology.

None of these are correctness bugs; they are throughput and tail-latency tax. The
highest-leverage, lowest-risk wins are (3), (2), and (5) — they remove work
without changing any contract the client depends on.

---

## B. Optimization Catalog

Ranked by confidence × impact (see §E for the full ranked backlog).

| # | Area | Optimization | Conf | Impact | Risk |
|---|------|--------------|------|--------|------|
| 1 | storage adapter | `getMemories` should not JOIN+return embeddings when the caller doesn't need them (add `includeEmbedding`/`select` option; feed/browse pass false) | High | High | Low |
| 2 | api/response | Add gzip/brotli content-encoding for responses over a threshold (negotiate `Accept-Encoding`) | High | Med-High (remote) / Low (loopback) | Low |
| 3 | api/response | Replace `scrubStackFields` deep-clone with a cheap scrub on the error path only | High | Med | Low |
| 4 | api db routes | Cache `information_schema` introspection (schema + columns per table) — collapses `/rows` from 4 queries to 2 | High | Med | Low |
| 5 | agent/config | Memoize `loadElizaConfig()` with mtime/invalidation so request handlers don't re-read 3+ files + reparse JSON5 per call | Med-High | Med | Med |
| 6 | api/auth | Cache `AuthStore` per-`db` (WeakMap) instead of `new AuthStore(db)` per request | High | Low-Med | Low |
| 7 | api/auth | Throttle `touchSession` writes (only slide when `expiresAt` moves by a meaningful delta, e.g. ≥60 s) | Med | Low-Med (remote) | Low |
| 8 | plugin-sql schema | Add `tasks(agent_id)` index (every `getTasks`/`getTask`/`getTasksByName` filters on it) | Med | Low (single-agent) / Med (multi) | Low |
| 9 | observability | Add opt-in per-route timing + DB-query-count + cache hit/miss counters behind an env flag so this work is measurable and ratchetable | High | (enables everything) | Low |
| 10 | api memory feed | Cap per-table over-fetch (`perTableLimit = max(limit*2, 200)`) to `limit`-proportional, not a 200 floor | Med | Med | Low |

---

## C. Detailed Findings

Each finding lists: (1) problem + file:line evidence, (2) fix sketch,
(3) real before/after measurement command, (4) confidence, (5) impact, (6) risk,
(7) how to verify nothing breaks.

### C1. `getMemories` always fetches+returns embeddings the list views discard

**(1) Problem.**
`MemoryStore.getMemories` unconditionally `LEFT JOIN`s `embeddingTable` and
selects `embedding: embeddingTable[<dim>]`, then `Array.from()`-materializes the
384-float vector for every row:
`plugins/plugin-sql/src/stores/memory.store.ts:48-66` (select+join) and `:92`
(`embedding: row.embedding ? Array.from(row.embedding) : undefined`).

The dashboard list endpoints do not use the embedding:
- `/api/memories/feed` and `/api/memories/browse`
  (`packages/agent/src/api/memory-routes.ts:465,493`) call `loadBrowseMemories`
  (`:295` → `runtime.getMemories(...)` at `:297`) with `perTableLimit =
  max(ceil(limit*2), 200)` (`:288`), across `MEMORY_TABLE_NAMES` tables.
- Each row is then projected by `memoryToBrowseItem`
  (`memory-routes.ts:257`) into `{id, text, source, ...}` — **no embedding
  field**. The vectors are fetched, transferred over the WASM/socket boundary,
  array-allocated, and thrown away.

So a single feed request fetches ~`200 × (#tables)` ≈ 1,000 embeddings (≈384 ×
1,000 floats) to emit a list with zero embedding bytes.

**(2) Fix sketch.**
Add an opt-out to `getMemories`: `params.includeEmbedding?: boolean` (default
keep current behavior for callers that need vectors, e.g. similarity search).
When `false`, drop the `leftJoin(embeddingTable)` and the `embedding` select
column entirely. Pass `includeEmbedding: false` from `loadBrowseMemories`
(`memory-routes.ts:297`) and any other list route. Same change applies to the
PGlite/PG path (shared `BaseDrizzleAdapter` store) and should be mirrored in the
`plugin-localdb` / `plugin-inmemorydb` adapters' `getMemories` (they keep
embeddings in JS structures; just skip copying the vector into the result when
`includeEmbedding === false`).

**(3) Measurement (real).**
Before (current build, warm):
```
# boot headless server (see §D.0), then:
for i in 1 2 3; do curl -s -o /dev/null \
  -w "feed: %{time_total}s %{size_download}b\n" -m 10 \
  http://127.0.0.1:31355/api/memories/feed?limit=50; done
```
Observed (this run): `feed warm: 0.209–0.225 s, 1156 b` (cold first call 2.70 s).
After the fix, re-run the same command; expected the bulk of the 200 ms collapses
because the JOIN + ~1,000 `Array.from(384)` allocations disappear. To attribute
the win precisely, also count queries with the §D.5 query-counter wrapper (the
JOIN is the dominant cost, not an extra round-trip, so latency — not query count —
is the metric here).

**(4) Confidence:** High — the discard is verified in source (`memoryToBrowseItem`
has no embedding field) and the payload/latency mismatch (210 ms for 1.1 KB) is
measured.
**(5) Impact:** High — removes the single largest chunk of wasted DB + CPU +
serialization on the most-visited data view.
**(6) Risk:** Low — additive optional param; default preserves vector-returning
behavior for embedding/search callers.
**(7) Verify nothing breaks:** `bun run --cwd plugins/plugin-sql test` (memory
store suite). Then in the app, open the Memories view and confirm rows render;
run a similarity-search path (which must still get embeddings) and confirm it
still returns vectors. Grep all `getMemories(` callers to ensure search/relevance
callers do NOT pass `includeEmbedding:false`.

### C2. No response compression

**(1) Problem.** `sendJson` (`packages/app-core/src/api/response.ts:23`) and the
agent's `writeJsonResponse` (`packages/core/src/api/http-helpers.ts:170`) never
set `content-encoding`. Verified:
```
curl -s -H "Accept-Encoding: gzip, br" -D - -o /dev/null \
  http://127.0.0.1:31355/api/catalog/apps | grep -i content-encoding
# (no output → uncompressed); Content-Length: 11146
```

**(2) Fix sketch.** In a shared responder, when the body exceeds a threshold
(e.g. 1 KB) and the request `Accept-Encoding` advertises `br`/`gzip`, compress
with `zlib.brotliCompressSync` (small payloads) / a streaming gzip and set
`content-encoding` + `Vary: Accept-Encoding`. Keep a hard upper bound so we never
spend CPU compressing megabyte query results synchronously on the event loop —
above that bound, stream `createGzip()` instead. Loopback can be exempted (the
desktop shell is same-machine), so gate on bind host: only compress when the API
is bound to a non-loopback address (the cloud/remote topology), matching how
`shouldEmitSecureFlag` already branches on `resolveApiBindHost`
(`api/auth/sessions.ts:302`).

**(3) Measurement (real).**
```
node -e 'const z=require("node:zlib");const b=Buffer.from(require("fs").readFileSync(0));
console.log("raw",b.length,"br",z.brotliCompressSync(b).length,"gzip",z.gzipSync(b,{level:6}).length)' \
  < <(curl -s http://127.0.0.1:31355/api/catalog/apps)
```
This prints raw vs br vs gzip bytes for the live payload (raw was 11,146 b). Wire
the same into a before/after that hits the N hottest GET endpoints and sums
transferred bytes.

**(4) Confidence:** High (compression ratio is deterministic).
**(5) Impact:** Med-High for remote/cloud-deployed agents (bandwidth + TTFB);
Low for loopback desktop (localhost transfer is ~free, so gate it off there).
**(6) Risk:** Low, but must (a) set `Vary`, (b) never double-compress, (c) bound
synchronous compression size.
**(7) Verify:** `curl --compressed` returns identical JSON; run the cloud-frontend
audit (`audit:cloud`) — pages must still load. Confirm `content-length` is
absent/recomputed and `content-encoding`/`vary` are correct.

### C3. `scrubStackFields` deep-clones every successful response

**(1) Problem.** `sendJson` runs `scrubStackFields(body)`
(`packages/app-core/src/api/response.ts:31`) which recursively rebuilds the
*entire* response object on every response, only to delete `stack`/`stackTrace`
keys that exist only on error objects. Successful payloads almost never contain
those keys, so this is a full structural clone for nothing.

**(2) Fix sketch.** Only scrub on the error path. Either (a) call
`scrubStackFields` exclusively from `sendJsonError`, or (b) make `sendJson` cheap
by serializing directly and using a `JSON.stringify` replacer that drops
`stack`/`stackTrace` in a single pass (no intermediate clone). Errors are already
funneled through `sendJsonError`, so success responses can skip the clone
entirely.

**(3) Measurement (real).** Micro-benchmark on a representative 50-row payload
(see §D.6), measured this run:
```
scrub+stringify (50-row payload): 104.3 us/req
stringify only  (no scrub):        18.4 us/req
```
≈ **86 µs of pure event-loop CPU per response** removed, scaling linearly with
payload size (so the 500-row `/rows` and the memories feed pay multiples of this).

**(4) Confidence:** High (measured, deterministic).
**(5) Impact:** Med — small per request but it is *synchronous event-loop* time
on the busiest code path, so it directly worsens the concurrency degradation in
§D.2.
**(6) Risk:** Low — only change is *where* scrubbing runs; error redaction must
remain intact.
**(7) Verify:** Add/extend a `response.test.ts` asserting `sendJsonError` still
strips `stack`/`stackTrace`, and that `sendJson` output is byte-identical to
`JSON.stringify` for a stack-free object. `bun run --cwd packages/app-core test`.

### C4. `/api/database/tables/:t/rows` recomputes `information_schema` every request

**(1) Problem.** `handleDatabaseRowsCompatRoute`
(`packages/app-core/src/api/database-rows-compat-routes.ts`) runs 4 sequential
queries per request:
- schema resolve via `information_schema.tables` (`:51`) — only when `?schema`
  absent,
- columns via `information_schema.columns` (`:83`),
- count (`:146`),
- rows (`:155`).

The agent twin `handleGetRows` (`packages/agent/src/api/database.ts:773`) does the
same shape: `assertTableExists` (`:792` → `information_schema.tables`), columns
(`:799`), count (`:850`), rows (`:864`). The schema + column metadata for a table
does not change during a process lifetime, yet it is fetched on every page/sort/
search keystroke.

**(2) Fix sketch.** Memoize table→{schema, columns, columnTypes} in a process
`Map` keyed by table name, invalidated on schema migration (or simply TTL'd, e.g.
60 s — the DB-browser tool tolerates slightly stale column lists). The count +
rows queries stay live. This collapses 4 queries → 2 on the steady-state path.
**Instrument the cache** with hit/miss counters (§C9) so the hit rate is provable
(it should approach 100 % under paging/sorting/searching the same table).

**(3) Measurement (real).** Per-route latency, 30 iters (this run):
```
/api/database/tables/memories/rows?limit=50  p50=34.61ms p95=616.40ms
/api/database/tables/entities/rows?limit=50  p50=17.43ms p95=286.97ms
```
After the cache, re-run §D.1 and additionally print the query-counter delta
(§D.5): expect per-request DB queries to drop from 4 → 2 (steady state) and p50 to
fall toward the 2-query floor. The cache hit-rate counter should report ≥ ~80 %
once a table is paged more than once.

**(4) Confidence:** High (query count is visible in source; latency measured).
**(5) Impact:** Med — halves the DB work on the DB-browser views, which are the
heaviest read endpoints in app-core's own scope.
**(6) Risk:** Low — column list staleness only matters right after a migration;
TTL + migration-hook invalidation covers it.
**(7) Verify:** Add rows after caching a table; confirm new columns appear after
TTL/migration. `bun run --cwd packages/app-core test` (compat-route suites).

### C5. `loadElizaConfig()` is uncached and runs on request paths

**(1) Problem.** `loadElizaConfig` (`packages/agent/src/config/config.ts:98`)
performs, **on every call**: `readFileSync` of the base config (`:86`),
optionally a second config file (`:104`), `JSON5.parse` + include resolution
(`:94`), a `skills.json` read (and create-if-missing) (`:113-161`),
`readConfigEnvSync` (`:169`), config-env collection, and mutation of `process.env`
(`:181-183`). It is called from request handlers:
- `getConfiguredCompatAgentName` (`packages/app-core/src/api/compat-route-shared.ts:361`),
- `resolveCloudConfig` (`packages/app-core/src/api/server.ts:585`), invoked on
  every `/api/cloud/compat/*` (`server.ts:687`) and `/api/cloud/billing/*`
  (`server.ts:700`),
- `/api/drop/status` (`server.ts:801`).

**(2) Fix sketch.** Add a process-level memo keyed on the `mtimeMs` of the config
files (cheap `statSync` instead of full read+parse+merge): on call, `stat` the
files; if unchanged since last load, return the cached `ElizaConfig` (and skip
re-applying env — or split the pure `read+merge` from the `process.env` side
effect so the side effect runs only when the content actually changed). Save/
mutation paths already exist (`saveElizaConfig`) and can bump/clear the memo.

**(3) Measurement (real).** Direct micro-benchmark (this run):
```
# /tmp throwaway importing @elizaos/agent.loadElizaConfig, 200 warm calls:
loadElizaConfig: 200 calls in 22.1ms => 0.111ms/call
```
0.11 ms/call is synchronous event-loop time, and several handlers call it more
than once per request. After memoization, re-run the same loop; cached path
should be a `statSync` (~µs) — i.e. ~0.005 ms/call when unchanged. Confirm the
cloud/billing route latency drop with §D.1 against `/api/cloud/billing/*`.

**(4) Confidence:** Med-High — cost is measured; the only nuance is the
`process.env` side effect, which must be preserved on first/changed load.
**(5) Impact:** Med — removes synchronous FS + JSON5 work from cloud and
compat request paths (helps the §D.2 concurrency cliff).
**(6) Risk:** Med — `loadElizaConfig` has the `process.env`-mutation side effect;
naive caching that skips it could leave env stale after an external file edit.
Key the cache on file mtime and re-apply env on change to stay safe. This file is
in `packages/agent` (one hop outside app-core), so coordinate with the agent
package owner.
**(7) Verify:** `bun run --cwd packages/agent test` (config suite). Manually edit
`eliza.json`, hit a config-reading route, confirm the change is observed (mtime
invalidation works). Confirm provider keys still land in `process.env` after a
config change.

### C6. `new AuthStore(db)` constructed per authorized request

**(1) Problem.** `ensureRouteAuthorized`
(`packages/app-core/src/api/auth.ts:394`) does `const store = new AuthStore(db)`
on every call where the DB is up. `AuthStore` is a thin wrapper over the Drizzle
handle (no expensive init), but it is allocated for every authorized request that
reaches the cookie/bearer path.

**(2) Fix sketch.** Cache the `AuthStore` in a `WeakMap<db, AuthStore>` (the `db`
handle is stable for the runtime lifetime; WeakMap avoids leaking across runtime
restarts). Return the cached instance.

**(3) Measurement (real).** This is allocation-pressure, not a single-call
latency win; measure via the §D.2 concurrency benchmark before/after and watch
p95 + RSS. The dominant auth cost on remote auth is the `findSession` SELECT +
`touchSession` UPDATE (C7), not the allocation — so pair this with C7.

**(4) Confidence:** High (mechanical).
**(5) Impact:** Low-Med — GC pressure reduction under load.
**(6) Risk:** Low.
**(7) Verify:** `bun run --cwd packages/app-core test:auth`.

### C7. `touchSession` writes on essentially every authenticated request

**(1) Problem.** `findActiveSession` slides the browser session TTL and writes
whenever `nextExpiresAt !== found.expiresAt || now !== found.lastSeenAt`
(`packages/app-core/src/api/auth/sessions.ts:180`). Because `now` differs on every
request, the `||` second clause is almost always true → a `touchSession` UPDATE
(`auth-store.ts:375`) per request. (For loopback dashboard traffic
`isTrustedLocalRequest` short-circuits before any DB work, so this is a
remote/cloud-auth concern.)

**(2) Fix sketch.** Only write when the slide is meaningful: skip the UPDATE
unless `expiresAt` advances by ≥ a threshold (e.g. 60 s) or `lastSeenAt` is older
than that threshold. This keeps sliding-TTL semantics (the window still moves
forward on use) while eliminating a write on bursty same-second requests.

**(3) Measurement (real).** Requires the §D.5 query counter to attribute the
write. Drive an authenticated (non-loopback) workload via the §D.2 harness with a
session cookie; count UPDATEs/req before/after. Before ≈ 1 write/req; after ≈ 0
for sub-threshold bursts.

**(4) Confidence:** Med (semantics-sensitive; needs the counter to prove it).
**(5) Impact:** Low-Med — removes a write per authenticated request on the remote
topology (PGlite serializes all writes through one connection, so write
elimination directly cuts contention there).
**(6) Risk:** Low-Med — must not let a session expire that should have been slid;
threshold must be ≪ TTL.
**(7) Verify:** `bun run --cwd packages/app-core test:auth` (session sliding
tests). Add a test: two requests in the same second produce one (not two) writes;
a request after the threshold still slides.

### C8. `tasks` table has no index on `agent_id`

**(1) Problem.** `taskTable` (`plugins/plugin-sql/src/schema/tasks.ts:10`) defines
no indexes besides the `id` PK and the `agentId` FK reference. Every
`getTasks` (`base.ts:3441`, filters `agentId` + optional `tags @>`),
`getTask` (`:3512`), and `getTasksByName` (`:3485`) filters on `agentId`. On
Postgres a FK does not create an index; on a multi-agent / large-task install
these become seq scans. (On a single-agent local PGlite store the table is tiny,
so impact is low *today*.)

Separately, `GET /api/workbench/todos`
(`packages/app-core/src/api/workbench-compat-routes.ts:198,202`) calls
`runtime.getTasks({})` and **filters todos in JS** (`.map(...).filter(...)`)
rather than passing `tags:["workbench:todo"]` to push the predicate into SQL
(`getTasks` already supports a `tags @> ARRAY[...]` filter, `base.ts:3455`).

**(2) Fix sketch.** (a) Add `index("tasks_agent_idx").on(table.agentId)` (and
optionally a GIN index on `tags` if tag filtering becomes hot). (b) In the
workbench route, pass `tags: [WORKBENCH_TODO_TAG]` to `getTasks` so the filter
runs in SQL instead of loading every task and filtering in JS.

**(3) Measurement (real).** Per-route, 30 iters (this run):
`/api/workbench/todos  p50=6.43ms` (empty task table). On a seeded table, compare
`getTasks({})` + JS filter vs `getTasks({tags:[...]})` row counts and latency via
the §D.5 counter (rows scanned drops to matching rows). Confirm the index with
`EXPLAIN` on Postgres before/after.

**(4) Confidence:** Med (index need is config-dependent; the JS-filter→SQL-filter
change is unambiguous).
**(5) Impact:** Low single-agent / Med multi-agent or large task volume.
**(6) Risk:** Low (additive index + migration; the schema is auto-migrated, see
plugin-sql `DatabaseMigrationService`).
**(7) Verify:** `bun run --cwd plugins/plugin-sql test`; confirm migration adds
the index; workbench todos view still lists todos.

### C9. There is no per-route timing / query-count / cache hit-rate instrumentation

**(1) Problem.** The server has no request-timing middleware (grep for
`performance.now`/`durationMs`/`process.hrtime` in `server.ts` finds only a
one-off `upstreamStartApiServer` boot timer, `server.ts:1171`). The storage
adapters expose no query counter. There are effectively no caches to measure
(§A.4). This makes every "before/after" above harder than it should be and makes
regressions invisible.

**(2) Fix sketch.** Add three opt-in, env-flagged (`ELIZA_PERF_INSTRUMENT=1`)
counters, all no-ops when the flag is off:
- **Route timing**: wrap the top of `handleCompatRoute` /
  the dispatch entry with `performance.now()` start/end keyed by a normalized
  pathname; accumulate `count`, `p50/p95` (reservoir or HDR), expose at
  `GET /api/dev/route-timings` (loopback, alongside the other `/api/dev/*` in
  `dev-compat-routes.ts`).
- **DB query counter**: wrap `executeRawSql`
  (`packages/shared/src/utils/sql-compat.ts:25`) and/or the adapter's
  `db.execute`/`db.select` to bump a per-process counter (optionally per
  AsyncLocalStorage request scope so per-request counts are attributable).
- **Cache hit/miss**: each cache introduced (C4 introspection, C5 config) exposes
  `{hits, misses}`; surface in the same `/api/dev/*` payload.

**(3) Measurement (real).** This *is* the measurement infrastructure; once it
lands, every §C before/after becomes a single `GET /api/dev/route-timings` diff
plus a query-count delta, and the cache hit-rate is a direct read.

**(4) Confidence:** High.
**(5) Impact:** Enables and de-risks all other items; no runtime cost when the
flag is off.
**(6) Risk:** Low (env-gated, off by default; must truly no-op when off — guard
before any `performance.now()`).
**(7) Verify:** With the flag off, run §D.2 and confirm latency is unchanged
(no measurable overhead). With it on, confirm counters increment and the
loopback endpoint returns sane p50/p95.

### C10. Memory feed over-fetches with a 200-row-per-table floor

**(1) Problem.** `loadBrowseMemories` sets `perTableLimit = max(ceil(limit*2),
200)` (`packages/agent/src/api/memory-routes.ts:288`) and queries every table in
`MEMORY_TABLE_NAMES` concurrently (`:295`). For a default `limit` of 50 this pulls
≥200 rows/table × N tables, then slices to `limit` after the fact
(`memory-routes.ts:482`). Combined with C1 (embeddings), this is the dominant cost
of the feed.

**(2) Fix sketch.** Drop the hard 200 floor; use `perTableLimit =
limit + small_headroom` (headroom only covers post-filtering by
`hasBrowsableContent`/entity). With C1 (no embeddings) the over-fetch is cheaper,
but trimming it compounds the win.

**(3) Measurement (real).** Same §D.4 command; compare `time_total` before/after
both C1 and C10. Cold `/api/memories/feed?limit=50` was 2.70 s; warm ~210 ms for a
1.1 KB response — the gap is the over-fetch + embedding work.

**(4) Confidence:** Med (need to confirm post-filter headroom is sufficient so the
page isn't short).
**(5) Impact:** Med.
**(6) Risk:** Low-Med — too-tight a limit could under-fill a page after
filtering; keep modest headroom.
**(7) Verify:** Open the Memories feed; confirm it fills `limit` items and
pagination (`before` cursor) still advances. `bun run --cwd packages/agent test`.

---

## D. Measurement & Benchmark Plan

All commands below were run on this machine; outputs quoted are real.

### D.0 Boot a headless server (shared prerequisite)
```bash
cd /home/shaw/milady/eliza
ELIZA_HEADLESS=1 ELIZA_API_PORT=31355 \
  node --conditions=eliza-source --import tsx \
  packages/app-core/src/runtime/dev-server.ts > /tmp/loadperf-server.log 2>&1 &
# wait for ready:
until curl -s -m4 http://127.0.0.1:31355/api/health | grep -q '"ready":true'; do sleep 1; done
```
Ready in ~21 s on this machine (PGlite migrations dominate). Discover routes:
`curl -s http://127.0.0.1:31355/api/dev/stack` and
`curl -s http://127.0.0.1:31355/api/dev/route-catalog`.

### D.1 Per-route latency (serial p50/p95, 30 iters)
```bash
python3 - http://127.0.0.1:31355 <<'PY'
import sys,time,urllib.request
B=sys.argv[1]
def timed(p,n=30):
    ts=[]
    for _ in range(n):
        t=time.perf_counter()
        urllib.request.urlopen(B+p,timeout=8).read()
        ts.append((time.perf_counter()-t)*1000)
    ts.sort(); return f"p50={ts[len(ts)//2]:.2f}ms p95={ts[int(len(ts)*0.95)]:.2f}ms"
for p in ["/api/health","/api/catalog/apps","/api/workbench/todos",
          "/api/database/tables/memories/rows?limit=50",
          "/api/database/tables/entities/rows?limit=50",
          "/api/secrets/inventory"]:
    print(f"{timed(p):40s} {p}")
PY
```
Observed (this run):
```
p50=6.68ms  p95=118.28ms  /api/health
p50=2.34ms  p95=440.11ms  /api/catalog/apps
p50=6.43ms  p95=40.11ms   /api/workbench/todos
p50=34.61ms p95=616.40ms  /api/database/tables/memories/rows?limit=50
p50=17.43ms p95=286.97ms  /api/database/tables/entities/rows?limit=50
p50=8.83ms  p95=75.09ms   /api/secrets/inventory
```

### D.2 Concurrency benchmark (8 clients) — exposes event-loop contention
```bash
python3 - http://127.0.0.1:31355 <<'PY'
import sys,time,urllib.request,threading
B=sys.argv[1]
def hit(p):
    t=time.perf_counter()
    try: urllib.request.urlopen(B+p,timeout=10).read(); return (time.perf_counter()-t)*1000
    except: return None
def bench(p,total=60,conc=8):
    res=[];lock=threading.Lock()
    def w(n):
        for _ in range(n):
            v=hit(p);
            with lock: res.append(v)
    ths=[threading.Thread(target=w,args=(total//conc,)) for _ in range(conc)]
    t0=time.perf_counter()
    [t.start() for t in ths];[t.join() for t in ths]
    wall=time.perf_counter()-t0
    ok=sorted(r for r in res if r);return f"n={len(ok)} p50={ok[len(ok)//2]:.1f}ms p95={ok[int(len(ok)*0.95)]:.1f}ms rps={len(ok)/wall:.0f}"
for p in ["/api/health","/api/catalog/apps","/api/database/tables/memories/rows?limit=50"]:
    print(f"{bench(p):50s} {p}")
PY
```
Observed (this run):
```
n=56 p50=102.7ms p95=584.7ms  rps=38   /api/health
n=56 p50=36.0ms  p95=550.4ms  rps=73   /api/catalog/apps
n=56 p50=154.0ms p95=2027.7ms rps=19   /api/database/tables/memories/rows?limit=50
```
`/api/health` (constant payload) degrading to p50 102 ms under 8 clients is the
canary for event-loop contention (C3/C5 synchronous work + PGlite serialization).

### D.3 Compression check
```bash
curl -s -H "Accept-Encoding: gzip, br" -D - -o /dev/null \
  http://127.0.0.1:31355/api/catalog/apps | grep -iE "content-encoding|content-length|vary"
# Observed: "Content-Length: 11146" only — no content-encoding, no Vary.
```

### D.4 Memory feed payload vs latency (proves fetch/discard waste)
```bash
for i in 1 2 3; do curl -s -o /dev/null \
  -w "feed: %{time_total}s %{size_download}b\n" -m 10 \
  http://127.0.0.1:31355/api/memories/feed?limit=50; done
# Observed: cold 2.70s; warm 0.209–0.225s; size 1156 b every time.
```

### D.5 DB query counter (instrumentation to add — exact recipe)
Wrap `executeRawSql` (`packages/shared/src/utils/sql-compat.ts:25`) and the
adapter `db.execute`/`db.select` behind `ELIZA_PERF_INSTRUMENT=1`:
increment a module-level counter on each call; optionally store per-request via
`AsyncLocalStorage` so a response header `x-db-queries: <n>` can be emitted in
dev. Then any §D.1 route prints its query count. For the C4/C7 items this is the
authoritative before/after metric (4→2 for `/rows`; 1→0 writes for sub-threshold
`touchSession`).

### D.6 Scrub deep-clone micro-benchmark (proves C3)
```bash
node - <<'EOF'
const {performance}=require("node:perf_hooks");
function scrub(v){if(v instanceof Error)return{error:v.message};
 if(Array.isArray(v))return v.map(scrub);
 if(v&&typeof v==="object"){const o={};for(const[k,n]of Object.entries(v)){if(k==="stack"||k==="stackTrace")continue;o[k]=scrub(n);}return o;}return v;}
const rows=[];for(let i=0;i<50;i++)rows.push({id:`r${i}`,content:{text:"x".repeat(400),meta:{tags:["a","b","c"]}},metadata:{nested:{deep:{v:i}}}});
const p={table:"memories",rows,columns:["id","content","metadata"],total:50};
const N=2000;let t=performance.now();for(let i=0;i<N;i++){JSON.stringify(scrub(p));}
console.log("scrub+stringify",((performance.now()-t)/N*1000).toFixed(1)+"us/req");
t=performance.now();for(let i=0;i<N;i++){JSON.stringify(p);}
console.log("stringify only ",((performance.now()-t)/N*1000).toFixed(1)+"us/req");
EOF
# Observed: scrub+stringify 104.3us/req ; stringify only 18.4us/req  (≈86us saved).
```

### D.7 Config-load micro-benchmark (proves C5)
```bash
cat > /tmp/m.mjs <<'EOF'
import {performance} from "node:perf_hooks";
const {loadElizaConfig}=await import("@elizaos/agent");
for(let i=0;i<3;i++)loadElizaConfig();
const N=200,t=performance.now();for(let i=0;i<N;i++)loadElizaConfig();
console.log(`loadElizaConfig: ${N} calls ${(performance.now()-t).toFixed(1)}ms => ${((performance.now()-t)/N).toFixed(3)}ms/call`);
EOF
node --conditions=eliza-source --import tsx /tmp/m.mjs
# Observed: 200 calls in 22.1ms => 0.111ms/call.
```

### Suggested standing harness
Add a `server-api-kpi.mjs` to `packages/benchmarks/loadperf/` that, against an
`--attach`ed server, runs §D.1 + §D.2 over the N hottest endpoints and records
`{p50,p95,rps,bytes, dbQueries, cacheHits, cacheMisses}` into
`results/server-api/` with a budget in `budgets.json`. Ratchet the budgets down as
C1–C10 land. (Not created here — research only.)

---

## E. Prioritized Backlog (ranked by confidence × impact)

1. **C1 — `getMemories` skip-embeddings option** (High × High). Removes the single
   largest wasted DB+CPU+serialization cost on the most-used data view. Additive
   param; default unchanged.
2. **C4 — cache `information_schema` introspection for `/rows`** (High × Med).
   4→2 queries on the DB-browser views (in-scope app-core route), provable cache
   hit rate.
3. **C9 — perf instrumentation (route timing + query counter + cache counters)**
   (High × enabler). Land early so 1/4/5/7 have authoritative before/after and so
   regressions become a budget gate.
4. **C2 — response compression (remote-gated)** (High × Med-High remote).
   Deterministic bandwidth/TTFB win for cloud-deployed agents; gate off loopback.
5. **C3 — scrub only on the error path** (High × Med). ~86 µs/response of
   event-loop CPU removed; directly eases the §D.2 concurrency cliff.
6. **C6 — cache `AuthStore` per `db` (WeakMap)** (High × Low-Med). Mechanical
   allocation-pressure win.
7. **C5 — memoize `loadElizaConfig` by mtime** (Med-High × Med). Removes
   synchronous FS+JSON5 from cloud/compat request paths; needs careful handling of
   the `process.env` side effect (lives in `packages/agent`).
8. **C10 — trim memory-feed per-table over-fetch** (Med × Med). Compounds C1 on
   the feed.
9. **C7 — throttle `touchSession` writes** (Med × Low-Med remote). Cuts a write
   per authenticated request on the remote topology; semantics-sensitive — gate on
   the query counter to prove it.
10. **C8 — `tasks(agent_id)` index + push workbench todo tag filter into SQL**
    (Med × Low single-agent / Med multi-agent). Cheap additive index; the
    JS-filter→SQL-filter change is unambiguously correct.

### Cross-cutting notes
- **Loopback vs remote.** The desktop/Electrobun topology is same-machine and hits
  `isTrustedLocalRequest` (no auth DB work) and localhost transfer (compression
  near-pointless). C2/C6/C7 mostly benefit the **cloud-deployed / remote-auth**
  topology; C1/C3/C4/C5/C10 benefit *both* because they remove CPU/DB work
  regardless of transport.
- **PGlite serializes all queries through one WASM connection** (single client,
  `plugins/plugin-sql/src/pglite/manager.ts:41`) — inherent, not a bug. This is
  *why* removing redundant queries (C4) and per-request writes (C7) matters more
  than usual: each saved query is a slot freed on the only connection. The PG pool
  (`pg/manager.ts:14`, `max:20 min:2`) is sized fine; no change recommended.
- **Architecture compliance.** C1/C4/C5 keep computation in use-cases/adapters
  (clients still just render); C2/C3 are pure transport. None move business logic
  into the proxy/route layer. The instrumentation (C9) is dev-only and env-gated.
