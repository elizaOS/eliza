# Network & Data Sync — Optimization Research

Scope: the client↔server network boundary — the typed HTTP/WS client
(`packages/ui/src/api/client-base.ts` + `client-chat.ts`), the WS server and
broadcast fan-out (`packages/agent/src/api/server.ts`), the chat + conversation
HTTP routes (`packages/agent/src/api/chat-routes.ts`,
`conversation-routes.ts`), the boot/hydration waterfall and polling hooks
(`packages/ui/src/state/*`, `packages/ui/src/hooks/*`), tab-sync, and the
response-encoding layer (`packages/agent/src/api/dispatch-route.ts`).

All file:line citations are against `develop` as of 2026-06-01. Measurements use
the existing loadperf harness (`statesync-kpi.mjs`, `frontend-kpi.mjs`) plus one
new scripted-interaction network trace specified in section D. **No estimates** —
every finding lists the exact command that produces a before/after number.

---

## A. Critical Assessment

The transport layer is in good shape on the *primitives*: there is a real
per-connection WS model (`wsActiveConversations` WeakMap,
`server.ts:3945`), a conversation-scoped broadcast
(`broadcastWsToConversation`, `server.ts:4316`), a 30 s WS idempotency cache
(`wsSeenMessageIds`, `server.ts:3956`), client-side `msgId` stamping with
queued-resend dedupe (`sendWsMessage`, `client-base.ts:1000`), an
edge-triggered reconnect/resync hook (`onReconnect`, `client-base.ts:970`), and
cross-window UI mirroring via `BroadcastChannel` (`useTabSync.ts`). Push is
genuinely push — proactive messages and conversation updates arrive over WS and
are applied incrementally (`startup-phase-hydrate.ts:522`, `:565`), not polled.

But there are real, measurable inefficiencies, and they cluster into five
themes:

1. **The HTTP chat path has no idempotency.** The client *generates and sends*
   `clientMessageId` (`client-base.ts:1121`) but the server never reads it —
   `readChatRequestPayload` extracts only `prompt/channelType/images/source/
   metadata` (`conversation-routes.ts:1473`), and a grep of `chat-routes.ts`
   shows zero `clientMessageId` references. A retried/duplicated POST
   (double-click, reconnect-driven resend, proxy retry) double-generates an LLM
   turn. This is the documented-but-unshipped TODO from the brief
   (`client-base.ts:1114-1121`). The WS dedupe does **not** cover it — chat
   sends go over HTTP SSE, not WS.

2. **A guaranteed redundant full refetch after every chat turn.** After a
   successful streamed turn the client already has the complete assistant text
   (the stream emits `fullText`), yet it unconditionally calls
   `loadConversationMessages(convId)` (`useChatSend.ts:833-834`) — a full
   `GET …/messages` that returns up to **200** messages
   (`conversation-routes.ts:1181`) — *and* `loadConversations()`
   (`useChatSend.ts:861`). Two extra round-trips per message, the larger of
   which re-downloads the entire visible history, purely to catch the rare case
   where an action callback persisted an extra turn.

3. **No response compression and no HTTP caching.** The API `json()` helper
   writes raw `JSON.stringify` with `content-type` only — no `Content-Encoding`,
   no `ETag`, no `Cache-Control`, no `If-None-Match` handling anywhere in
   `dispatch-route.ts:259-296` or the route modules. Every conversation list,
   message list, config, and catalog payload ships uncompressed and is
   re-fetched in full even when unchanged. JSON compresses 5–10×.

4. **The WS event-buffer replay re-floods the client on every (re)connect.**
   `activateAuthenticatedConnection` replays `state.eventBuffer.slice(-120)`
   (`server.ts:4052`) on *every* connection — including each reconnect. After a
   short network blip the client receives up to 120 historical
   `agent_event`/`heartbeat_event` envelopes again, with no cursor/since filter.
   This inflates reconnect cost and per-broadcast skew under load and is the
   single biggest lever on the `statesync` KPI.

5. **Boot is a request waterfall, and several idle polls keep running.** The
   hydration sequence `await`s `getWalletAddresses` → `getConfig` →
   `getStreamSettings` → `hasCustomVrm` → `hasCustomBackground` strictly
   sequentially (`startup-phase-hydrate.ts:178-222`) when they are independent.
   Separately, four hooks poll on fixed intervals
   (`useConnectorAccounts` 30 s, `useAccounts` 30 s, `useAvailableViews` 30 s
   ×3 parallel fetches, `useAuthStatus` 5 min) with no
   document-visibility gate, so a backgrounded tab keeps making calls.

None of these is a correctness bug today; they are bandwidth, round-trip, and
skew costs that the harness can quantify and a careful fix can remove without
changing behavior. The architecture rules (BFF = auth+proxy, client displays
never computes, DTO fields required) are respected by the current code and must
stay respected by every fix below — in particular, the chat-dedupe fix must live
in the route layer, and the "skip refetch" fix must not move server computation
into the client (it only *stops re-pulling* data the stream already delivered).

---

## B. Optimization Catalog

| # | Optimization | Conf | Impact | Primary metric | File:line |
| - | ------------ | ---- | ------ | -------------- | --------- |
| 1 | HTTP chat-path idempotency: read+dedupe `clientMessageId` server-side | High | High | trace req-count (dup-send), correctness | `conversation-routes.ts:1473`, `client-base.ts:1121` |
| 2 | Drop the unconditional post-turn `loadConversationMessages` refetch (reconcile from stream; refetch only on action-callback signal) | High | High | trace req-count + bytes | `useChatSend.ts:833`, `useDataLoaders.ts:288` |
| 3 | gzip/br response compression on JSON routes | High | High | trace bytes, `jsTransferred` | `dispatch-route.ts:259` |
| 4 | WS event-buffer replay: gate by `lastEventId`/since on reconnect (don't re-send 120) | High | High | `statesync` reconnectMs + skewP95 | `server.ts:4052`, `:4030` |
| 5 | Parallelize the boot hydration waterfall (Promise.all the independent gets) | High | Med | trace req timing / boot readyMs | `startup-phase-hydrate.ts:178` |
| 6 | ETag + `If-None-Match` on conversation list & messages GETs | Med | Med | trace bytes (304s) | `conversation-routes.ts:1076`, `:1161` |
| 7 | Visibility-gate the fixed-interval polls (pause when `document.hidden`) | Med | Med | trace req-count over time | `useConnectorAccounts.ts:370`, `useAccounts.ts`, `useAvailableViews.ts:70`, `useAuthStatus.ts:137` |
| 8 | In-flight request coalescing / SWR cache for GETs (dedupe concurrent identical fetches; serve stale-while-revalidate) | Med | Med | trace req-count | `client-base.ts:683` (`fetch<T>`) |
| 9 | Collapse `useAvailableViews` 3× parallel fetches into one batched endpoint | Low | Low | trace req-count | `useAvailableViews.ts:94-98` |
| 10 | Per-message GET cursor (since/limit) instead of fixed limit:200 | Low | Med | trace bytes | `conversation-routes.ts:1181` |

---

## C. Detailed Findings

Each finding lists: (1) problem + evidence, (2) fix sketch, (3) real
before/after measurement, (4) confidence, (5) impact, (6) risk, (7) how to
verify nothing breaks.

### Finding 1 — HTTP chat path has no server-side idempotency (the documented TODO)

**(1) Problem + evidence.** The client generates a stable `clientMessageId` for
every chat send and includes it in the POST body:

```ts
// packages/ui/src/api/client-base.ts:1121
const clientMessageId = ElizaClient.generateMessageId();
const res = await this.rawRequest(path, { method: "POST", … body: JSON.stringify({
  text, channelType, clientMessageId, …images, …metadata }) … });
```

The comment at `client-base.ts:1114-1120` explicitly states the server-side
dedupe "should hook" in the chat route "where the request body is parsed."
It hasn't:

- `readChatRequestPayload` (called at `conversation-routes.ts:1465`) destructures
  `{ prompt, channelType, images, preferredLanguage, source, metadata }`
  (`conversation-routes.ts:1473-1480`) — **no `clientMessageId`**.
- `grep -n clientMessageId packages/agent/src/api/chat-routes.ts` → **no
  matches**. The field is dropped on the floor.
- The existing WS idempotency cache (`wsSeenMessageIds`, `server.ts:3956`) only
  guards WS messages; chat sends are HTTP SSE (`/api/conversations/:id/messages/
  stream`, `client-chat.ts:1057`), so they bypass it entirely.

Consequence: a double-submit (rapid Enter, mobile tap echo, an SSE client
auto-retry, or a reverse-proxy retry of a non-idempotent POST) generates **two
LLM turns** and persists two assistant memories — wasted inference + duplicate
UI bubbles.

**(2) Fix sketch.** Extend `readChatRequestPayload` to also return
`clientMessageId` (validated `string`, length ≤ 128). In the stream + non-stream
POST handlers, maintain a bounded `Map<string, { startedAt; resultRef }>` keyed
by `${roomId}:${clientMessageId}` with the same 30 s TTL eviction pattern
already used by `isDuplicateWsMessage` (`server.ts:3958-3973`) — extract that
helper to a shared `dedupe-cache.ts` so the WS and HTTP paths share one
implementation (satisfies the DRY-where-it-reduces-complexity rule). On a
duplicate within TTL: short-circuit before `ensureConversationRoom` /
generation, and replay the prior result (or, minimally, return `409`/no-op so
the client keeps its optimistic bubble). Keep all dedupe logic in the route
layer — never in the client or a proxy (architecture rule 4).

**(3) Measurement.** Use the new `chat-network-trace.mjs` (section D) which
fires the *same* `clientMessageId` twice back-to-back against a live server and
counts how many assistant memories are persisted:

```bash
LOADPERF_BASE_URL=http://127.0.0.1:31337 \
  node packages/benchmarks/loadperf/research/chat-network-trace.mjs --dup-send
```

Before: 2 generations / 2 persisted assistant turns for one logical send.
After: 1 generation / 1 persisted assistant turn. The trace asserts
`persistedAssistantTurns === 1`.

**(4) Confidence:** High. The gap is proven by grep; the fix mirrors an existing
in-repo pattern.

**(5) Impact:** High — removes duplicate inference cost (the most expensive thing
the system does) and a class of duplicate-bubble bugs.

**(6) Risk:** Low–Med. Must scope the key per-conversation and TTL it so a
legitimately-identical message sent 10 minutes later is *not* suppressed.
Replay-of-prior-result is the higher-effort variant; the no-op/409 variant is
safe and minimal.

**(7) Verify nothing breaks.** Existing chat tests:
`bun run --cwd packages/agent test -- chat-routes conversation-routes`;
add a dedupe unit test next to
`packages/agent/src/api/__tests__/persistence-after-done.test.ts`. Manual: send
a normal message (one bubble), then double-tap send (still one).

---

### Finding 2 — Unconditional full message refetch after every chat turn

**(1) Problem + evidence.** After a streamed turn completes, the assistant text
is already fully in local state (the stream delivers `fullText`, applied at
`useChatSend.ts:778-803`). Yet:

```ts
// packages/ui/src/state/useChatSend.ts:833-834
if (activeConversationIdRef.current === convId) {
  await loadConversationMessages(convId);   // full GET …/messages
}
…
void loadConversations();                    // useChatSend.ts:861 — full list GET
```

`loadConversationMessages` → `client.getConversationMessages` → `GET
/api/conversations/:id/messages` which returns **up to 200 messages**
(`conversation-routes.ts:1181`) with full per-message metadata. So every single
chat turn pays: 1 SSE stream + 1 full-history GET + 1 conversation-list GET. The
inline comment (`useChatSend.ts:831`) admits the refetch exists only to catch
action-callback turns "not mirrored by the optimistic streaming placeholder" —
an edge case, charged to every send.

**(2) Fix sketch.** Two options, both keep the client a pure consumer:
- *Preferred:* have the SSE `done` event include a small
  `{ extraPersistedTurns: ConversationMessage[] }` (only the turns the stream
  didn't already mirror, computed server-side in the use-case). The client
  appends those and skips the GET entirely. Server computes, client displays —
  architecture-clean.
- *Minimal:* only call `loadConversationMessages` when the `done` event signals
  extra persistence (e.g. `data.persistedExtraTurns === true`, already knowable
  server-side because action callbacks ran). Default path: no refetch.

`loadConversations()` after every send is also redundant — the
`conversation-updated` WS event (`startup-phase-hydrate.ts:565`) already pushes
title/order changes incrementally; keep `loadConversations()` only on the
title-generation branch (`useChatSend.ts:848-859`).

**(3) Measurement.** `chat-network-trace.mjs --turn` (section D) drives one chat
turn through a live server and counts requests + bytes during the turn:

```bash
LOADPERF_BASE_URL=http://127.0.0.1:31337 \
  node packages/benchmarks/loadperf/research/chat-network-trace.mjs --turn
```

Before: 3 requests/turn (`stream`, `messages` GET, `conversations` GET),
`messages` GET body = full history. After (default path): 1 request/turn
(`stream` only). The trace prints `requestsPerTurn` and
`bytesDownloadedPerTurn`; assert After `requestsPerTurn === 1`.

**(4) Confidence:** High — the redundant calls are unconditional and the data is
provably already present client-side.

**(5) Impact:** High — eliminates two round-trips per message, the larger
re-downloading the whole conversation, on the hottest path in the app.

**(6) Risk:** Med — must preserve the action-callback-extra-turn behavior. The
"server signals extra turns" variant is the safe way to keep it.

**(7) Verify nothing breaks.** `bun run --cwd packages/ui test -- useChatSend`
(`useChatSend.test.tsx` exists). Manual: send a message that triggers a tool
action with a visible follow-up turn → the follow-up still appears. Send a plain
message → exactly one user + one assistant bubble, no flicker.

---

### Finding 3 — No response compression on JSON routes

**(1) Problem + evidence.** The dispatch-route `json()` writes the body raw:

```ts
// packages/agent/src/api/dispatch-route.ts:259-265 (and :281-285)
json(data: unknown) {
  …headers["content-type"] = "application/json; charset=utf-8";
  writeChunk(JSON.stringify(data));   // no Content-Encoding
}
```

`grep -n "Content-Encoding|gzip|brotli|zlib|deflate" server.ts
conversation-routes.ts dispatch-route.ts` → **no matches**. Conversation lists,
200-message payloads, config, catalogs, and the WS-event REST mirror all ship
uncompressed. JSON is highly compressible (typically 5–10×).

**(2) Fix sketch.** Add a single negotiation point in `dispatch-route.ts`'s
`writeChunk`: if `Accept-Encoding` includes `br`/`gzip`, the payload is JSON, and
length exceeds a threshold (~1 KB), pipe through `zlib.brotliCompressSync` /
`gzipSync` and set `Content-Encoding` + `Vary: Accept-Encoding`. SSE streams
(`text/event-stream`) and already-compressed assets must be excluded — check the
content-type guard already present at `dispatch-route.ts:327`. One choke point,
no per-route changes.

**(3) Measurement.** Network trace records raw vs transferred bytes per route:

```bash
LOADPERF_BASE_URL=http://127.0.0.1:31337 \
  node packages/benchmarks/loadperf/research/chat-network-trace.mjs --boot
```

The trace issues each boot GET with `Accept-Encoding: br` and records
`content-length` + decoded length. Before: `content-encoding` absent,
transferred == raw. After: `content-encoding: br`, transferred ≈ raw/6 on the
list/messages payloads. Also reflected in `frontend-kpi.mjs` `jsTransferred`
only for served assets — the API JSON win shows in the trace, not the FE KPI
(which serves static dist). Report the per-route byte delta.

**(4) Confidence:** High — absence is proven; gain is deterministic for JSON.

**(5) Impact:** High on bandwidth (mobile / Cloud-routed), modest on latency for
small payloads. Biggest win on the 200-message GET.

**(6) Risk:** Low–Med. Must NOT compress SSE (would buffer the stream and break
token-by-token UX) — exclude `text/event-stream` explicitly. CPU cost of brotli
on large payloads is bounded by the size threshold; use gzip level 6 default and
brotli only when offered.

**(7) Verify nothing breaks.** `bun run --cwd packages/agent test`; manual: chat
stream still renders token-by-token (proves SSE excluded);
`curl -H 'Accept-Encoding: br' -i …/api/conversations` shows
`content-encoding: br` and decodes correctly.

---

### Finding 4 — WS event-buffer replay re-floods the client on every reconnect

**(1) Problem + evidence.**

```ts
// packages/agent/src/api/server.ts:4052-4055 (inside activateAuthenticatedConnection)
const replay = state.eventBuffer.slice(-120);
for (const event of replay) ws.send(JSON.stringify(event));
```

`activateAuthenticatedConnection` runs on *every* `connection`
(`server.ts:4063`) and after late auth (`server.ts:4080`). The client reconnects
with full backoff (`client-base.ts:883`) and re-auths on open
(`client-base.ts:790`), so each reconnect replays up to 120
`agent_event`/`heartbeat_event` envelopes with **no since/cursor**
(`pushEvent` keeps a 1500-deep buffer, `server.ts:3519-3522`). The client has no
client-side dedupe for these replayed events (the WS `msgId` dedupe is for
*outbound* client messages, not inbound events). Under the `statesync` KPI this
inflates `reconnectMs` (client 0 closes and reopens — section D) and, with N
clients, the broadcast skew because the server is busy fanning replay bursts.

**(2) Fix sketch.** Stamp each buffered envelope with the monotonic
`state.nextEventId` (already exists, `server.ts:3515`). Have the client send its
`lastEventId` as a query param on reconnect (it can track the max `eventId` it
has applied). On (re)connect, replay only `eventBuffer` entries with
`eventId > lastEventId`; on a *fresh* connect with no `lastEventId`, keep a
small replay (e.g. last 20) for context, not 120. This is the WS analogue of an
HTTP cursor and removes the duplicate burst.

**(3) Measurement.** Direct, with the existing KPI:

```bash
# start a server, then:
LOADPERF_BASE_URL=http://127.0.0.1:31337 LOADPERF_CLIENTS=6 \
  node packages/benchmarks/loadperf/statesync-kpi.mjs --json
```

`statesync-kpi.mjs` closes client 0 and times reconnect (`reconnectMs`), and
measures `skewP95Ms`/`desyncEvents` across the broadcast window. Before vs after
the cursor fix: compare `reconnectMs` and `skewP95Ms`. Budgets: skew p95 ≤ 400,
reconnect ≤ 6000, desync 0. To make the replay cost visible, pre-seed the buffer
by leaving the server running with autonomy/heartbeat events flowing before the
run (the buffer fills via `pushEvent`).

**(4) Confidence:** High on the mechanism; Med on the absolute KPI delta (depends
on buffer fill at measure time — the trace controls for it by warming first).

**(5) Impact:** High on `statesync` skew/reconnect under load; reduces redundant
inbound bytes on every flaky-network recovery (mobile).

**(6) Risk:** Med — a client that under-reports `lastEventId` could miss events.
Mitigate: the existing `onReconnect`/`RESYNC_EVENT` reconciliation
(`client-base.ts:970`, AppContext) already refetches authoritative state on
reconnect, so the replay is an optimization, not the source of truth — losing a
replayed event is recoverable.

**(7) Verify nothing breaks.** `bun run --cwd packages/agent test -- server`;
manual: drop the network (devtools offline) for 10 s, restore → live events
resume, no duplicated autonomous-event entries in the activity feed.

---

### Finding 5 — Boot hydration is a sequential request waterfall

**(1) Problem + evidence.**

```ts
// packages/ui/src/state/startup-phase-hydrate.ts:178-222 (sequential awaits)
deps.setWalletAddresses(await client.getWalletAddresses());   // :179
…
const cfg = await client.getConfig();                          // :190
…
const stream = await client.getStreamSettings();              // :204
…
if (await client.hasCustomVrm()) …                            // :215
if (await client.hasCustomBackground()) …                    // :218
```

These are independent reads; chaining them with `await` serializes 4–5 RTTs on
the critical boot path. (The first-run poll path already does the right thing —
`Promise.all([getFirstRunOptions, getConfig])`, `startup-phase-poll.ts:403` — so
the pattern is established.)

**(2) Fix sketch.** `Promise.all` the independent reads. `getStreamSettings`
overrides `getConfig`'s avatar index, but both can be fetched concurrently and
the override applied after both resolve (the override is pure local logic on the
two results). `getWalletAddresses` is fully independent. `hasCustomVrm` /
`hasCustomBackground` only run when `resolvedIdx === 0`, so fetch them
concurrently inside that branch. Keep `hydrateInitialConversationState`
(`:169`) first since the greeting depends on it.

**(3) Measurement.** `chat-network-trace.mjs --boot` (section D) records the wall
time between the first and last boot GET, and total boot-phase request count.
Before: getWallet→getConfig→getStream→hasVrm→hasBg serialized (sum of RTTs).
After: max(RTT) of the parallel group. Also reflected in `boot-kpi.mjs`
`readyMs` when run with `--attach` against the dev server:

```bash
LOADPERF_BASE_URL=http://127.0.0.1:31337 \
  node packages/benchmarks/loadperf/boot-kpi.mjs --attach
```

Report `readyMs` before/after and the trace's `bootCriticalPathMs`.

**(4) Confidence:** High — independence is clear from the code; the parallel
pattern already exists in the same file's sibling.

**(5) Impact:** Med — saves 3–4 serial RTTs on cold boot; larger on
high-latency/Cloud-routed connections.

**(6) Risk:** Low — ordering only matters for the avatar-index override, which is
deterministic given both results.

**(7) Verify nothing breaks.** `bun run --cwd packages/ui test -- startup-phase`;
manual: boot the desktop app, confirm the correct avatar/VRM and wallet address
render (no regression in selection precedence).

---

### Finding 6 — No ETag / conditional requests on conversation GETs

**(1) Problem + evidence.** `GET /api/conversations` (`conversation-routes.ts:1076`)
and `GET …/messages` (`:1161`) always serialize and send the full body; no
`ETag` is set and `If-None-Match` is never read (grep: no matches in the file).
So tab focus, reconnect-driven refetch, and the (to-be-removed in Finding 2)
post-turn refetch all re-download identical bytes.

**(2) Fix sketch.** Compute a weak ETag from a cheap signature already available
— for the list, the max `updatedAt` + count; for messages, the latest message
`id` + count (both derivable without hashing the whole body). Set `ETag`, and
when the request carries a matching `If-None-Match`, return `304` with empty
body. Centralize in a small helper invoked from these two GETs (don't add a
global middleware that would also touch mutation routes).

**(3) Measurement.** `chat-network-trace.mjs --conditional` issues each GET
twice, the second with the returned `ETag` as `If-None-Match`, and records the
second response's status + bytes:

```bash
LOADPERF_BASE_URL=http://127.0.0.1:31337 \
  node packages/benchmarks/loadperf/research/chat-network-trace.mjs --conditional
```

Before: second GET = 200 + full body. After: second GET = 304 + 0 body. Assert
`secondStatus === 304`.

**(4) Confidence:** Med — straightforward, but the signature must be a true
function of the rendered payload (e.g. message *text normalization* and Discord
enrichment change the body without changing ids; pick a signature that covers
those or version it).

**(5) Impact:** Med — saves full re-downloads on unchanged data; compounds with
Finding 3.

**(6) Risk:** Med — a too-coarse ETag serves stale data. Mitigate by including a
content-version counter bumped on any enrichment-affecting change, or only ETag
the list (low enrichment risk) first.

**(7) Verify nothing breaks.** Add a route test asserting 200-then-304;
`bun run --cwd packages/agent test -- conversation-routes`. Manual: open a
conversation, switch away and back → messages still current.

---

### Finding 7 — Fixed-interval polls keep running in a hidden tab

**(1) Problem + evidence.** Four hooks poll on `setInterval` with no
`document.hidden` / `visibilitychange` gate:

- `useConnectorAccounts.ts:66,370` — `DEFAULT_POLL_MS = 30_000`,
  `setInterval(… , pollMs)`.
- `useAccounts.ts:73` — `DEFAULT_POLL_MS = 30_000`.
- `useAvailableViews.ts:70` — `POLL_INTERVAL_MS = 30_000`, and each tick runs
  **3 parallel** `fetchViewList()` calls (`:94-98`, for `gui`/`tui`/`xr`).
- `useAuthStatus.ts:54,137` — `5 * 60 * 1000`.

The PTY poll *is* correctly gated (`startup-phase-hydrate.ts:324-331` only
re-polls while sessions are active, and re-hydrates on `visibilitychange`
`:363-366`) — so the gating pattern exists and just isn't applied to these four.

**(2) Fix sketch.** Wrap each interval tick in a `document.visibilityState ===
"visible"` guard and trigger an immediate refetch on the `visibilitychange` →
visible transition (so a returning user gets fresh data at once instead of
waiting up to 30 s). A tiny shared `useVisiblePoll(fn, ms)` hook
(`useDocumentVisibility` already exists, `hooks/useDocumentVisibility.ts`) would
DRY all four without a god-helper.

**(3) Measurement.** `chat-network-trace.mjs --idle=70000` opens the SPA against
a running dev server, backgrounds the page (`page.evaluate` to dispatch
visibility hidden / Playwright `page.bringToFront` on a second tab) and counts
requests over a 70 s window (covers ≥2 of the 30 s ticks):

```bash
node packages/benchmarks/loadperf/research/chat-network-trace.mjs \
  --url=http://127.0.0.1:2138 --idle=70000
```

Before: ~ (2×connector + 2×accounts + 2×3 views) ≈ 10 background requests / 70 s.
After: ~0. Report `idleBackgroundRequests`.

**(4) Confidence:** Med — behavior is clear; exact count depends on which hooks
are mounted on the active route.

**(5) Impact:** Med — pure waste removal for backgrounded tabs / multi-window
users; battery + bandwidth on mobile.

**(6) Risk:** Low — must refetch-on-focus so data isn't stale when the user
returns (the PTY hook already models this).

**(7) Verify nothing breaks.** `bun run --cwd packages/ui test -- useConnectorAccounts useAccounts useAvailableViews useAuthStatus`. Manual: background the
tab, confirm via devtools Network that polling stops; refocus, confirm an
immediate refresh.

---

### Finding 8 — No in-flight request coalescing / stale-while-revalidate cache

**(1) Problem + evidence.** `ElizaClient.fetch<T>` (`client-base.ts:683`) is a
thin wrapper over `rawRequest`; there is no per-path in-flight map and no
client cache. Concurrent callers of the same GET (e.g. two components mounting
that both call `getConfig`, or a reconnect resync racing a focus refetch) each
issue a separate HTTP request. There is no react-query/SWR in the app
(`grep -rl "react-query|@tanstack/react-query|swr" packages/app/src
packages/ui/src` → none) — every loader is hand-rolled `await client.x()`.

**(2) Fix sketch.** Add an opt-in coalescing layer for **idempotent GETs only**:
a `Map<cacheKey, Promise<T>>` of in-flight requests so concurrent identical GETs
share one network call, plus an optional short TTL stale-while-revalidate cache
keyed by path. Keep it explicit (callers pass `{ dedupe: true }` or use a
`getCached` variant) so mutations and chat are never cached. This is *not* a
full react-query adoption — just dedupe + SWR for the read hot-spots
(`getConfig`, `listConversations`, view list).

**(3) Measurement.** `chat-network-trace.mjs --boot` already counts total boot
requests; add a `--concurrent-config` mode that triggers two simultaneous
`getConfig` calls (mount race simulation) and counts how many hit the wire:

```bash
LOADPERF_BASE_URL=http://127.0.0.1:31337 \
  node packages/benchmarks/loadperf/research/chat-network-trace.mjs --concurrent-config
```

Before: 2 network requests. After: 1. Report `configRequestsForTwoCallers`.

**(4) Confidence:** Med — the absence is proven; the win depends on how often
concurrent identical GETs actually occur (boot + reconnect are the main cases).

**(5) Impact:** Med — removes duplicate in-flight GETs on boot/reconnect/focus
storms; foundation for optimistic-read UX.

**(6) Risk:** Med — caching reads can serve stale data if the TTL is wrong or a
mutation isn't invalidated. Keep it opt-in and short-TTL; never cache anything
behind a mutation.

**(7) Verify nothing breaks.** Unit-test the in-flight map (two callers → one
fetch, both resolve). `bun run --cwd packages/ui test`. Manual: change config in
one window → other window's next refetch reflects it (TTL bounded).

---

## D. Measurement & Benchmark Plan

### D.0 Prerequisites (one-time)

```bash
# Build the SPA (frontend KPI + trace serve static dist)
bun run --cwd packages/app build
# Playwright browser is already installed (~/.cache/ms-playwright/chromium-1223).
# Boot a dev server for the live-server KPIs/traces:
bun run dev          # API on :31337 (auto-shifts; confirm via GET /api/dev/stack)
# discover the actual port (never hardcode):
curl -s http://127.0.0.1:31337/api/dev/stack | head
```

### D.1 Existing KPIs (use as-is, before & after each relevant fix)

- **State-sync (Findings 4):**
  ```bash
  LOADPERF_BASE_URL=http://127.0.0.1:31337 LOADPERF_CLIENTS=6 \
    node packages/benchmarks/loadperf/statesync-kpi.mjs --json
  ```
  Records `skewP50Ms/skewP95Ms/desyncEvents/reconnectMs` to
  `results/statesync/`. Budgets in `budgets.json`: p95 ≤ 400 ms, reconnect ≤
  6000 ms, desync 0.

- **Frontend transfer/requests (context for Findings 2,3):**
  ```bash
  node packages/benchmarks/loadperf/frontend-kpi.mjs --url=http://127.0.0.1:2138
  ```
  Records `requestCount` (budget ≤ 120) and `jsTransferredBytes` (budget ≤
  3.5 MB). Note: serves/loads the SPA — captures asset bytes, not API-JSON
  bytes; API gains show in the trace (D.2), not here.

- **Boot (context for Finding 5):**
  ```bash
  LOADPERF_BASE_URL=http://127.0.0.1:31337 \
    node packages/benchmarks/loadperf/boot-kpi.mjs --attach
  ```
  Records cold `readyMs`.

### D.2 New scripted-interaction network trace — `chat-network-trace.mjs`

A new Playwright-driven trace (to live at
`packages/benchmarks/loadperf/research/chat-network-trace.mjs`) that attaches a
`page.on("request")` / `page.on("response")` recorder and runs scripted
interactions against a **running dev server**, classifying requests by URL and
summing `content-length` (and decoded length when `content-encoding` is set). It
is the authoritative before/after instrument for Findings 1, 2, 3, 5, 6, 7, 8.

Modes (each prints a JSON summary and writes `results/netTrace/<mode>-<ts>.json`):

| Mode | Drives | Reports |
| ---- | ------ | ------- |
| `--boot` | login + load to first idle | `bootRequestCount`, `bootBytesDownloaded`, `bootCriticalPathMs` (first→last boot GET), per-route `content-encoding` |
| `--turn` | send one chat message, await stream `done` | `requestsPerTurn`, `bytesDownloadedPerTurn` (Finding 2: 3→1) |
| `--dup-send` | POST the *same* `clientMessageId` twice | `persistedAssistantTurns` (Finding 1: 2→1) via a follow-up `GET …/messages` count |
| `--conditional` | GET list+messages twice w/ `If-None-Match` | `secondStatus` (Finding 6: 200→304) |
| `--concurrent-config` | two simultaneous `getConfig` | `configRequestsForTwoCallers` (Finding 8: 2→1) |
| `--idle=<ms>` | background the tab, observe | `idleBackgroundRequests` (Finding 7: ~10→0) |

Invocation pattern (mirrors `frontend-kpi.mjs`'s Playwright bootstrap and
`lib.mjs` `recordResult`):

```bash
LOADPERF_BASE_URL=http://127.0.0.1:31337 \
  node packages/benchmarks/loadperf/research/chat-network-trace.mjs --turn --json
```

Auth: reuse the synthetic local-agent token the harness already understands
(`LOADPERF_WS_TOKEN` / the boot-config token injected on the page) so the trace
logs in the same way the app does; for the cloud-frontend variant the
injected-ethereum JWT path documented in the root CLAUDE.md applies.

**Why a trace, not estimates:** request count and per-route transferred bytes
are observed directly from the browser's network events, so each finding's
"before" and "after" are reproducible numbers, not models.

### D.3 Per-finding measurement matrix

| Finding | Command | Metric (before → target) |
| ------- | ------- | ------------------------- |
| 1 | `chat-network-trace.mjs --dup-send` | `persistedAssistantTurns` 2 → 1 |
| 2 | `chat-network-trace.mjs --turn` | `requestsPerTurn` 3 → 1 |
| 3 | `chat-network-trace.mjs --boot` | per-route `content-encoding` none → `br`; `bootBytesDownloaded` ↓ ~5–6× on JSON |
| 4 | `statesync-kpi.mjs` (CLIENTS=6, warmed buffer) | `reconnectMs` ↓, `skewP95Ms` ↓ (≤ 400) |
| 5 | `chat-network-trace.mjs --boot` + `boot-kpi.mjs --attach` | `bootCriticalPathMs` ↓ (serial→parallel); `readyMs` ↓ |
| 6 | `chat-network-trace.mjs --conditional` | `secondStatus` 200 → 304 |
| 7 | `chat-network-trace.mjs --idle=70000` | `idleBackgroundRequests` ~10 → 0 |
| 8 | `chat-network-trace.mjs --concurrent-config` | `configRequestsForTwoCallers` 2 → 1 |

---

## E. Prioritized Backlog (ranked by confidence × impact)

1. **Finding 1 — HTTP chat-path idempotency** (High × High). Removes duplicate
   inference + duplicate bubbles; closes the documented TODO; shares the
   existing WS dedupe helper. *Do first.*
2. **Finding 2 — drop the post-turn full refetch** (High × High). Two fewer
   round-trips per message on the hottest path; the bigger one re-pulls whole
   history. Pairs naturally with a small `done`-event payload change.
3. **Finding 3 — JSON response compression** (High × High). One choke-point
   change in `dispatch-route.ts`; 5–10× on every list/messages/config payload.
   Must exclude SSE.
4. **Finding 4 — WS replay cursor on reconnect** (High × High-on-statesync).
   Biggest lever on the `statesync` KPI; safe because `onReconnect` resync is the
   real source of truth.
5. **Finding 5 — parallelize boot waterfall** (High × Med). Mechanical
   `Promise.all`; pattern already used in the sibling poll path.
6. **Finding 6 — ETag/304 on conversation GETs** (Med × Med). Compounds with #3;
   start with the list (low enrichment-staleness risk) before the messages GET.
7. **Finding 7 — visibility-gate the four polls** (Med × Med). Pure waste
   removal; reuse `useDocumentVisibility`; refetch-on-focus required.
8. **Finding 8 — in-flight GET coalescing + short SWR** (Med × Med). Foundation
   for optimistic reads; keep opt-in and read-only to avoid stale-data risk.
9. *(Low)* Finding 9 — batch `useAvailableViews` 3× fetch into one endpoint
   (Low × Low). Only worthwhile alongside #7.
10. *(Low)* Finding 10 — cursor/since on the messages GET (Low × Med). Most
    valuable after #2 removes the per-turn refetch and #6 adds conditional GETs.

**Cross-cutting note for implementers (other 7 agents are editing in parallel):**
Findings 1 and 4 both want a shared bounded-TTL dedupe/cursor helper — extract
`isDuplicateWsMessage` (`server.ts:3958`) into one module rather than copying it.
Finding 2's clean variant and Finding 6 both touch the conversation GET response
shape; coordinate so the `done`-event extra-turns payload and the ETag signature
are designed together. Nothing here moves computation into the client or the BFF
proxy — every fix either removes a redundant fetch, compresses an existing
payload, or dedupes an in-flight/duplicate request, preserving architecture
rules 2/3/4.
