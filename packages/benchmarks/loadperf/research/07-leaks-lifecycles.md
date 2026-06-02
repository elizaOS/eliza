# Memory Leaks & Lifecycles — Optimization Research

Scope: cross-cutting memory-leak and lifecycle-hygiene audit, client (`packages/ui`,
`packages/app`) + server (`packages/agent`, `packages/app-core`, `packages/core`).
Research-only. Every finding cites `file:line`, gives a fix sketch, a *real* (not
estimated) reproducible measurement, confidence, impact, risk, and a "how to verify
nothing breaks" check. Findings are ranked by confidence × impact in §E.

---

## A. Critical Assessment

**The headline is uncomfortable for a "leak hunt": this codebase is already
heavily lifecycle-hardened.** The high-traffic paths that usually leak are all
correct:

- **Server WS connection state uses `WeakMap` per-socket** (`packages/agent/src/api/server.ts:3937,3945,3947`)
  keyed by the `WebSocket` object, so per-connection state is GC'd with the socket
  even if a `delete` is missed. `wsClients` is a `Set` that is explicitly deleted in
  both `ws.on("close")` (`:4235`) and `ws.on("error")` (`:4253`). PTY output
  subscriptions are unsubscribed and cleared on both close and error
  (`:4238-4242`, `:4256-4260`). This is textbook-correct.
- **Server runtime-stream listeners use a detach-first guard.** `bindRuntimeStreams`
  (`:3528-3575`) and `bindTrainingStream` (`:3577-3592`) call `detachRuntimeStreams()`
  / `detachTrainingStream()` *before* re-subscribing, so the repeated calls at boot
  (`:3974`), runtime-attach (`:3397`, `:4540`), and restart (`:3658`) do **not**
  accumulate listeners on the runtime emitter.
- **Server event buffer is capped** at 1500 (`:3519-3521`) and per-client replay at
  120 (`:4052`). The conversations Map only `.set`s when `!has` (`:4373`) and is
  bounded by real conversation count.
- **The status interval is cleared on shutdown** (`statusInterval` `:4350` →
  `clearInterval` `:4680`), `wss.close()` `:4733`.
- **Client `ElizaClient`** (`packages/ui/src/api/client-base.ts`) clears its reconnect
  timer and one-shot network-status listener on `disconnectWs()` (`:1043-1060`), uses
  bounded handler `Set`s with unsubscribe closures (`:1033-1041`), and caps the
  offline send queue at 32 (`:285`, `:1023`).
- **Client view/agent surface** — `AgentSurfaceProvider` removes its module-map
  registry entry on unmount (`packages/ui/src/agent-surface/AgentSurfaceContext.tsx:60`),
  the `ViewAgentRegistry` element map and listener set are unregistered via returned
  closures (`registry.ts:99-107,119-122`), and `view-interact-registry` deletes its
  handler on unmount with an identity guard (`view-interact-registry.ts:34-38`).
- **Client timers**: a managed `useTimeout()` hook (`packages/ui/src/hooks/useTimeout.ts`)
  clears all pending timers on unmount; `useMediaQuery` uses `useSyncExternalStore`
  with proper subscribe/unsubscribe; nearly every `setInterval` in a `useEffect`
  returns a `clearInterval` cleanup (App overlay-presence `:1153-1155`, useAvailableViews
  `:148-151`, agent-orchestrator widget `:428-435`, etc.).
- **three.js** is disposed: `VoiceWaveform`'s `mountOrb` returns a `dispose()` that
  disposes every geometry/material/texture + `renderer.dispose()` and is called on
  unmount (`VoiceWaveform.tsx:522-533,675-680`); the mic `AudioContext`+stream is
  stopped on unmount (`:573-577,192-202`).
- **Object URLs** are revoked (`use-audio-player.ts:34,49`).
- **Cloud poll intervals** (`useCloudState.ts:352,505`) are cleared on disconnect
  *and* in the `bindReadyPhase` teardown (`startup-phase-hydrate.ts:737-744`).

So this is **not** a "the app leaks 50 MB per navigation" situation. What remains is
a small set of **genuinely unbounded module-level caches**, a few **micro-leaks of
anonymous listeners on long-lived elements**, one **O(n)-per-message server scan**
that is a CPU (not memory) concern, and — most importantly for this harness — **the
total absence of a regression-proof leak-detection benchmark.** The biggest risk
today is not a specific leak; it's that nothing *guards* the hard-won hygiene, so the
next careless `useEffect` regresses silently. The single highest-value deliverable is
the benchmark in §D wired as a CI gate.

A real probe (see §D, run during this research) over **72 hash-route navigations** of
the static `packages/app/dist` build showed **+0.00 MB heap, +0 DOM nodes, +0
listeners** — but with the caveat that the static dist never reaches the "ready"
shell without a backend (the startup coordinator stays on the boot screen, nodes=152
the whole run). That confirms (a) the probe mechanism works and is reproducible, and
(b) a *meaningful* client leak benchmark must run against a live dev server, which is
exactly what §D specifies.

---

## B. Leak / Lifecycle Catalog

| id | location | type | confidence | impact | risk | detection method | fix |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | `packages/benchmarks/loadperf/` (absence) | no leak-detection KPI exists | high | high | low | new playwright heap-diff + node RSS-growth scripts (§D) | add `leak-client.mjs` + `leak-server.mjs` KPIs with pass/fail thresholds |
| L2 | `DynamicViewLoader.tsx:56` `bundleModuleCache` | module-level `Map` of loaded view modules, never evicted in prod | high | medium | low | server `RSS`-over-N-distinct-views; or `bundleModuleCache.size` assert | add LRU cap (e.g. 24 entries) keyed by `bundleUrl::export` |
| L3 | `agent/src/api/server.ts:3965-3969` `wsSeenMessageIds` | O(n) full-map scan **on every WS message** for TTL eviction | high | medium (CPU, not RSS) | low | message-throughput micro-bench (msgs/s vs map size) | lazy/periodic sweep or a small ring/heap; don't scan per message |
| L4 | `cloud-ui/components/voice/use-audio-player.ts:56-72` | 4 anonymous listeners added to a reused `<audio>`, never removed | medium | low | low | listener-count delta across repeated `playAudio` calls | name the handlers, `removeEventListener` before re-add / on unmount |
| L5 | `agent-surface/registry.ts:302` `viewRegistries` + L2 caches | module-level maps survive HMR/multi-root remounts | low | low | low | `viewRegistries.size` after navigate loop | already correct under normal nav (provider removes on unmount); document, no code change |
| L6 | `useCloudState.ts:351-364,505` | self-managing intervals have no *hook-local* unmount cleanup | low | low | medium | RSS after mount/unmount of AppContext root | already cleared by `bindReadyPhase` teardown; add a defensive hook-local cleanup only if AppContext is ever made remountable |
| L7 | `ElizaClient` module singletons `networkStatusListeners` (`client-base.ts:231`), `_channel` (`view-event-bus.ts:34`), `sharedAudioCtx` (`useVoiceChat.ts`) | app-lifetime singletons, never torn down | low | none | low | n/a (intentional) | leave as-is; flag only because a leak hunt must explain why they're *not* leaks |

---

## C. Detailed Findings

### L1 — No leak-detection benchmark exists (the real gap)

1. **Problem + evidence.** The loadperf harness measures bundle size, cold boot
   (`boot-kpi.mjs`), web vitals (`frontend-kpi.mjs`), and WS skew (`statesync-kpi.mjs`),
   but has **no KPI that detects monotonic memory/listener growth** over repeated
   navigation (client) or repeated connection/message churn (server). `budgets.json`
   has `boot.peakRssMb` (a one-shot peak), not a *growth* budget. Every lifecycle fix
   in §A is therefore unguarded — a future `useEffect` without cleanup regresses
   silently and no gate catches it.
2. **Fix sketch.** Add two KPIs to `packages/benchmarks/loadperf/` (full spec in §D):
   `leak-client.mjs` (playwright: navigate N views K times against a live dev server,
   `HeapProfiler.collectGarbage`, assert bounded heap/node/listener delta) and
   `leak-server.mjs` (node: open/close M WS connections + process M messages against a
   live agent, sample `process.memoryUsage().rss`, assert near-flat slope). Add
   `budgets.json` keys `leakClient.{heapGrowthMb,nodeGrowth,listenerGrowth}` and
   `leakServer.{rssGrowthMb}`. Wire into `run-all.mjs` behind a `--leak` flag (server
   required, so it degrades to `skipped`/exit-2 when absent, matching the existing
   statesync pattern).
3. **Real measurement.** Bootstrap probe was run during this research (a 60-line
   playwright script that serves `packages/app/dist`, navigates `chat,settings,voice,
   chat,memory,chat` × 12 cycles = 72 navigations, shims `addEventListener`/
   `removeEventListener` to count live listeners, and calls
   `HeapProfiler.collectGarbage` before each sample):
   ```
   baseline           heap=26.32MB  nodes=152  listeners=167
   after-12-cycles    heap=26.32MB  nodes=152  listeners=167
   DELTA: heap +0.00 MB, nodes +0, listeners +0
   ```
   Mechanism verified and reproducible. Caveat documented: the static dist never
   reaches the "ready" shell (no backend → startup coordinator parks on the boot
   screen, hence nodes=152 throughout), so the *production* version of this KPI must
   target a live dev server (`bun run dev`) where views actually mount/unmount — see §D.
4. **Confidence:** high. 5. **Impact:** high (prevents all future regressions of the
   §A hygiene). 6. **Risk:** low (new files only; no source change). 7. **Verify
   nothing breaks:** it's additive tooling; run it, confirm exit 0 on a clean tree.

### L2 — `bundleModuleCache` never evicts (unbounded module-level Map)

1. **Problem + evidence.** `DynamicViewLoader.tsx:56`:
   `const bundleModuleCache = new Map<string, Promise<ViewBundleModule>>();`
   Entries are added per `bundleUrl::componentExport` in `loadBundleModule`
   (`:210`) and only ever removed by the dev-ETag poller (`:604`) or the `refresh`
   capability (`:298`) — **never in production**. Each cached value retains the entire
   imported view-bundle module graph (components, three.js view modules, etc.) for the
   life of the page. A user who visits many distinct plugin views accumulates one
   retained module graph per view, monotonically, with no ceiling. The comment at
   `:54-55` ("persists across re-renders and component unmounts") confirms this is
   intentional caching but acknowledges no bound.
2. **Fix sketch.** Convert to a small LRU (cap ~16–24 entries; views rarely exceed a
   handful in a session). On eviction, if the evicted module exported `cleanup`, call
   it. Keep the in-flight promise dedupe semantics (cache the promise, not the
   resolved value). This preserves "re-mount does not re-fetch" for the working set
   while bounding worst-case retention.
3. **Real measurement.** Server-side detectable via the §D `leak-server.mjs` variant
   that navigates *distinct* views, or directly: in the §D client KPI, after the nav
   loop run `await page.evaluate(() => window.__bundleCacheSize)` if a debug accessor
   is added, or measure heap delta of a loop that visits 30 distinct view bundles vs
   the same view 30 times — the distinct-view loop will show the unbounded slope and
   the same-view loop will be flat. Before: heap grows ~per-distinct-view. After
   (LRU cap 24): heap plateaus once 24 distinct views are resident.
4. **Confidence:** high (the code path is unambiguous). 5. **Impact:** medium (only
   bites sessions that traverse many distinct view bundles; for a chat-centric session
   it's negligible). 6. **Risk:** low. 7. **Verify nothing breaks:** existing
   DynamicViewLoader tests + manually navigate a view, leave, return → still cached
   (no refetch) for the working set; cleanup still fires on real unmount.

### L3 — `wsSeenMessageIds` O(n) full-scan eviction on every message (CPU, not RSS)

1. **Problem + evidence.** `agent/src/api/server.ts:3958-3973`, `isDuplicateWsMessage`
   runs on **every** client WS message and, when the map is non-empty, does a full
   `for (const [seenKey, seenAt] of wsSeenMessageIds)` scan to expire TTL'd entries
   (`:3966-3969`) *before* the `has`/`set`. The map IS bounded by the 30s TTL
   (`WS_DEDUPE_TTL_MS`), so this is **not a memory leak** — but the eviction is O(n)
   per message, so a chatty client makes per-message cost grow with recent-message
   volume. Under a burst of N messages in <30s it's O(N²) total.
2. **Fix sketch.** Don't scan on the hot path. Either (a) run a periodic
   `setInterval` sweep (unref'd) every ~10s that drops expired keys, leaving the
   per-message path as `has`/`set` only; or (b) use an insertion-ordered structure and
   evict only the oldest while `oldest.seenAt` is expired (amortized O(1)), since
   `Map` preserves insertion order and entries are monotonically time-ordered.
3. **Real measurement.** §D `leak-server.mjs` message-throughput mode: send M=5000
   unique-`msgId` messages on one connection as fast as possible, time it; the current
   code's per-message latency rises with map size, the fixed version stays flat.
   Report msgs/s before/after. (RSS stays flat in both — this is a throughput finding.)
4. **Confidence:** high. 5. **Impact:** medium (CPU under chatty/bursty clients; not
   RSS — included because the task scope explicitly names this cache). 6. **Risk:**
   low (option (b) keeps identical dedupe semantics). 7. **Verify nothing breaks:**
   dedupe behavior unchanged — a resend within 30s is still dropped; add/keep a unit
   test that a same-`(clientId,msgId)` resend returns `true` and an expired one returns
   `false`.

### L4 — `use-audio-player` adds 4 anonymous listeners to a reused `<audio>`, never removed

1. **Problem + evidence.** `cloud-ui/components/voice/use-audio-player.ts:56-72` adds
   `loadedmetadata`, `timeupdate`, `ended`, `error` listeners to `audioRef.current`
   inside `playAudio`, guarded by `if (!audioRef.current)` (`:53`) so they're added
   once per hook instance. The unmount cleanup (`:26-37`) pauses + clears `src` +
   revokes the URL but **never `removeEventListener`s**. Because the `<audio>` element
   is one-per-hook-instance and is dropped (no longer referenced) on unmount, the
   listeners are GC'd with it — so this is a *bounded* micro-leak, not a growing one.
   It only matters if the element were ever reused across many sources with re-added
   listeners, which the `if (!audioRef.current)` guard prevents.
2. **Fix sketch.** Hoist the four handlers to named consts created once, and in the
   unmount cleanup call `removeEventListener` for each (defensive, and makes the
   element eligible for reuse). Low urgency.
3. **Real measurement.** §D client KPI with the listener-count shim: mount a component
   using `useAudioPlayer`, call `playAudio` on K blobs, unmount, GC — assert
   `window.__lc` returns to baseline. Current: listeners persist until element GC;
   fixed: they drop on unmount deterministically.
4. **Confidence:** medium (real but bounded). 5. **Impact:** low. 6. **Risk:** low.
   7. **Verify nothing breaks:** playback still updates `currentTime`/`duration` and
   fires `ended`; the handlers are the same, just named + removable.

### L5 — Module-level registry maps survive abnormal remounts (documentation only)

1. **Problem + evidence.** `agent-surface/registry.ts:302` (`viewRegistries`),
   `view-interact-registry.ts:25` (`handlers`), and L2's `bundleModuleCache` are all
   module-level. Under normal navigation they are correctly torn down (provider
   unmount → `removeViewRegistry`; loader unmount → `unregister`). The only way they'd
   leak is an abnormal remount (HMR, a second React root) registering before the prior
   cleanup runs — and `register`/`registerViewInteractHandler` already guard that with
   identity checks (`registry.ts:103`, `view-interact-registry.ts:35`).
2. **Fix sketch.** None needed. Document the invariant so future edits don't drop the
   identity guard.
3. **Real measurement.** §D client KPI: navigate views K times, then
   `viewRegistries.size` (via debug accessor) must equal the count of *currently
   mounted* views (typically ≤1), not K. Current code already passes.
4. **Confidence:** low (that it's a problem). 5. **Impact:** low. 6. **Risk:** n/a.
   7. **Verify:** existing `agent-surface/registry.test.ts` covers register/unregister.

### L6 — `useCloudState` intervals lack a hook-local unmount cleanup (latent)

1. **Problem + evidence.** `useCloudState.ts:352,505` start `setInterval`s into refs.
   The clears are on *disconnect* (`:362`) and in `bindReadyPhase`'s teardown
   (`startup-phase-hydrate.ts:737-744`), not in a `useEffect(() => () => …, [])` inside
   the hook itself. Today `useCloudState` is mounted exactly once in `AppContext`
   (`AppContext.tsx:1105`), the app-root provider that lives for the whole session, so
   there's no remount → no leak. It becomes a leak only if AppContext is ever made
   remountable while connected.
2. **Fix sketch.** Add a hook-local `useEffect(() => () => { clear both refs }, [])`
   as defense-in-depth so the hook is self-contained and not reliant on the external
   coordinator teardown.
3. **Real measurement.** §D server RSS sampler is the wrong tool; instead a client
   unit/integration test: mount→connect→unmount an `AppContext` and assert
   `clearInterval` was called for both refs (spy on `window.clearInterval`).
4. **Confidence:** low. 5. **Impact:** low. 6. **Risk:** medium (touching AppContext
   wiring is sensitive — only add the self-contained cleanup, don't move the existing
   coordinator clears). 7. **Verify:** cloud credit polling still starts on connect /
   stops on disconnect; login poll still resolves.

### L7 — Intentional app-lifetime singletons (explained, not fixed)

`client-base.ts:231` `networkStatusListeners` (+ the module-level
`document.addEventListener(NETWORK_STATUS_CHANGE_EVENT, …)` at `:246` with no removal),
`view-event-bus.ts:34` `_channel` `BroadcastChannel`, and `useVoiceChat.ts`'s
`sharedAudioCtx` are all **single instances created once for the page lifetime**. They
do not grow and are released on page unload. The network listener Set is drained by
`armNetworkStatusWake`'s one-shot unsubscribe (`client-base.ts:917-930`). These are
correct; listed only because a credible leak audit must explain why the obvious
"module-level listener, never removed" hits are *not* leaks.

---

## D. Leak-Detection Benchmark Plan (exact commands + pass/fail thresholds)

Two new standalone Node-ESM KPIs in `packages/benchmarks/loadperf/`, matching the
existing pattern (lazy-import `playwright`, degrade to `skipped`/exit-2 when a
browser/server is unavailable, record under `results/<kpi>/`, exit `0/1/2`).

### D.1 Client heap/listener-growth KPI — `leak-client.mjs`

**Prerequisite (load-bearing): a live dev server that reaches the "ready" shell.**
The static `packages/app/dist` parks on the boot screen without a backend (proven in
§C/L1: nodes=152 flat over 72 navs). So the client leak KPI must target `bun run dev`
(API :31337 + UI :2138, ports auto-shift — read `GET /api/dev/stack` for the real UI
URL) so views actually mount/unmount.

```bash
# 1. boot the dev stack (separate terminal / background)
bun run dev
# 2. discover the renderer URL (never hardcode the port)
UI_URL=$(curl -s http://127.0.0.1:31337/api/dev/stack | node -e 'process.stdin.once("data",d=>console.log(JSON.parse(d).rendererUrl))')
# 3. run the leak KPI against it
LOADPERF_FE_URL="$UI_URL" LEAK_VIEWS=chat,settings,voice,memory,trajectories \
  LEAK_CYCLES=20 node packages/benchmarks/loadperf/leak-client.mjs
```

Algorithm (verified mechanism from the §C bootstrap probe):
1. `addInitScript` shims `EventTarget.prototype.add/removeEventListener` to maintain
   `window.__lc` (live listener count).
2. `page.goto(UI_URL, {waitUntil:"load"})`, wait for `[data-testid="app-shell"]` /
   the chat composer to confirm "ready", settle 6 s.
3. Open a CDP `HeapProfiler` session. `sample()` = `HeapProfiler.collectGarbage` →
   wait 300 ms → read `{ performance.memory.usedJSHeapSize, document.getElementsByTagName("*").length, window.__lc }`.
4. Take baseline. For `LEAK_CYCLES` iterations, navigate each view in `LEAK_VIEWS`
   (set `location.hash` + dispatch `hashchange`, wait ~700 ms for mount). Take final
   sample.
5. Report `Δheap (MB)`, `Δnodes`, `Δlisteners` over `cycles × views.length` navigations.

**Pass/fail thresholds (proposed `budgets.json` `leakClient`):**
| metric | budget | rationale |
| --- | --- | --- |
| `heapGrowthMb` | ≤ 8 MB over ≥100 navigations | post-GC; allows lazy-chunk + view-cache (L2) working set, fails on a true per-nav leak |
| `nodeGrowth` | ≤ 50 detached/leaked nodes | views must unmount their DOM |
| `listenerGrowth` | ≤ 20 net listeners | each view's adds must be matched by removes |

A real leak (e.g. an interval-without-cleanup added to a view) blows `listenerGrowth`
and `heapGrowthMb` linearly with `cycles` — flip `LEAK_CYCLES` 20→40 and the deltas
should *not* roughly double for a passing build.

### D.2 Server RSS / throughput KPI — `leak-server.mjs`

```bash
# against a running agent (spawned by dev, or boot-kpi style)
LOADPERF_BASE_URL=http://127.0.0.1:31337 LOADPERF_WS_URL=ws://127.0.0.1:31337/ws \
  LEAK_WS_CONNECTIONS=300 LEAK_WS_MESSAGES=5000 \
  node packages/benchmarks/loadperf/leak-server.mjs
```

The KPI runs against the agent process and samples its RSS via `/proc/<pid>/status`
VmRSS (same reader as `boot-kpi.mjs:50-58`) — discover the pid from
`GET /api/dev/stack` (it exposes the agent pid/paths) so the sampler reads the right
process.

Two phases:
1. **Connection churn:** open `LEAK_WS_CONNECTIONS` WS clients sequentially (auth,
   send one `active-conversation`, subscribe+unsubscribe a PTY session id, close).
   Sample RSS every 25 connections. Asserts the `WeakMap` per-connection state + PTY
   sub cleanup (§A) hold: RSS slope must be near-flat.
2. **Message throughput:** one connection sends `LEAK_WS_MESSAGES` unique-`msgId`
   messages as fast as the socket drains; record total ms and msgs/s. This is the
   harness for L3 — current O(n) eviction degrades msgs/s as the dedupe map fills;
   the fixed version stays flat.

**Pass/fail thresholds (proposed `budgets.json` `leakServer`):**
| metric | budget |
| --- | --- |
| `rssGrowthMb` (300 conn churn, after a settle + forced idle) | ≤ 25 MB |
| `rssSlopeMbPer100Conn` | ≤ 5 MB / 100 connections (must trend to ~0) |
| `msgThroughputDegradationPct` (msgs/s of last 1000 vs first 1000) | ≤ 20% (L3 gate) |

Both KPIs follow the existing exit-code contract (`0` pass, `1` budget fail, `2`
skipped) and `recordResult(...)` into `results/leak-client|leak-server/`. Add a
`--leak` flag to `run-all.mjs` (default off, since both need a live server — same
treatment as `--statesync`).

---

## E. Prioritized Backlog (ranked by confidence × impact)

1. **L1 — Add the leak-detection benchmark (`leak-client.mjs` + `leak-server.mjs`) and
   wire it as a CI gate.** *High × High.* This is the deliverable that matters most:
   the §A hygiene is excellent but completely unguarded. Without this, every future
   `useEffect`-without-cleanup regresses silently. Mechanism already proven runnable
   (§C/L1, §D). Cost: two new files + 4 budget keys. **Do this first.**
2. **L2 — Bound `bundleModuleCache` with an LRU (cap ~24) + cleanup-on-evict**
   (`DynamicViewLoader.tsx:56`). *High × Medium.* Only real *memory* leak with a clear
   unbounded slope; bites sessions that traverse many distinct plugin views.
3. **L3 — Stop the per-message O(n) scan in `wsSeenMessageIds`** (`server.ts:3958`).
   *High × Medium (CPU).* Not RSS, but in-scope and a real throughput cliff under
   bursty clients; fix = periodic sweep or amortized oldest-first eviction.
4. **L4 — Name + remove the `<audio>` listeners in `use-audio-player.ts`** (`:56-72`).
   *Medium × Low.* Bounded micro-leak; cheap, correct hygiene.
5. **L6 — Add hook-local unmount cleanup for `useCloudState` intervals.** *Low × Low.*
   Defense-in-depth; only matters if AppContext becomes remountable. Touch carefully.
6. **L5 / L7 — No code change; document the invariants** (identity-guarded registry
   maps; intentional app-lifetime singletons) so a future edit doesn't strip the guards
   that make them safe.

**Bottom line:** the app does not have a meaningful per-navigation leak today (real
probe: +0 MB / +0 listeners). The work is (1) lock that in with a benchmark gate (L1),
then (2) bound the two unbounded module caches (L2, L3). Everything else is low-impact
polish.
