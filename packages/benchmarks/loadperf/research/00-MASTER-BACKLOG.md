# Load/Perf — Master Optimization Backlog (synthesis of reports 01–08)

Consolidates the eight area reports into one deduplicated, prioritized plan.
Each item: source report, evidence, confidence, impact, risk, how to measure
(real before/after), how to verify it didn't break, and collision risk with the
concurrent perf effort also active on `develop`.

Measurement contract + correctness gate: see `../VERIFICATION.md`.

---

## 0. Corrected baseline truth (supersedes the old BASELINE.md numbers)

- **Bundle (report 01).** The old "2.33 MB duplicate-lib FAIL" was a **stale
  watch-mode dist** artifact (`vite.config.ts` `emptyOutDir: !desktopFastDist`
  leaves Electrobun fast-dist uncleaned, layering 3 build generations). A clean
  `build:web` ships **total 3.75 MB brotli / eager first-paint 1202.6 KB brotli /
  initial entry 1104.4 KB brotli (5.23 MB raw)** and PASSES all five bundle
  budgets (incl. the new `eagerGraphBrotli`). Real dup-waste ≈ 0.30 MB. **Measure
  only clean `build:web` output, never a watch-mode dist.**
- **Boot (report 03).** The committed `results/boot/latest.json` (readyMs=70) is a
  **false PASS**: `lib.mjs` treats HTTP 200 with `ready===undefined` as ready, so
  it timed the API bind, not agent readiness. **Real cold boot ≈ 28.4 s (FAILS
  the 25 s budget)**, RSS ≈ 1272 MB (passes). Fix the gate before trusting any
  boot delta.
- **Leaks (report 07).** A real 72-navigation probe measured **+0.00 MB heap / +0
  listeners** — the client/server are already lifecycle-hardened. No leak hunt;
  the work is a regression gate + 2 small unbounded caches.
- **Already handled by the concurrent effort (do NOT redo):** phonemizer
  single-chunk dedupe (`8a6114be47`), parallelized plugin view builds
  (`2e6761b8fc`), embedding-model warmup in deferred phase (`c7a13515a5`),
  eager-vs-lazy bundle KPI (`46218dc265`).

---

## 1. Cross-report consensus (multiple agents independently flagged)

| Theme | Reports | Verdict |
| --- | --- | --- |
| React mount blocked behind full plugin init (`main.tsx` awaits `initializeAppModules()` before `mountReactApp()`) | 01, 08 | Biggest TTI lever; **collision risk** (concurrent frontend/boot work) |
| No list virtualization anywhere (chat/logs/memories) | 02, 08 | Real; client smoothness on big sessions |
| No response compression / cache headers (ETag, Cache-Control) | 05, 06, 08 | Real; mostly remote-topology + SW |
| Unbounded caches (stateCache, bundleModuleCache) | 04, 07 | Real; bounded LRU fixes |
| No perf instrumentation (route timing, query/cache counters, render counts) | 02, 04, 06, 07 | Enabler — needed for "real not estimated" deltas |

---

## 2. Implementation waves (ordered by safety × value × low-collision)

Collision legend: 🟢 isolated (core/server/runtime internals) · 🟡 some overlap ·
🔴 high overlap with active concurrent frontend/boot/build commits.

### WAVE 1 — Core runtime CPU/GC (report 04) 🟢 + trivial wins
Pure, referentially-transparent recompute removals in `packages/core/src`. No
behavior change. Gate: `bun run --cwd packages/core test` + per-item micro-bench.

| ID | Item | Evidence | Measured | Conf |
| --- | --- | --- | --- | --- |
| W1.1 | Gate `estToken` debug eval behind level check | `runtime.ts:5436,5445,5611` | −92.9 µs/call | High |
| W1.2 | Memoize action catalog (actions-version+locale key) | `services/message.ts:2418`, `action-catalog.ts:128` | −348.8 µs/msg | High |
| W1.3 | BM25: precompute per-action tokens + `Set.has` | `action-retrieval.ts:523-536` | 136.9→37.7 µs/msg | High |
| W1.4 | Template cache: key by raw template (don't transform pre-lookup) | `utils.ts:145-164` | 17.83→0.01 µs/call | High |
| W1.5 | `stateCache` bounded LRU + end-of-turn evict (the one leak) | `runtime.ts:733,3682` | ~23 MB→flat @5k msg | High |
| W1.6 | `getSetting` early-return before SHA-256 for non-encrypted | `settings.ts:180-203` | 1.338→0.048 µs (28×) | High |
| W1.7 | `context-hash` use `digest("hex")` | `context-hash.ts:31-39` | 4.48→1.67 µs (2.7×) | High |
| W1.8 | Precompile redaction regexes (16 default + per-secret) | `security/redact.ts:98-100,231-235` | −16 RegExp/call, −13% CPU | High |
| W1.9 | F8/F10/F11/F12 micro (replaceAll guard, provider timeout churn, `.some`→Set, stray `await`) | report 04 §C | small | High |
| W1.0 | **Delete `stats.html` from prod build** (report 08 X7) | `vite.config.ts:1621-1627` | −2.24 MB shipped | High |

### WAVE 2 — Server API/DB (report 06) 🟢
`packages/app-core/src/api`, `packages/agent/src/api`, `plugin-sql`. Gate:
app-core/agent tests + new route-timing/query-count instrumentation.

| ID | Item | Evidence | Measured | Conf |
| --- | --- | --- | --- | --- |
| W2.1 | **Perf instrumentation** (route timing + query counter + cache hit/miss, env-gated) → enables real deltas | report 06 F3 | enabler | High |
| W2.2 | `scrubStackFields` only on error path (stop deep-cloning every OK response) | `api/response.ts:31` | −86 µs/response | High |
| W2.3 | `getMemories` `includeEmbedding:false` for list views | `plugin-sql/.../memory.store.ts:48-66,92`, `memory-routes.ts:257` | 210ms→faster, drop 384-float×N | High |
| W2.4 | Memoize `loadElizaConfig()` by mtime | `agent/src/config/config.ts:98` | −sync FS reads/req | High |
| W2.5 | Memoize `information_schema` introspection per process | `database-rows-compat-routes.ts:51,83` | 4 queries→2, 17-35→2-6ms | Med-High |
| W2.6 | Response compression (gate on remote bind host; exclude SSE) | `api/response.ts:23` | 11KB→~2KB | Med-High (remote) |
| W2.7 | `tasks.agent_id` index + push todo tag filter into SQL | `plugin-sql/.../schema/tasks.ts` | multi-agent | Low-Med |
| W2.8 | Cache `AuthStore` in WeakMap + throttle `touchSession` | `api/auth.ts:394`, `auth/sessions.ts:180` | remote | Low-Med |

### WAVE 3 — Network & data sync (report 05) 🟡
`client-base.ts`, `server.ts` WS, `chat-routes.ts`, hydration hooks. Gate:
ui-smoke chat + multi-window specs + `chat-network-trace.mjs`.

| ID | Item | Evidence | Measured-by | Conf |
| --- | --- | --- | --- | --- |
| W3.1 | HTTP chat-path idempotency (read `clientMessageId`, share `isDuplicateWsMessage`) — the documented TODO | `conversation-routes.ts:1473`, `chat-routes.ts` | dup-send trace | High |
| W3.2 | Drop unconditional full refetch after each chat turn (stream already delivered text) | `useChatSend.ts:833-834,861` | 3→1 req/turn | High |
| W3.3 | WS reconnect cursor (`lastEventId`) instead of replaying `slice(-120)` every connect | `server.ts:4052` | statesync-kpi | High |
| W3.4 | Parallelize boot hydration waterfall (`Promise.all`) | `startup-phase-hydrate.ts:178-222` | boot-kpi/trace | High |
| W3.5 | Visibility-gate hidden-tab polls (connector/accounts/views/auth) | hooks per report 05 F7 | idle trace | Med |
| W3.6 | In-flight GET coalescing + small SWR cache | `client-base.ts:683` | trace | Med |
| W3.7 | ETag/304 on conversation GETs | `conversation-routes.ts:1076,1161` | conditional trace | Med |

### WAVE 4 — React smoothness (report 02) 🟡
`packages/ui` chat + context. Gate: `react-render-kpi.mjs` (6 scenarios) +
ui-smoke chat + perf-load-kpi.

| ID | Item | Evidence | Conf |
| --- | --- | --- | --- |
| W4.1 | Coalesce streaming tokens to one rAF commit/frame | `useChatSend.ts:778`, `useStreamingText.ts:130` | High |
| W4.2 | `MessageContent` stop subscribing to God `AppContext` (prop-drill the 2 callbacks) | `MessageContent.tsx:1042` | High |
| W4.3 | Fix defeated `memo(ChatMessage)` (useCallback inline props) — land with W4.2 | `ChatView.tsx:595-603` | High |
| W4.4 | O(n²) reply lookup → id→message Map | `chat-transcript.tsx:197` | High |
| W4.5 | Virtualize logs list | `LogsView.tsx:271` | High |
| W4.6 | Virtualize chat transcript + message cap | `chat-transcript.tsx:193` | Med |
| W4.7 | `startTransition` on view switch + `useDeferredValue` transcript | `DynamicViewLoader` | Med |
| W4.8 | Decompose God `AppContext` (stable-actions ctx → domain slices → selectors) | `AppContext.tsx:1924,2386` | Med (root cause, larger) |

### WAVE 5 — Boot & frontend architecture (reports 01, 03) 🔴 (coordinate)
High collision with concurrent boot/frontend commits — verify current state
before editing, keep diffs surgical.

| ID | Item | Evidence | Conf |
| --- | --- | --- | --- |
| W5.0 | **Fix boot-KPI false-PASS** (require explicit `ready:true`, report median/p95) | `lib.mjs:121`, boot-kpi.mjs | High (do first in this wave) |
| W5.1 | `setImmediate` yields between deferred plugin imports (unblock readiness broadcast) | `eliza.ts:4860`, `dev-server.ts:200,223` | High |
| W5.2 | Move `scheduleRuntimeBootstrap` before cosmetic banner/pairing block | `dev-server.ts:481,517` | High |
| W5.3 | Hash (not double-serialize) `computeVerdictFingerprint` | `plugin-resolver.ts:1338` | Med |
| W5.4 | three.js off boot-critical path (don't read `companionModule.THREE` at boot) | `main.tsx:525-528` | Med |
| W5.5 | Add `modulepreload` for eager dep chunks (kill request waterfall) | clean `index.html` | Med |
| W5.6 | Don't statically bake English i18n into entry | `messages.ts:1` | Med |
| W5.7 | Mount React before awaiting full plugin init (skeleton-first) | `main.tsx:2185,2228` | Med (biggest TTI, riskiest) |

### WAVE 6 — Leak gate + caches + SW/compression (reports 07, 08) 🟡

| ID | Item | Evidence | Conf |
| --- | --- | --- | --- |
| W6.1 | Build `leak-client.mjs` + `leak-server.mjs` regression KPIs | report 07 §D | High |
| W6.2 | `bundleModuleCache` LRU cap (~24) + cleanup-on-evict | `DynamicViewLoader.tsx:56` | High |
| W6.3 | `wsSeenMessageIds` amortized/periodic eviction (kill O(n²) full-scan/msg) | `server.ts:3958-3973` | High |
| W6.4 | Service worker: precache/runtime-cache content-hashed `/assets/*` + immutable headers | `dist/sw.js:69-85` | Med |
| W6.5 | Brotli/gzip precompress dist + serve `Content-Encoding` (esp. Electrobun static server) | report 08 X9 | Med |
| W6.6 | `build.assetsInlineLimit` tune; drop redundant `.woff` (woff2-only) | report 08 X10 | Low-Med |

---

## 3. Execution principles (multi-actor `develop`)

1. Commit ONLY explicit paths (never `git add -A`); small, frequent commits; push when meaningful.
2. Measure before/after with the harness; median-of-3 for boot/frontend; claim only measured deltas.
3. Run the correctness gate (VERIFICATION.md §3) at wave boundaries; ratchet budgets down after wins lock.
4. Prefer 🟢 isolated waves first (1, 2) to bank low-risk real wins while the concurrent frontend/boot effort settles; coordinate before 🔴 Wave 5.
