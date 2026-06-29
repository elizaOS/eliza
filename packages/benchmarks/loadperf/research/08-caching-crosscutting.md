# Caching & Cross-Cutting High-Leverage Optimizations — Research

Scope: local caching layers, web-platform leverage, and ≥10 additional
cross-cutting optimizations for the `@elizaos/app` renderer (`packages/app`,
`packages/ui`, `packages/app-core`). Research-only — no source changes made here.
Every claim is cited to a real file:line and every optimization carries a *real,
reproducible* measurement command tied to the loadperf harness
(`packages/benchmarks/loadperf/{bundle,frontend,boot,statesync}-kpi.mjs`).

Measurement environment note: the on-disk `packages/app/dist` was being rebuilt
by a concurrent process during this research pass (the `index-*.js` hash in
`dist/index.html` — `index-DkvWMeGE.js` — did not match the files on disk, and
`bundle-kpi.mjs` crashed on a file that vanished mid-walk:
`ENOENT … dist/assets/PolymarketAppView-DcpDlBpo.js`). `brotli` is also not on
this host (`command -v brotli` → not found), so raw byte counts below are from
`stat`/`gzip` and the brotli figures are from the committed
`packages/benchmarks/loadperf/BASELINE.md` (captured 2026-05-31 on a quiet
checkout). **Every optimization's measurement section specifies the exact command
to run on a stable, freshly-built dist** — do not trust the numbers captured
during a live rebuild; rebuild first (`bun run --cwd packages/app build`) then
measure.

---

## A. Critical Assessment

The app already ships several good primitives: a service worker
(`packages/app/dist/sw.js`) with SWR/cache-first/network-first strategies, idle
route-chunk prefetch (`packages/ui/src/App.tsx:203`), a Vite `warmup` of the boot
graph (`packages/app/vite.config.ts:2337`), lucide per-icon tree-shaking, a
single `vendor-three` chunk, font `font-display: swap` + `unicode-range`
subsetting (`@fontsource/poppins/400.css`), and a module cache for dynamic
plugin imports (`packages/app/src/main.tsx:150-162`). Those are real and should
not be re-litigated.

What is *wrong* and high-leverage:

1. **The service worker caches almost nothing that matters.** It only intercepts
   `/api/views/:id/bundle.js`, `/api/views/:id/hero`, and the navigation shell
   (`packages/app/dist/sw.js:21-22,69-85`). The hashed JS/CSS in `/assets/*`
   (the entire ~7 MB brotli app) is **not** precached or runtime-cached, so a
   warm reload re-validates every chunk over the network. There is no offline
   app-shell precache list and no `Cache-Control: immutable` partner header.
2. **No HTTP cache headers are emitted for static assets.** The app-core API
   only sets `Cache-Control` on three routes, all `no-store`/`no-cache`
   (`packages/app-core/src/api/first-run-tts-route.ts:70`,
   `dev-compat-routes.ts:136,179`, `secrets-manager-routes.ts:257`). Hashed
   immutable assets get no `Cache-Control: public, max-age=31536000, immutable`,
   and the view-bundle/hero routes the SW relies on do not demonstrably emit
   `ETag` + `Cache-Control` (the SW's SWR/cache-first logic in
   `dist/sw.js:125,154` *assumes* `etag`/`date` headers exist).
3. **The 2.2 MB rollup-visualizer report ships to production.** `stats.html`
   (2,243,210 bytes) is written to `packages/app/dist/stats.html` on every build
   (`packages/app/vite.config.ts:1621-1627`) and is copied into the Electrobun
   renderer bundle
   (`packages/app-core/platforms/electrobun/build/.../renderer/stats.html`) and
   the OS image (`packages/os/linux/.../Resources/app/eliza-dist`). It is dead
   weight in every shipped artifact.
4. **~2.33 MB brotli of duplicate chunks** (the only failing bundle budget —
   `BASELINE.md:18`). Root cause: per-plugin *view-bundle* builds use
   `emptyOutDir: false` and each re-emit shared shim/runtime helper chunks
   (`packages/scripts/view-bundle-vite.config.ts:30`). On-disk this shows as 34×
   `web-*`, 30× `register-*`, 21× `ui-*`, 3× `mermaid-GHXKKRXX-*` logical chunks
   (measured: `ls dist/assets/*.js | sed -E 's/-[hash]\.js$//' | sort | uniq -c`).
5. **No list virtualization anywhere.** `grep -rln "react-window|react-virtual|
   @tanstack/react-virtual" packages/ui/src` → **zero hits**. The chat transcript
   renders every message with `.map()` (`chat-transcript.tsx:123,159,193`); logs,
   memories, and plugin lists are the same. Long conversations = O(n) DOM + long
   main-thread tasks.
6. **No web workers / OffscreenCanvas anywhere.** `grep -rln "new Worker|
   OffscreenCanvas|\?worker" packages/ui/src packages/app/src` → **zero hits**.
   The phonemizer (eSpeak NG WASM, ~742 KB raw / ~671 KB brotli —
   `phonemizer-*.js`), three.js, and markdown/mermaid parsing all run on the main
   thread.
7. **`mermaid` (~1.6 MB raw, shipped 2–3×) is pulled transitively by
   `streamdown`**, which is imported *statically* and eagerly in
   `packages/ui/src/cloud-ui/components/ai-elements/{memoized-chat-message,response}.tsx:10,7`.
   Mermaid diagrams are rare in chat; the whole graph loads regardless.
8. **The boot critical path serially blocks React mount on loading every app
   plugin.** `main()` awaits `initializeAppModules()` — companion, lifeops,
   task-coordinator, phone, steward, training + all side-effect modules
   (`packages/app/src/main.tsx:499-537,2185`) — *before* `mountReactApp()`
   (`main.tsx:2228`). FCP waits on the slowest plugin import.
9. **No `build.assetsInlineLimit` configured** (`vite.config.ts` has no such
   key), so Vite's default 4 KB base64 inlining applies — small assets become
   base64 in JS (un-cacheable, +33 % size, parsed as JS).
10. **`.woff` fallbacks ship alongside `.woff2`** (30 of each in dist). Every
    modern target (es2022, Chromium/WKWebView/Capacitor) supports woff2; the
    woff copies are dead weight.
11. **No precompressed `.br`/`.gz` artifacts** in dist (`ls dist/assets/*.br
    *.gz` → 0). Whether brotli is served depends entirely on the host; the
    Electrobun static server (`electrobun.config.ts`) shows no
    `Content-Encoding`/compression handling.

The frontend KPI budgets that these map to: `jsTransferredBytes` (≤3.5 MB),
`requestCount` (≤120), `longTasksMs` (≤2000), `fcpMs`/`lcpMs`
(`budgets.json:15-22`), plus bundle `maxDuplicateLibBytes` (the failing one) and
`totalAssetsBrotliBytes`.

---

## B. Optimization Catalog

Ranked by confidence × impact (highest first). C = confidence, I = impact.

| id | optimization | evidence (file:line) | C | I | risk | measurement | verification |
|----|--------------|----------------------|---|---|------|-------------|--------------|
| X1 | Stop shipping `stats.html` (2.24 MB) to prod/desktop | vite.config.ts:1621-1627; dist/stats.html=2,243,210 B | High | Med | none | `stat -c%s dist/stats.html`; assert absent after build | build still boots; bundle-kpi totalAssets drops |
| X2 | Precache hashed `/assets/*` in the SW + `immutable` Cache-Control | dist/sw.js:69-85 (assets not cached); app-core sets no asset Cache-Control | High | High | stale-cache if mis-versioned (hashes prevent it) | frontend-kpi 2nd load: `requestCount`, `jsTransferredBytes` | offline reload serves app; no stale chunk |
| X3 | Kill duplicate view-bundle helper chunks (~2.33 MB brotli) | view-bundle-vite.config.ts:30; BASELINE.md:18; `uniq -c` 34×web/30×register | High | High | view bundles must still resolve shared runtime | bundle-kpi `maxDuplicateLibBytes` | each view still loads (DynamicViewLoader) |
| X4 | Lazy-load `streamdown`→`mermaid` (~1.6 MB×2) behind a dynamic import | memoized-chat-message.tsx:10; response.tsx:7; mermaid 1.6 MB chunk | High | High | first markdown render shows brief fallback | bundle-kpi chunk list; frontend-kpi jsTransferred | chat renders markdown; mermaid still works on demand |
| X5 | Defer non-critical plugin init off the FCP critical path | main.tsx:499-537, 2185, 2228 | Med | High | a plugin surface not ready at first paint | frontend-kpi `fcpMs`/`lcpMs`; boot unaffected | all plugin surfaces appear after mount |
| X6 | Virtualize chat transcript + logs + memory + plugin lists | chat-transcript.tsx:123,159,193; no virtual lib | Med | High | scroll-restore / measure complexity | new long-task probe (below) + frontend-kpi longTasksMs | scrolling correct; messages visible |
| X7 | Move phonemizer (eSpeak WASM) + heavy parse to a Web Worker | no workers (grep=0); phonemizer-*.js ~742 KB raw | Med | High | worker bridge complexity | frontend-kpi longTasksMs during TTS warmup | TTS audio still produced |
| X8 | Drop `.woff`, keep `.woff2` only | 30 woff + 30 woff2 in dist; targets all support woff2 | High | Low | none on modern targets | `ls dist/assets/*.woff \| wc -l` before/after | text renders in Poppins |
| X9 | Emit `ETag` + `Cache-Control` on `/api/views/:id/{bundle.js,hero}` | dist/sw.js:125,154 assumes etag/date | High | Med | none | curl `-I` the route; check headers | SW SWR revalidate path fires |
| X10 | Precompress assets to `.br` at build + serve `Content-Encoding: br` | no .br/.gz in dist; electrobun.config.ts no encoding | Med | Med | host must negotiate encoding | compare transferred bytes (frontend-kpi jsTransferred) | assets decode + execute |
| X11 | Persist last-known app state to localStorage/IDB for warm paint | no query-cache/IDB state (grep=0 React Query/SWR) | Med | Med | stale data flash if not revalidated | new "time-to-first-meaningful-data" probe | data shows instantly, revalidates |
| X12 | Set `build.assetsInlineLimit: 0` (or low) to keep small assets cacheable | no assetsInlineLimit in vite.config.ts | Med | Low | +1 request per tiny asset | bundle-kpi totalAssets; frontend requestCount | assets load |
| X13 | Memoize markdown/code render output per message | streamdown re-renders; memoized-chat-message exists but markdown not memoized | Med | Med | memo key correctness | long-task probe during transcript scroll | rendered markdown unchanged |
| X14 | `loading="lazy"` + `decoding="async"` on offscreen images | 9 lazy hits, 0 `<img ` literal (JSX components) — audit needed | Med | Low | LCP image must NOT be lazy | frontend-kpi lcpMs; requestCount | hero image still eager |
| X15 | Debounce/throttle search-as-you-type + resize handlers | 14 debounce/throttle sites; useDeferredValue only 3 places | Med | Low | input latency feel | long-task probe while typing | search results update |
| X16 | Strip `.woff`/source-map/dead polyfills + esnext where safe | target es2022 (vite.config.ts:2167); no maps in prod dist | Low | Low | older-WebView regressions | bundle-kpi totalAssets | app boots in WKWebView/Chromium |

---

## C. Detailed Findings

Each finding lists: (1) problem/evidence, (2) fix sketch, (3) measurement,
(4) confidence, (5) impact, (6) risk, (7) verification.

### X1 — Stop shipping the 2.24 MB rollup-visualizer `stats.html` to production

1. **Problem / evidence.** `visualizer({ filename: "dist/stats.html", … })` runs
   on *every* build, including production, and writes the report straight to
   `dist/` (`packages/app/vite.config.ts:1621-1627`). Measured size:
   `stat -c%s packages/app/dist/stats.html` → **2,243,210 bytes**. It is then
   copied verbatim into the Electrobun renderer bundle
   (`packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev/Resources/app/renderer/stats.html`)
   and the Linux OS image
   (`packages/os/linux/elizaos/artifacts/amd64/elizaos-app/Resources/app/eliza-dist`).
   It is never referenced by `index.html` — pure dead weight in every shipped
   artifact, inflating installer/IPA/APK size and bundle-kpi `totalAssetsBrotli`.
2. **Fix sketch.** Gate the visualizer plugin behind an env flag
   (`process.env.ELIZA_BUNDLE_STATS === "1"`) so it only emits during analysis
   runs; or write it outside `outDir` (e.g. `.vite/stats.html`). The plugin is
   already conditional-friendly — wrap the `visualizer(...)` entry in a ternary.
3. **Measurement (real).**
   ```bash
   bun run --cwd packages/app build
   stat -c%s packages/app/dist/stats.html        # before: 2243210
   # after the gate (unset flag), the file is absent:
   test ! -f packages/app/dist/stats.html && echo "REMOVED"
   node packages/benchmarks/loadperf/bundle-kpi.mjs --json | jq '.summary.totalRaw, .summary.totalBrotli'
   ```
   The visualizer is HTML (not `.js`/`.css`), so it does not count in bundle-kpi's
   JS/CSS totals, but it *does* inflate on-disk dist + every native artifact;
   measure with `du -sh packages/app/dist` before/after.
4. **Confidence: High.** Pure build-config change.
5. **Impact: Medium** (2.24 MB off every installer/IPA/APK; not on the web
   critical path, but real for desktop/mobile distribution size).
6. **Risk: none** — the report is not referenced at runtime.
7. **Verification.** App boots normally (`bun run --cwd packages/app test:e2e`
   ui-smoke). Confirm `dist/index.html` never references `stats.html`
   (`grep stats.html dist/index.html` → no hits, already true).

### X2 — Precache hashed `/assets/*` in the service worker + emit `immutable`

1. **Problem / evidence.** The SW intercepts only `/api/views/:id/bundle.js`,
   `/api/views/:id/hero`, and navigations (`packages/app/dist/sw.js:21-22,69-85`).
   The hashed app chunks under `/assets/*` (the whole ~7 MB brotli app —
   `index-*.js`, `vendor-three`, `phonemizer`, locale chunks, etc.) are **not**
   precached or runtime-cached. On a warm reload the browser must re-request /
   re-validate every chunk. Because filenames are content-hashed
   (`index-DMk8Ixcs.js`), they are safe to cache *forever*, but no
   `Cache-Control: public, max-age=31536000, immutable` is emitted by any host
   (app-core sets cache headers on only 3 `no-store` routes —
   `first-run-tts-route.ts:70`, `dev-compat-routes.ts:136,179`).
2. **Fix sketch.** (a) Generate a precache manifest at build (the
   `generateBundle` hook already emits files — `vite.config.ts:731`) listing
   `assets/*.{js,css,woff2}` + `index.html`, and add a `cache.addAll(manifest)`
   step to the SW `install` handler with a build-stamped cache name. (b) Add a
   runtime cache-first rule for `/assets/` (hashes guarantee freshness).
   (c) Where a real HTTP host serves the SPA, emit
   `Cache-Control: public, max-age=31536000, immutable` for `/assets/*` and
   `no-cache` for `index.html`.
3. **Measurement (real).** Cold vs warm `requestCount`/`jsTransferredBytes` via
   the frontend KPI, run twice against the same served context:
   ```bash
   bunx playwright install chromium
   bun run --cwd packages/app build
   # cold:
   node packages/benchmarks/loadperf/frontend-kpi.mjs --json | jq '.summary.requestCount,.summary.jsTransferredBytes'
   # warm (after SW precache): drive a 2nd navigation in a custom script that
   # reuses the same browser context, or instrument: in DevTools, reload and read
   # performance.getEntriesByType('resource').filter(r=>r.transferSize===0).length
   ```
   The decisive metric is the count of resources whose `transferSize === 0`
   (served from SW/HTTP cache) on the 2nd load — script it with the same
   `COLLECT` snippet the KPI uses (`frontend-kpi.mjs:117-138`), adding
   `resources.filter(r=>r.transferSize===0).length`.
4. **Confidence: High** (SW already present; this extends its caching surface).
5. **Impact: High** (near-zero network on warm/offline reload — the dominant
   factor for repeat-visit and flaky-network loads).
6. **Risk: Low** — content hashes make stale-asset serving impossible; the
   build-stamped cache name guarantees old caches are purged by the existing
   `activate` cleanup (`sw.js:33-46`).
7. **Verification.** Load app, go offline (DevTools), reload — app shell + all
   chunks serve from cache and the UI mounts. Run ui-smoke
   (`bun run --cwd packages/app test:e2e`) to confirm no regression.

### X3 — Eliminate ~2.33 MB brotli of duplicate view-bundle helper chunks

1. **Problem / evidence.** This is the **only failing bundle budget**
   (`BASELINE.md:18`: dup waste 2.33 MB vs 1.20 MB budget). Root cause: per-plugin
   *view* bundles build with `emptyOutDir: false` into a shared `dist/views`
   (`packages/scripts/view-bundle-vite.config.ts:14-15,30`) while externalizing
   `@elizaos/ui`/`react`/`react-dom`
   (`view-bundle-vite.config.ts:15-41`). Each view build still re-emits its own
   shared shim/runtime helper chunks. On disk:
   ```bash
   cd packages/app/dist/assets
   ls *.js | sed -E 's/-[A-Za-z0-9_]{8,}\.js$//' | sort | uniq -c | sort -rn | head
   #   34 web   30 register   21 ui   11 src   3 mermaid-GHXKKRXX  3 ContactsAppView …
   ```
   The two `index-*.js` are *not* byte-identical (`md5sum` differs), confirming
   these are separate-build emissions of the same logical chunk, not idempotent
   copies.
2. **Fix sketch.** Build all plugin view bundles in **one** Rollup invocation
   with a shared `manualChunks` (so the shim/runtime/`web`/`register` helpers are
   emitted once and shared), or mark the shared runtime helper as an additional
   `external` resolved at load time. Confirm DynamicViewLoader's module registry
   (`packages/ui/src/components/views/DynamicViewLoader.tsx:54-97`) can resolve a
   single shared helper chunk.
3. **Measurement (real).**
   ```bash
   bun run --cwd packages/app build      # full, on a quiet checkout (no concurrent rebuild)
   node packages/benchmarks/loadperf/bundle-kpi.mjs --json | jq '.summary.duplicateWastedBrotli, .duplicates[0:5]'
   ```
   Target: `duplicateWastedBrotli` ≤ 1.20 MB (clears the budget) — ideally far
   lower. Re-run the `uniq -c` one-liner to confirm 34×web/30×register collapse.
4. **Confidence: High** (clear root cause + measurable budget).
5. **Impact: High** (largest single bundle win; clears the failing gate).
6. **Risk: Medium** — view bundles must still resolve their shared runtime at
   load; verify each dynamic view loads.
7. **Verification.** Navigate to several agent-spawned views (View Manager) and
   confirm each loads via DynamicViewLoader; run
   `packages/ui` DynamicViewLoader tests and ui-smoke.

### X4 — Lazy-load `streamdown` → `mermaid` (~1.6 MB raw, shipped 2–3×)

1. **Problem / evidence.** `Streamdown` is imported **statically** in
   `packages/ui/src/cloud-ui/components/ai-elements/memoized-chat-message.tsx:10`
   and `response.tsx:7`. `streamdown` pulls `mermaid` + `@mermaid-js/parser`
   transitively (`…/eliza-dist/node_modules/streamdown` and
   `…/mermaid` co-located). The `mermaid-GHXKKRXX-*.js` chunk is ~1.67 MB raw
   (measured `stat`), appears 3× on disk, and is part of the markdown render path
   that loads whenever the chat AI-elements render — even though mermaid diagrams
   in agent chat are rare.
2. **Fix sketch.** Wrap `Streamdown` in `React.lazy(() => import("streamdown"))`
   behind a `Suspense` so the markdown engine (and its mermaid graph) only loads
   when an AI message actually renders; or configure streamdown to lazy-import
   the mermaid plugin only when a ```mermaid fenced block is present. Confirm
   mermaid is in its own async chunk (it already has a dedicated chunk name).
3. **Measurement (real).**
   ```bash
   bun run --cwd packages/app build
   node packages/benchmarks/loadperf/bundle-kpi.mjs --json | jq '.topChunks[] | select(.name|test("mermaid|streamdown"))'
   # confirm mermaid chunk is NOT in the eager entry graph:
   grep -o 'modulepreload[^>]*mermaid' packages/app/dist/index.html   # expect: no hits
   node packages/benchmarks/loadperf/frontend-kpi.mjs --json | jq '.summary.jsTransferredBytes'
   ```
   `jsTransferredBytes` on first paint should drop by the mermaid/streamdown
   transfer size if it was previously in the boot graph.
4. **Confidence: High** (static import is the proven cause).
5. **Impact: High** (~1.6 MB raw off the markdown path; with X3 removes the
   duplicate copies too).
6. **Risk: Low** — first markdown render shows a brief Suspense fallback.
7. **Verification.** Send an AI chat message with markdown + a ```mermaid block;
   confirm both render (after the lazy chunk loads).

### X5 — Defer non-critical plugin initialization off the FCP critical path

1. **Problem / evidence.** `main()` (`packages/app/src/main.tsx:2185`) awaits
   `initializeAppModules()` before `mountReactApp()` (`main.tsx:2228`).
   `initializeAppModules()` (`main.tsx:499-537`) `await`s app-core then
   `Promise.all`s companion, lifeops, task-coordinator, phone, steward,
   training, **plus every `SIDE_EFFECT_APP_MODULE_LOADERS` entry**
   (`main.tsx:512-514`). FCP is gated on the *slowest* of those imports. Only
   app-core genuinely must load before mount (it owns `AppBootConfig`); the rest
   register surfaces that are not needed at first paint.
2. **Fix sketch.** Await only `importAppCore()` + the minimum config needed for
   the shell, mount React, then kick the remaining plugin imports on
   `requestIdleCallback` (the app already uses this pattern for route prefetch —
   `packages/ui/src/App.tsx:1094-1101`). Surfaces register as they resolve;
   `setBootConfig` already triggers a re-render.
3. **Measurement (real).**
   ```bash
   bunx playwright install chromium
   bun run --cwd packages/app build
   node packages/benchmarks/loadperf/frontend-kpi.mjs --json | jq '.summary.fcpMs, .summary.lcpMs, .summary.longTasksMs'
   ```
   Compare `fcpMs`/`lcpMs` before/after; expect FCP to drop toward the
   first-meaningful-shell time instead of the slowest-plugin time.
4. **Confidence: Medium** (boot ordering has subtle dependencies — companion
   provides `companionVectorBrowser`, lifeops registers its page; needs care so
   nothing renders before its surface registers).
5. **Impact: High** (FCP/LCP are the headline web-vitals budgets —
   `budgets.json:16-17`).
6. **Risk: Medium** — a surface could be briefly absent at first paint; gate
   each lazy boundary so it shows a fallback, not an error.
7. **Verification.** ui-smoke + manual: chat shell paints, then companion /
   lifeops / steward surfaces appear within a frame or two; no console errors
   about missing boot config.

### X6 — Virtualize long lists (chat transcript, logs, memories, plugins)

1. **Problem / evidence.** No virtualization library is present
   (`grep -rln "react-window|react-virtual|@tanstack/react-virtual" packages/ui/src`
   → 0 hits). The chat transcript renders every message:
   `normalizedMessages.map(...)` at
   `packages/ui/src/components/composites/chat/chat-transcript.tsx:159,193`
   (and carryover at `:130`). Logs (`LogsView`), memories (`MemoryViewerView`),
   and plugin lists follow the same full-render pattern. A long conversation or
   log produces O(n) DOM nodes and proportionally long layout/paint main-thread
   tasks.
2. **Fix sketch.** Introduce `@tanstack/react-virtual` (smaller + headless than
   react-window; ~5 KB) for the transcript and the log/memory tables. Keep
   scroll-to-bottom + scroll-restore semantics. Start with the chat transcript
   (highest churn).
3. **Measurement (real).** There is no dedicated list metric in the KPI yet —
   add a deterministic long-task probe (Playwright):
   ```js
   // probe-longtask.mjs — render N messages, measure main-thread longtasks
   await page.goto(target);
   await page.evaluate(() => { /* seed N=2000 chat messages via test hook */ });
   const lt = await page.evaluate(() => window.__perf.longTasks); // OBSERVER_INIT already tracks this
   ```
   Reuse `OBSERVER_INIT`/`COLLECT` from `frontend-kpi.mjs:98-138`
   (`longTasksMs`). Compare scroll-through long-task time with N=2000 before/after
   virtualization; also `frontend-kpi` `longTasksMs` budget (≤2000 ms).
4. **Confidence: Medium** (clear win, but transcript has rich per-message
   widgets — measure complexity).
5. **Impact: High** for long sessions / large logs; negligible for short ones.
6. **Risk: Medium** — scroll restoration, variable-height rows, and
   "jump to latest" must keep working.
7. **Verification.** Scroll a 2000-message transcript smoothly; newest message
   auto-scrolls; ui-smoke chat tests pass.

### X7 — Offload phonemizer (eSpeak WASM) + heavy parse to a Web Worker

1. **Problem / evidence.** No workers anywhere
   (`grep -rln "new Worker|OffscreenCanvas|\?worker" packages/ui/src packages/app/src`
   → 0). The phonemizer chunk is ~742 KB raw (`phonemizer-*.js`, measured
   `stat`) and runs the eSpeak NG WASM on the main thread during TTS
   (`vite.config.ts:1062-1075` routes it to `vendor-phonemizer`). Synchronous
   WASM phonemization blocks the main thread → input jank during voice replies.
2. **Fix sketch.** Move the kokoro phonemizer adapter
   (`packages/shared/.../kokoro/phonemizer`) into a dedicated worker
   (`new Worker(new URL('./phonemizer.worker.ts', import.meta.url), {type:'module'})`)
   and post text → receive phonemes. Vite supports `?worker` / `new URL` worker
   bundling out of the box; the CSP already allows `worker-src 'self' blob:`
   (`dist/index.html:214`).
3. **Measurement (real).**
   ```bash
   node packages/benchmarks/loadperf/frontend-kpi.mjs --json | jq '.summary.longTasksMs'
   ```
   Drive a TTS warmup in a Playwright probe and read `window.__perf.longTasks`
   (the KPI's `OBSERVER_INIT` longtask observer — `frontend-kpi.mjs:110-114`)
   before/after. Main-thread longtask time during phonemization should approach
   zero.
4. **Confidence: Medium** (worker boundary + transferable serialization work).
5. **Impact: High** for voice flows (smoothness during speech synthesis).
6. **Risk: Medium** — worker lifecycle + WASM init duplication; verify TTS audio
   identical.
7. **Verification.** Voice reply produces correct audio; main thread stays
   responsive (no longtask spike) during synthesis.

### X8 — Drop `.woff` fallbacks, ship `.woff2` only

1. **Problem / evidence.** `dist/assets` contains 30 `.woff2` **and** 30 `.woff`
   (`ls dist/assets/*.woff2 | wc -l` = 30; `*.woff` = 30). `@fontsource/poppins`
   `@font-face` rules list both formats
   (`@fontsource/poppins/400.css`: `…woff2') format('woff2'), url(…woff)
   format('woff')`). Every shipped target (build `target: es2022` —
   `vite.config.ts:2167`; Chromium/WKWebView/Capacitor) supports woff2, so the
   woff copies are never fetched but still bloat the dist and native artifacts.
2. **Fix sketch.** Use `@fontsource-variable/poppins` (one variable woff2 per
   subset instead of 5 static weights × 2 formats), or post-build prune `*.woff`
   and strip the woff `src` entries. Variable font also collapses the 5 weight
   imports in `packages/ui/src/styles/styles.css:1-5` into one.
3. **Measurement (real).**
   ```bash
   bun run --cwd packages/app build
   du -ch packages/app/dist/assets/*.woff | tail -1     # bytes removed
   ls packages/app/dist/assets/*.woff 2>/dev/null | wc -l   # after: 0
   ```
   Browsers already only fetch woff2, so frontend-kpi transfer is unchanged; the
   win is dist/installer size (X1-style artifact reduction).
4. **Confidence: High** (woff2 universal on targets).
5. **Impact: Low** (artifact size only; no runtime transfer change).
6. **Risk: none** on modern targets.
7. **Verification.** Text renders in Poppins across weights;
   `audit:cloud`/ui-smoke screenshots unchanged.

### X9 — Emit `ETag` + `Cache-Control` on `/api/views/:id/{bundle.js,hero}`

1. **Problem / evidence.** The SW's stale-while-revalidate compares
   `networkResponse.headers.get("etag")` vs the cached etag
   (`packages/app/dist/sw.js:125-128`) and cache-first hero eviction reads the
   `date` header (`sw.js:154-157`). If the view-bundle/hero routes don't emit
   `ETag`/`Cache-Control`/`Date`, the SW can't detect updates (always treats as
   changed → re-caches) and hero max-age eviction degrades to "serve as-is"
   (`sw.js:158-161`). The view routes live in
   `packages/app-core/src/api/catalog-routes.ts`; no `ETag`/`Cache-Control` is
   set there (only `no-store` routes exist elsewhere).
2. **Fix sketch.** In the view-bundle route, compute a content hash → `ETag`,
   honor `If-None-Match` (304), and set `Cache-Control: public, max-age=0,
   must-revalidate` for bundles (so SWR works) and `max-age=86400` for hero
   images (matching the SW's `HERO_MAX_AGE_MS` — `sw.js:18`).
3. **Measurement (real).**
   ```bash
   LOADPERF_BASE_URL=http://127.0.0.1:31337 node packages/benchmarks/loadperf/boot-kpi.mjs --attach &
   curl -sI http://127.0.0.1:31337/api/views/<id>/bundle.js | grep -iE 'etag|cache-control|date'
   curl -sI -H 'If-None-Match: "<etag>"' http://127.0.0.1:31337/api/views/<id>/bundle.js   # expect 304
   ```
4. **Confidence: High** (the SW already depends on these headers).
5. **Impact: Medium** (correct SWR revalidation → fewer full re-downloads of
   view bundles; correct hero eviction).
6. **Risk: none.**
7. **Verification.** Re-fetch an unchanged bundle → 304; change a view → SW
   posts `sw:view-updated` (`sw.js:131-135`) and DynamicViewLoader refreshes.

### X10 — Precompress assets to `.br` at build and serve `Content-Encoding: br`

1. **Problem / evidence.** No `.br`/`.gz` artifacts exist in dist
   (`ls dist/assets/*.br *.gz` → 0). The Electrobun static server
   (`packages/app-core/platforms/electrobun/electrobun.config.ts`) shows no
   `Content-Encoding`/compression handling. So whether brotli reaches the client
   depends entirely on an external CDN; the desktop static server likely serves
   raw bytes (37 MB raw vs 7 MB brotli — `BASELINE.md:20`).
2. **Fix sketch.** Add a build step (e.g. `vite-plugin-compression` or a
   post-build `brotli -q11` pass) to emit `*.br` next to each `*.js`/`*.css`,
   and teach the static server to serve the `.br` variant with
   `Content-Encoding: br` when `Accept-Encoding: br`. On real HTTP hosts, enable
   brotli at the edge.
3. **Measurement (real).**
   ```bash
   bun run --cwd packages/app build
   node packages/benchmarks/loadperf/frontend-kpi.mjs --json | jq '.summary.jsTransferredBytes'
   ```
   `jsTransferredBytes` reflects `encodedBodySize` (`frontend-kpi.mjs:125`), so
   serving brotli vs raw is directly visible here. Against the desktop static
   server, compare transferred bytes with/without `Content-Encoding`.
4. **Confidence: Medium** (depends on which host serves; high value for the
   desktop static server which today likely serves raw).
5. **Impact: Medium** (~5× transfer reduction on hosts not already
   brotli-enabled).
6. **Risk: Low** — must only serve `.br` when negotiated.
7. **Verification.** DevTools shows `content-encoding: br` and assets execute;
   uncompressed fallback still works for non-br clients.

### X11 — Persist last-known app state to localStorage/IndexedDB for warm paint

1. **Problem / evidence.** There is no query-cache or IDB persistence of *data*
   (no React Query / SWR: `grep -rln "useQuery|QueryClient|useSWR" packages/ui/src`
   → 0). `persistence.ts` persists only UI prefs (theme, companion power mode,
   setup step — `packages/ui/src/state/persistence.ts:55-340`), not
   conversations/agent profiles/last-known lists. On a warm load the UI paints an
   empty shell and waits for network before showing any data.
2. **Fix sketch.** Add a small write-through cache: on successful fetch of
   conversations / agent profile / recent messages, write a compact snapshot to
   IndexedDB (large) or localStorage (small) keyed by agent+endpoint; on boot,
   hydrate the store from that snapshot for an instant first meaningful paint,
   then revalidate from network and reconcile (stale-while-revalidate at the data
   layer). Cross-reference the optimistic-UI / write-through findings from the
   sibling report on state-sync.
3. **Measurement (real).** Add a "time-to-first-data" probe to frontend-kpi:
   instrument a `performance.mark('first-data')` when the first conversation list
   renders, and read it via the `COLLECT` snippet pattern
   (`frontend-kpi.mjs:117-138`). Compare cold (no snapshot) vs warm (snapshot
   present) — warm should show data well before the network round-trip.
4. **Confidence: Medium** (clear UX win; correctness needs careful
   revalidation).
5. **Impact: Medium** (perceived instant warm load; helps low-bandwidth /
   high-latency).
6. **Risk: Medium** — stale-data flash if revalidation is slow; never persist
   secrets; respect `ELIZA_DISABLE_TRAJECTORY_LOGGING`-style opt-outs.
7. **Verification.** Reload with a populated agent → list shows instantly, then
   updates; clearing storage falls back to network cleanly.

### X12 — Set `build.assetsInlineLimit` to keep small assets cacheable

1. **Problem / evidence.** `vite.config.ts` defines no `build.assetsInlineLimit`
   (grep → no hits), so Vite's default 4 KB applies: assets < 4 KB are base64-
   inlined into JS. Inlined assets can't be cached separately, add ~33 % size,
   and are parsed as JS. For an app with many small SVG/icon assets this bloats
   the (cacheable) JS chunks with un-cacheable data URIs.
2. **Fix sketch.** Set `build.assetsInlineLimit: 0` (emit all assets as files) or
   a small value (e.g. 1024) and let the SW (X2) cache them. Balance against
   requestCount (X14/X16) — tiny inline-worthy icons may be better as a sprite.
3. **Measurement (real).**
   ```bash
   bun run --cwd packages/app build
   node packages/benchmarks/loadperf/bundle-kpi.mjs --json | jq '.summary.totalRaw'
   node packages/benchmarks/loadperf/frontend-kpi.mjs --json | jq '.summary.requestCount'
   ```
   Compare JS total (should shrink as base64 leaves chunks) vs requestCount
   (should rise modestly — keep under the 120 budget).
4. **Confidence: Medium** (depends on how many <4 KB assets exist).
5. **Impact: Low** (cacheability + minor JS-parse reduction).
6. **Risk: Low** — more requests; mitigated by SW precache (X2) + HTTP/2.
7. **Verification.** App renders all icons/images; requestCount under budget.

### X13 — Memoize markdown/code render output per chat message

1. **Problem / evidence.** `memoized-chat-message.tsx` exists but the
   `<Streamdown>` body (`:372-376`) re-parses markdown on every render; there's
   no per-message memo of the rendered AST/output. During transcript scroll or
   streaming updates, each visible AI message re-runs the markdown + syntax
   highlight pipeline.
2. **Fix sketch.** `useMemo` the rendered markdown keyed by the message's final
   text + a "complete" flag (only re-render while streaming; freeze once done).
   Combine with X6 so only visible messages render at all.
3. **Measurement (real).** Long-task probe (as in X6) while scrolling a
   transcript of completed AI messages; read `window.__perf.longTasks`
   (`frontend-kpi.mjs:110-114`). Expect a drop because scrolling no longer
   re-parses markdown.
4. **Confidence: Medium** (memo key correctness with streaming).
5. **Impact: Medium** (smoothness in AI-heavy transcripts).
6. **Risk: Low** — wrong memo key could freeze a streaming message; key on
   `(text, isStreaming)`.
7. **Verification.** Streaming message still updates live; completed messages
   don't re-parse on scroll; output unchanged.

### X14 — `loading="lazy"` + `decoding="async"` on offscreen images

1. **Problem / evidence.** Only 9 `loading="lazy"`/`decoding="async"` hits across
   `packages/ui/src` (grep). Images are rendered via components (0 literal
   `<img ` tokens — they're wrapped), so a per-component audit is needed:
   avatars, app hero tiles, VRM thumbnails, content-pack art. Offscreen images
   loaded eagerly compete with the LCP image for bandwidth and decode time.
2. **Fix sketch.** Add `loading="lazy"` + `decoding="async"` to all
   below-the-fold `<img>`/Image components; explicitly keep the LCP/hero image
   **eager** (`fetchpriority="high"`). Audit the shared image component(s) so the
   default is lazy except where overridden.
3. **Measurement (real).**
   ```bash
   node packages/benchmarks/loadperf/frontend-kpi.mjs --json | jq '.summary.lcpMs, .summary.requestCount'
   ```
   LCP should improve (less bandwidth contention) and requestCount on first paint
   should drop (offscreen images deferred).
4. **Confidence: Medium** (needs the component audit to be sure which is LCP).
5. **Impact: Low–Medium** (image-heavy surfaces: apps grid, companion).
6. **Risk: Medium** — lazy-loading the LCP image *hurts* LCP; never lazy the
   hero.
7. **Verification.** Hero paints immediately; offscreen images load on scroll;
   LCP not regressed.

### X15 — Debounce/throttle expensive handlers (search, resize, scroll)

1. **Problem / evidence.** 14 debounce/throttle call-sites exist, but
   `useDeferredValue`/`startTransition` is used in only 3 places
   (`MemoryViewerView.tsx`, `RelationshipsWorkspaceView.tsx`,
   `chat/widgets/agent-orchestrator.tsx`). Search-as-you-type and resize/scroll
   handlers that filter large lists synchronously can saturate the main thread on
   each keystroke/scroll tick.
2. **Fix sketch.** Wrap search inputs that filter large datasets in
   `useDeferredValue` (keeps the input responsive while the heavy filtered list
   updates at lower priority); throttle resize/scroll listeners (rAF-throttle).
   Audit the 11 non-deferred filter inputs.
3. **Measurement (real).** Long-task probe while typing into a large-list search
   (read `window.__perf.longTasks` — `frontend-kpi.mjs:110-114`); the input
   handler longtask time should drop.
4. **Confidence: Medium** (input-feel improvement; per-site audit needed).
5. **Impact: Low** (perceived responsiveness on big lists).
6. **Risk: Low** — deferred value can show a 1-frame-stale list; acceptable.
7. **Verification.** Typing stays smooth; results update; no dropped keystrokes.

### X16 — Strip dead format/polyfill weight; keep modern build target

1. **Problem / evidence.** Build `target: es2022` is already modern
   (`vite.config.ts:2167`, `oxc.target: "es2022"` `:1632`) and prod ships no
   source maps (`ls dist/assets/*.map` → 0) — good. Residual dead weight: the
   `.woff` fallbacks (X8), and inline Node polyfills in `index.html`
   (`process`/`Buffer` shims at `dist/index.html:294-340`) plus the WebGPU enum
   polyfill (`:8-33`) that ship to every host including ones that don't need them.
   These are small but unconditional.
2. **Fix sketch.** Confirm es2022 is the minimum target across all WebViews
   (it is — Chromium/WKWebView/Capacitor); avoid any tsconfig that pushes the
   transform lower (the config already overrides this at `:1629-1633`). Gate the
   Node-polyfill inline scripts so they only ship where a consumer actually
   evaluates Node built-ins (or move them into a tiny separate file the SW can
   cache). Keep the WebGPU enum polyfill (three.js needs it).
3. **Measurement (real).**
   ```bash
   bun run --cwd packages/app build
   node packages/benchmarks/loadperf/bundle-kpi.mjs --json | jq '.summary.totalBrotli'
   stat -c%s packages/app/dist/index.html   # before/after polyfill trim
   ```
4. **Confidence: Low** (mostly already done; remaining wins are small and need
   per-target verification).
5. **Impact: Low.**
6. **Risk: Medium** — removing a polyfill that an older WebView needs breaks
   boot; verify on the lowest target.
7. **Verification.** App boots in Electrobun (CEF/WKWebView) and Capacitor
   iOS/Android; three.js companion renders.

---

## D. Measurement & Benchmark Plan (exact commands)

Always rebuild on a **quiet checkout** first (no concurrent build racing
`dist/`), because the live build corrupts the dist mid-walk (this pass hit
`ENOENT … PolymarketAppView-*.js` and a hash mismatch between `dist/index.html`
and `dist/assets`):

```bash
# 0. Prereqs (once)
bunx playwright install chromium

# 1. Clean, stable build
bun run --cwd packages/app build

# 2. Bundle KPI (X1, X3, X4, X8, X12, X16) — no server/browser needed
node packages/benchmarks/loadperf/bundle-kpi.mjs --json \
  | jq '{totalRaw,totalBrotli,initialEntryBrotli,duplicateWastedBrotli,topChunks:.topChunks[0:12],duplicates:.duplicates[0:8]}'

# 2b. Duplicate-chunk inventory (X3) — raw on-disk
( cd packages/app/dist/assets && ls *.js | sed -E 's/-[A-Za-z0-9_]{8,}\.js$//' | sort | uniq -c | sort -rn | head -20 )

# 2c. Visualizer + font + artifact weight (X1, X8)
stat -c%s packages/app/dist/stats.html 2>/dev/null || echo "stats.html absent"
ls packages/app/dist/assets/*.woff 2>/dev/null | wc -l
du -sh packages/app/dist

# 3. Frontend KPI (X2, X4, X5, X6, X7, X10, X11, X13, X14, X15) — needs chromium
node packages/benchmarks/loadperf/frontend-kpi.mjs --json \
  | jq '{fcpMs:.summary.fcpMs,lcpMs:.summary.lcpMs,longTasksMs:.summary.longTasksMs,jsTransferredBytes:.summary.jsTransferredBytes,requestCount:.summary.requestCount}'

# 3b. Warm-cache delta (X2): add to a custom Playwright script reusing the
#     KPI's COLLECT snippet (frontend-kpi.mjs:117-138):
#       resources.filter(r => r.transferSize === 0).length   // cache hits on 2nd load

# 3c. Long-task probe for list virtualization / markdown memo (X6, X13, X15):
#     reuse OBSERVER_INIT (frontend-kpi.mjs:98-115), seed N=2000 messages via a
#     test hook, scroll, read window.__perf.longTasks.

# 4. View-bundle cache headers (X9) — needs a running API
LOADPERF_BASE_URL=http://127.0.0.1:31337 node packages/benchmarks/loadperf/boot-kpi.mjs --attach
curl -sI http://127.0.0.1:31337/api/views/<id>/bundle.js | grep -iE 'etag|cache-control|date'
curl -sI -H 'If-None-Match: "<etag>"' http://127.0.0.1:31337/api/views/<id>/bundle.js   # want 304

# 5. Boot KPI (regression guard for X5 — ensure backend cold start unaffected)
node packages/benchmarks/loadperf/boot-kpi.mjs

# 6. Consolidated dashboard + budget gate
node packages/benchmarks/loadperf/run-all.mjs
# results/summary/latest.md ; exit 1 on any failing budget
```

Budgets these move (`packages/benchmarks/loadperf/budgets.json`):
`bundle.maxDuplicateLibBytes` (X3 — currently failing), `bundle.totalAssetsBrotliBytes`
(X1/X3/X4/X8), `frontend.jsTransferredBytes` (X2/X4/X5/X10),
`frontend.requestCount` (X2/X12/X14), `frontend.longTasksMs`
(X6/X7/X13/X15), `frontend.fcpMs`/`lcpMs` (X5/X14). As wins land, ratchet the
budgets down (`BASELINE.md:76` — monotonic improvement is the stated goal).

---

## E. Prioritized Backlog (ranked by confidence × impact)

1. **X3 — Kill duplicate view-bundle chunks (~2.33 MB brotli).** High × High;
   clears the only failing bundle budget. Root cause is the per-plugin
   `emptyOutDir:false` view builds re-emitting shared helpers
   (`view-bundle-vite.config.ts:30`).
2. **X2 — SW precache `/assets/*` + `immutable` Cache-Control.** High × High;
   near-zero warm/offline network. The SW already exists (`dist/sw.js`).
3. **X4 — Lazy-load `streamdown`→`mermaid` (~1.6 MB×).** High × High; remove a
   huge eager markdown engine from the chat path
   (`memoized-chat-message.tsx:10`).
4. **X5 — Defer plugin init off the FCP critical path.** Med × High; FCP/LCP win
   (`main.tsx:2185,2228`).
5. **X6 — Virtualize chat/log/memory/plugin lists.** Med × High; long-session
   smoothness (`chat-transcript.tsx:159`).
6. **X7 — Phonemizer/TTS to a Web Worker.** Med × High; main-thread smoothness
   during voice.
7. **X1 — Stop shipping `stats.html` (2.24 MB).** High × Med; trivial build-config
   fix, off every native artifact.
8. **X9 — `ETag`/`Cache-Control` on view-bundle/hero routes.** High × Med; makes
   the SW's SWR/eviction actually correct (`dist/sw.js:125,154`).
9. **X10 — Precompress to brotli + serve `Content-Encoding`.** Med × Med; big win
   on hosts not already brotli-enabled (esp. the desktop static server).
10. **X11 — Persist last-known data for warm paint.** Med × Med; perceived
    instant warm load.
11. **X13 — Memoize per-message markdown render.** Med × Med.
12. **X8 — Drop `.woff` (keep woff2).** High × Low; artifact-size only.
13. **X12 — `assetsInlineLimit`.** Med × Low.
14. **X14 — Lazy/async offscreen images.** Med × Low (audit-gated).
15. **X15 — Debounce/`useDeferredValue` search/resize.** Med × Low.
16. **X16 — Trim dead format/polyfill weight.** Low × Low (mostly already done).

**Lower-confidence / needs-human-decision:** X5 boot reordering (plugin
dependency subtleties), X11 data persistence (revalidation correctness + never
persist secrets), X16 polyfill trimming (lowest-target verification). X14 needs a
per-component image audit to identify the LCP element before lazy-loading.
