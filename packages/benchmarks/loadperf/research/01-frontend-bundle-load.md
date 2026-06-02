# Frontend Bundle & Load — Optimization Research

Scope: `packages/app` (Vite build + boot), `packages/ui` (App shell routing), heavy
deps (phonemizer, three, draco, lucide, i18n). Research only — no source changes.

Measurement substrate: `packages/benchmarks/loadperf` harness (`bundle-kpi.mjs`,
`frontend-kpi.mjs`). All "before" numbers below are **freshly measured on this
checkout**, not taken from `BASELINE.md` (which is stale — see Finding F0).

Captured 2026-06-02 on `develop`. Clean build via
`ELIZA_DESKTOP_VITE_FAST_DIST="" bun run --cwd packages/app build:web` (52.97s).

---

## A. Critical Assessment

### F0 — The documented baseline is wrong: it was measured against a *stale watch-mode dist*

This is the single most important finding because it invalidates the premise of
the task ("duplicate-lib waste 2.33 MB FAILING budget"). The build directory that
`BASELINE.md` was measured against was an **accumulation of three separate build
generations** layered into one `dist/assets/`, never cleaned.

Evidence:

- The pre-existing dirty `dist/assets/` had file mtimes in three distinct minute
  buckets — 16:57 (122 files), 16:58 (154 files), 16:59 (188 files) — i.e. three
  build runs whose outputs coexisted. Every lazy view existed as 2–3 hashed
  copies (`SettingsView-BQd7-o_T.js` @16:59, `SettingsView-u51d6SkM.js` @16:57,
  `SettingsView-DZRbMkWr.js` @16:58). `index.html` referenced only the newest
  (`index-DMk8Ixcs.js` @16:59:26); the other two 8.99 MB `index-*.js` chunks
  (`index-Bl-OVH-H.js` @16:57) were orphans no deploy ever serves.
- Root cause: `packages/app/vite.config.ts:2165` — `emptyOutDir: !desktopFastDist`.
  When `ELIZA_DESKTOP_VITE_FAST_DIST=1` (set by the Electrobun dev orchestrator,
  `packages/app-core/scripts/dev-platform.mjs` per vite.config.ts:1012-1013), the
  output dir is **not** emptied between watch rebuilds, so stale content-hashed
  chunks pile up indefinitely. The KPI then walks the whole tree.
- `bundle-kpi.mjs:38-44` `logicalName()` strips the content hash, so all
  `index-*.js` collapse into one logical "index" bucket; the duplicate detector
  (`bundle-kpi.mjs:93-101`) reports them as N copies of the largest. On a stale
  watch dist this manufactures phantom "duplicate-lib waste."

Measured contrast (same harness, same machine):

| Metric | Dirty watch dist (what BASELINE.md saw) | **Clean `build:web`** | Budget | Clean status |
| --- | --- | --- | --- | --- |
| asset count | 316 | **162** | — | — |
| total raw | 43.20 MB | **17.44 MB** | — | — |
| total brotli | 8.05 MB | **3.75 MB** | 15.6 MB | PASS |
| initial entry brotli | (mis-detected 0) | **1104.4 KB** | 2.30 MB | PASS |
| largest chunk brotli | 1355.8 KB | **1104.4 KB** (`index-*.js`) | 2.30 MB | PASS |
| duplicate-lib waste | 2.33 MB (FAIL) | **0.30 MB** | 1.20 MB | PASS |

**The "only failing bundle budget" does not exist on a clean build.** All four
bundle budgets PASS. The real, *clean-build* problems are different and are
catalogued below.

### F-real — what is actually expensive on a clean build

1. **The eager entry chunk is 5.23 MB raw / 1104 KB brotli** (`index-joa_QlBT.js`)
   — 28.8% of total brotli in one file, parsed+evaluated before anything renders.
2. **React mount is blocked behind full plugin init.** `main.tsx:2185` does
   `await initializeAppModules()` *before* `mountReactApp()` (`main.tsx:2228`).
   `initializeAppModules` (`main.tsx:499-537`) `Promise.all`-awaits companion +
   lifeops + vincent + task-coordinator + phone + steward + training + **~10
   side-effect plugins** (`plugin-registrations.ts`, 20 loader entries). Nothing
   paints until all of that downloads, parses, and runs `register*()`.
3. **three.js (330 KB brotli, 4 chunks) is on the boot-critical path.**
   `initializeAppModules` reads `companionModule.THREE` to fill
   `bootConfig.companionVectorBrowser` (`main.tsx:525-528`), so awaiting companion
   pulls the entire three family into first-render for every user, including those
   who never open the VRM avatar / vector browser.
4. **No `modulepreload`.** Clean `index.html` injects **zero**
   `<link rel="modulepreload">` (verified: `grep -c modulepreload` = 0) despite the
   entry referencing 97 dependency chunks via `__vite__mapDeps`. The browser
   discovers each lazy chunk only when the entry executes → request waterfall.
   `frontend-kpi` recorded **109 requests** (budget 120).
5. **JS transferred = 8447 KB — FAILS the frontend budget (3418 KB) by 2.5×.**
   `frontend-kpi.mjs` serves *uncompressed* JS (sets raw `content-length`,
   `frontend-kpi.mjs:79`), so this is raw bytes the browser pulled at load: the
   5.23 MB entry + locale(s) + the 14 route chunks that `prefetchRouteViewChunks`
   (`App.tsx:203,1101`) idle-warms right after mount.
6. **English i18n catalog (476 KB raw / ~115 KB brotli) is statically baked into
   the entry** (`messages.ts:1` `import en from "./locales/en.json"`). The other 7
   locales are correctly lazy (each ~480–580 KB raw, `messages.ts:38-47`).
7. **`phonemizer` (622.8 KB brotli) is already a lazy async chunk** — reached only
   via `await import("phonemizer")` at
   `packages/shared/src/local-inference/kokoro/phonemizer.ts:275`, and the
   `manualChunks` rule (vite.config.ts:1070-1075) already collapses it to ONE chunk
   (the BASELINE.md "phonemizer shipped twice" was again the stale-dist artifact:
   clean libSpread shows `phonemizer: 1 chunk`). **Not an action item** beyond
   verifying nothing in the eager graph pulls it (confirmed: UI has no static
   kokoro import).

### Verified non-problems (do NOT "fix")

- **Duplicate chunks.** Clean `bundle-kpi` "22x index / 226 KB wasted" is a *false
  positive* of `logicalName()` hash-stripping: those 23 `index-*.js` files are
  genuinely distinct modules Rollup auto-named `index`, not copies. See D2 for the
  KPI fix.
- **phonemizer double-ship** — gone on clean build (1 chunk).
- **three "5 chunks"** in BASELINE — clean build is 4 chunks and the
  `manualChunks` `vendor-three` rule (vite.config.ts:1094-1100) already
  consolidates by import path; the spread is `three.module`/`three.webgpu`/
  `three.tsl`/`three-vrm` which are deliberately one async group (TDZ fix comment,
  vite.config.ts:1094-1097). The problem is *when* it loads (boot), not *how many
  chunks*.

---

## B. Optimization Catalog

| id | optimization | evidence (file:line) | conf | impact | risk | measurement | verification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| O1 | Clean `dist` before measuring; fix KPI to measure only the live graph | vite.config.ts:2165; bundle-kpi.mjs:38-101 | high | high (corrects all KPI numbers) | none | `bundle-kpi.mjs` before/after on fresh `build:web` | budgets still PASS; numbers match treemap |
| O2 | Mount React before awaiting full plugin init (defer `initializeAppModules` to post-mount) | main.tsx:2185,2228,499-537 | high | high (TTI) | med (boot-config consumers must tolerate late plugins) | new boot-timing probe + `frontend-kpi` TTI/long-tasks | UI smoke: chat responds, views switch, plugin views load |
| O3 | Take three.js off the boot path (lazy companionVectorBrowser) | main.tsx:525-528; plugin-loader.ts:254 | high | high (−330 KB brotli eager) | med (vector browser / VRM must lazy-init THREE) | `frontend-kpi` jsTransferred; chunk-graph: three not in entry's eager set | open companion/VRM + vector browser still render |
| O4 | Inject `modulepreload` for the entry's first-wave dynamic deps | index.html (0 modulepreload); vite.config.ts build | high | med (waterfall→parallel) | low | `frontend-kpi` requestCount + LCP under throttling | all routes still load; no double-fetch |
| O5 | Don't statically bundle `en.json` into entry; lazy-load all locales incl. default | messages.ts:1,27-36 | med | med (−~115 KB brotli eager) | med (needs sync fallback to avoid flash-of-keys) | `bundle-kpi` entry brotli before/after | UI renders English text immediately, no raw keys |
| O6 | Gate / idle-defer `prefetchRouteViewChunks` on low-end + Save-Data | App.tsx:203-221,1094-1101 | med | med (transferred bytes at load) | low | `frontend-kpi` jsTransferred + requestCount | first nav to each view still fast enough |
| O7 | Split the 5.23 MB entry: move non-first-paint app code to a lazy "shell-rest" chunk | bundle-kpi top chunk 1104 KB; entry maps 97 deps | med | med-high (entry parse cost) | med | `bundle-kpi` entry brotli; long-tasks | shell still boots; chat/header present at first paint |
| O8 | Add precompressed `.br`/`.gz` emission + serve `Content-Encoding` for the web/CDN path | no compression plugin in vite.config.ts; no Content-Encoding in app-core | med | med (web only; N/A desktop local FS) | low | `frontend-kpi` against a brotli-serving preview | bytes-on-wire drop; desktop unaffected |
| O9 | Audit `mermaid` (205 KB brotli) eager-vs-lazy; ensure lazy | bundle-kpi: mermaid 205 KB brotli | low | low-med | low | chunk-graph: mermaid reachable only via dynamic import | markdown/diagram render still works |
| O10 | Audit draco (130 KB brotli, 3 chunks) loads only on GLTF/VRM path | bundle-kpi libSpread draco | low | low | low | chunk-graph: draco not in entry eager set | avatar/3D import still decodes |

---

## C. Detailed Findings

### O1 — Clean dist + fix the KPI to measure only the live graph (the foundation)

1. **Problem.** `vite.config.ts:2165` `emptyOutDir: !desktopFastDist` lets watch-mode
   builds accumulate stale hashed chunks; `bundle-kpi.mjs:38-101` then counts them
   and (via hash-stripping) reports phantom duplicates. The recorded baseline
   (6.93 MB total, 2.33 MB dup-waste FAIL) is an artifact, not the shipped bundle
   (3.75 MB total, 0.30 MB dup-waste, all PASS).
2. **Fix sketch.**
   (a) `bundle-kpi.mjs`: before measuring, resolve the *reachable* graph from
   `index.html`'s entry script + follow `__vite__mapDeps` / static imports; measure
   only reachable files. Reject (or warn loudly + exclude) any `.js` not reachable
   from an entry. This makes the KPI immune to stale dist.
   (b) Replace the hash-stripping duplicate detector with a *content-hash* duplicate
   detector (md5 of bytes) so only genuinely byte-identical files count as
   duplicates — Rollup-auto-named `index` chunks stop being false positives.
   (c) Ops: ensure CI/benchmark runs `build:web` (which empties dir) not a watch
   dist; optionally `bundle-kpi` should `console.warn` when `dist` mtime spread > a
   few minutes (heuristic for stale watch output).
3. **Measure.** `ELIZA_DESKTOP_VITE_FAST_DIST="" bun run --cwd packages/app build:web`
   then `node packages/benchmarks/loadperf/bundle-kpi.mjs`. Before (stale dist):
   total 8.05 MB brotli, dup 2.33 MB. After (clean + reachable-only): total
   3.75 MB brotli, dup ~0 (byte-identical). Already half-measured above.
4. **Confidence: high.** Directly reproduced both numbers.
5. **Impact: high** — without this every other "savings" number is unmeasurable.
6. **Risk: none** (tooling/ops only).
7. **Verify UX.** No app change; verify only that `frontend-kpi` still loads the
   app (FCP 1152 ms, CLS 0 measured).

### O2 — Mount React before full plugin init (biggest TTI lever)

1. **Problem.** `main.tsx:2185` `await initializeAppModules()` runs to completion
   *before* `mountReactApp()` (`main.tsx:2228`). `initializeAppModules`
   (`main.tsx:499-537`) `Promise.all`-awaits companion, lifeops, vincent,
   task-coordinator, phone, steward, training, plus all 10 side-effect plugins
   (`plugin-registrations.ts`: feed, scape, hyperscape, defense-of-the-agents,
   clawville, trajectory-logger, shopify-ui, hyperliquid-app, polymarket-app,
   wallet-ui, app-model-tester). Every one of those chunks must download + parse +
   run `register*()` before a single pixel paints. This contradicts the
   `packages/app/CLAUDE.md` boot-sequence claim that platform init runs
   "concurrently after mount" — module init is *before* mount.
2. **Fix sketch.** Mount React with the boot-config it can render from (branding,
   theme, character catalog — already available pre-init), then resolve
   `initializeAppModules()` and call `setBootConfig()` to hydrate plugin-provided
   slots (companionShell, lifeOpsPageView, etc.) reactively. The boot-config store
   is already React-subscribed (`config/boot-config-react`), and the shell slots
   are already lazy `lazyNamedComponent` handles (`main.tsx:226-276`) — so a late
   `setBootConfig` is structurally supported. Render a lightweight shell + chat
   first; fill plugin surfaces as they arrive.
3. **Measure.** Add a boot-timing probe (see D3): record `performance.now()` at
   first `createRoot().render` and at `setBootConfig` completion. Before: render
   happens after full init. After: render timestamp ≈ entry-eval time. Also
   `frontend-kpi` `longTasksMs` (411 ms now) and a new TTI marker.
4. **Confidence: high** (structural; the mechanism already exists).
5. **Impact: high** — removes ~all plugin-chunk download+parse from first paint.
6. **Risk: med** — any consumer that reads a plugin slot at first render must
   tolerate `undefined` until hydration (most already do via the store).
7. **Verify UX.** `bun run --cwd packages/app test:e2e` (ui-smoke): agent responds
   to a chat, view switching works, a plugin view (e.g. ContactsAppView) loads and
   its view-dependent actions fire. Manually confirm no flash of missing companion.

### O3 — Take three.js off the boot-critical path

1. **Problem.** `main.tsx:525-528` and `plugin-loader.ts:254` pass
   `companionModule.THREE` into `bootConfig.companionVectorBrowser` during the
   awaited init. Because `plugin-companion` re-exports `THREE`, awaiting companion
   pulls the whole three family (clean build: `three.module` 151 KB + `three.webgpu`
   144 KB + `three-vrm` 30 KB + `three.tsl` ≈ **330 KB brotli total**) into the
   first-render path for everyone.
2. **Fix sketch.** Make `companionVectorBrowser` a *lazy factory*:
   `companionVectorBrowser: { loadThree: () => import("three"),
   createVectorBrowserRenderer }` (or have the companion module expose a
   `getThree()` that dynamic-imports). Consumers (VectorBrowserView,
   `VoiceWaveform` already imports `three` as `type`-only — good) call it only when
   the 3D surface mounts. This keeps three a lazy chunk loaded on first VRM/vector
   use, not at boot.
3. **Measure.** `frontend-kpi` `jsTransferredBytes` before/after; and a chunk-graph
   assertion that `three.*` is not in the entry's first-wave `__vite__mapDeps`.
   Expected eager-payload reduction ≈ 330 KB brotli / ~1.5 MB raw.
4. **Confidence: high** (clear static edge from boot to three).
5. **Impact: high** for non-avatar sessions.
6. **Risk: med** — must ensure VRM avatar host + VectorBrowserView lazy-init THREE
   without a race; `dedupe: ["three"]` (vite.config.ts:1638) keeps a single copy.
7. **Verify UX.** Open the companion VRM avatar and the vector browser view; both
   still render and animate. UI smoke covers the default (no-avatar) path stays
   green.

### O4 — Inject `modulepreload` for first-wave dynamic deps

1. **Problem.** Clean `index.html` has **0** `modulepreload` links (verified) while
   the entry references 97 dependency chunks. Vite normally emits modulepreload for
   an entry's *static* import graph, but this app's shell is reached largely through
   *dynamic* imports (`lazyNamedComponent`, `initializeAppModules`), which Vite does
   not preload. So the browser serially discovers each needed chunk (109 requests
   measured).
2. **Fix sketch.** A small `transformIndexHtml` plugin (post-build) that reads the
   first-wave dynamic deps the shell always needs (app-core, the active locale,
   shell chunks) from the bundle and emits `<link rel="modulepreload">` for them.
   Vite's `build.modulePreload.resolveDependencies` hook is the supported seam.
   Do NOT preload everything (that defeats laziness) — preload only the
   always-needed first wave (app-core + ui + the locale).
3. **Measure.** `frontend-kpi` `requestCount` and `lcpMs` under simulated 3G/CPU
   throttle (extend frontend-kpi with a `--throttle` Playwright CDP option — see D1).
   Local unthrottled FCP is already 1152 ms so the win shows only under throttling.
4. **Confidence: high** (well-trodden Vite pattern).
5. **Impact: med** (waterfall → parallel; biggest on slow links / desktop cold).
6. **Risk: low** (preload is a hint; wrong preloads only waste a little bandwidth).
7. **Verify UX.** All routes still load; DevTools network shows no duplicate fetch.

### O5 — Lazy-load the default (English) locale too

1. **Problem.** `messages.ts:1` statically `import en from "./locales/en.json"`
   (476 KB raw / ~115 KB brotli) folds the entire English catalog into the entry
   chunk. The comment (messages.ts:20-26) explicitly accepts this as the "fallback."
2. **Fix sketch.** Either (a) lazy-load `en` like the others and render a tiny
   inlined bootstrap subset (the ~30 first-paint strings) synchronously until it
   resolves, or (b) keep en static but tree-shake to first-paint keys only and lazy
   the long tail. (a) is cleaner but needs a sync fallback to avoid a flash of raw
   message keys.
3. **Measure.** `bundle-kpi` initial-entry brotli before/after (expect ~−115 KB).
4. **Confidence: med** (mechanism is simple; the UX fallback is the catch).
5. **Impact: med** for the eager entry; **high** for non-English users who today
   pay en *plus* their locale.
6. **Risk: med** — a naive lazy-en flashes untranslated keys on first paint.
7. **Verify UX.** First paint shows English copy (not `accounts.add.apiKey`), and
   switching language still works. Add a unit test asserting first-paint strings
   resolve synchronously.

### O6 — Gate `prefetchRouteViewChunks`

1. **Problem.** `App.tsx:1101` schedules `prefetchRouteViewChunks()`
   (`App.tsx:203-221`) on idle after mount, fetching **14** route chunks
   (DatabasePageView, LogsView, …, BrowserWorkspaceView). This is deliberate
   warming but it competes for bandwidth/CPU during the post-mount window and is a
   chunk of the 8.4 MB measured `jsTransferred`.
2. **Fix sketch.** Gate behind `navigator.connection.saveData !== true`,
   `deviceMemory >= 4`, and not-metered; and stagger the loaders (one per idle tick)
   instead of firing all 14 at once. Keep the warm for capable devices.
3. **Measure.** `frontend-kpi` `jsTransferredBytes` + `requestCount` with the gate
   forced off vs on.
4. **Confidence: med.**
5. **Impact: med** on low-end (the explicit target of this task).
6. **Risk: low** (only changes *when* chunks load; first real nav still fetches).
7. **Verify UX.** First navigation to each view still completes promptly; on
   capable devices behavior is unchanged.

### O7 — Split the eager entry chunk

1. **Problem.** `index-joa_QlBT.js` is 5.23 MB raw / 1104 KB brotli — one parse blob
   gating first paint. After O2/O3/O5 land, re-measure; the residue is the true
   shell + everything Rollup folded into the entry because it's statically reachable
   from `main.tsx`.
2. **Fix sketch.** Identify the largest static contributors via `dist/stats.html`
   (rollup-plugin-visualizer, already emitted) and push non-first-paint subsystems
   behind dynamic boundaries / `manualChunks` (e.g. settings subsystems, editors,
   genui renderer) so the eager entry contains only shell + chat + header.
3. **Measure.** `bundle-kpi` initial-entry brotli; `frontend-kpi` long-tasks.
4. **Confidence: med** (depends on what O2/O3 leave behind — measure first).
5. **Impact: med-high** (entry parse cost on low-end CPUs).
6. **Risk: med** (over-splitting adds requests; balance against O4).
7. **Verify UX.** Shell + chat present at first paint; no view regressions in smoke.

### O8 — Precompressed assets + Content-Encoding (web/CDN path only)

1. **Problem.** No compression plugin in `vite.config.ts:1621-1627` (visualizer
   only); no `Content-Encoding` set anywhere in app-core serving. The web/CDN path
   (`asset-cdn.mjs` → jsdelivr) may already gzip, but the self-hosted web/dev static
   path serves raw (frontend-kpi serves raw → 8.4 MB). For Electrobun the renderer
   reads assets from local disk, so wire compression is N/A there (but parse cost,
   addressed by O2/O3/O7, still applies).
2. **Fix sketch.** Add `vite-plugin-compression2` (brotli + gzip) to emit
   `*.br`/`*.gz`, and have the self-hosted static server negotiate
   `Accept-Encoding`. Scope strictly to the web host; do not touch the desktop FS
   path.
3. **Measure.** Extend `frontend-kpi` to serve `.br` with `Content-Encoding: br`
   (or point `--url` at a brotli-serving preview); compare `jsTransferredBytes`.
   3.75 MB brotli vs 8.4 MB raw ≈ 55% wire reduction ceiling.
4. **Confidence: med** (need to confirm prod host doesn't already compress).
5. **Impact: med** (web only).
6. **Risk: low.**
7. **Verify UX.** Assets still load with correct content-type; desktop unaffected.

### O9 / O10 — mermaid (205 KB br) and draco (130 KB br) eager-vs-lazy audit

1. **Problem.** Both are heavy and should be reached only via their feature paths
   (mermaid: markdown diagram rendering; draco: GLTF/VRM mesh decode). Need to
   confirm neither is in the entry's eager set.
2. **Fix sketch.** If reachable statically from the shell, move behind dynamic
   import at the feature boundary.
3. **Measure.** Chunk-graph assertion (D2) that `mermaid-*`/`draco_*` are not in the
   entry's first-wave deps.
4. **Confidence: low** (likely already lazy — both appear as separate chunks).
5. **Impact: low-med.**
6. **Risk: low.**
7. **Verify UX.** Diagram rendering + 3D model decode still work.

---

## D. Measurement & Benchmark Plan

### D0 — Canonical before/after loop (all bundle optimizations)

```bash
# ALWAYS start from a clean build — never measure a watch dist (Finding F0).
ELIZA_DESKTOP_VITE_FAST_DIST="" bun run --cwd packages/app build:web
node packages/benchmarks/loadperf/bundle-kpi.mjs            # entry/total/dup brotli
node packages/benchmarks/loadperf/frontend-kpi.mjs          # FCP/LCP/JS-transfer/requests/long-tasks
```

Reproduced clean baseline (record these as the corrected `BASELINE.md`):
- bundle: total 3.75 MB br · entry 1104.4 KB br · largest 1104.4 KB br · dup 0.30 MB · 162 assets
- frontend (static raw serve): FCP 1152 ms · LCP 1152 ms · CLS 0 · JS 8447 KB (FAIL) · 109 req · long-tasks 411 ms

### D1 — Add CPU/network throttling to `frontend-kpi.mjs` (new instrumentation)

The local unthrottled FCP (1152 ms) hides waterfall/parse wins (O4/O7) that only
show on constrained hardware — the task's actual target. Add a `--throttle` flag
that drives Playwright CDP `Emulation.setCPUThrottlingRate` (e.g. 4×) and
`Network.emulateNetworkConditions` (Fast-3G profile). This makes O2/O3/O4/O7
movements observable in `fcpMs`/`lcpMs`/`longTasksMs`. Keep the unthrottled run as
the default budget gate; add the throttled run as a second recorded scenario.

### D2 — Harden `bundle-kpi.mjs` (Finding O1)

- Reachability: parse `index.html` entry, follow `__vite__mapDeps` + import edges,
  measure only reachable assets; report any unreachable `.js` as a separate
  "stale/orphan" line (and optionally fail if mtime-spread suggests a watch dist).
- Duplicate detection by *content hash* (md5), not hash-stripped logical name, so
  Rollup-auto-named `index`/`ui`/`web`/`register` chunks stop being counted as
  duplicates of each other.
- Add an `entryEagerGraph` section: brotli of the entry + its first-wave preload
  deps (the true "what loads before interaction" number) — this is the metric O2,
  O3, O5, O7 move.

### D3 — Boot-timing probe (Finding O2)

Add `performance.mark` calls in `main.tsx`: `eliza:entry-eval` (top of `main`),
`eliza:react-mount` (just before `createRoot().render`), `eliza:boot-config-ready`
(after `setBootConfig`). Surface via `performance.getEntriesByName` in
`frontend-kpi`'s `COLLECT` block and record `mountMs` / `bootConfigReadyMs`. O2's
success = `mountMs` drops from "after full plugin init" to "≈ entry-eval".

### D4 — Functional regression gate (every optimization)

```bash
bun run --cwd packages/app test:e2e        # Playwright ui-smoke
bun run --cwd packages/app build           # full app build still succeeds
```
The ui-smoke must show: agent responds to a chat turn, view switching works, a
plugin-loaded view renders and its view-dependent actions fire (the explicit
"don't break functionality" constraint).

---

## E. Prioritized Backlog (confidence × impact, high → low)

1. **O1 — Clean dist + reachable-only KPI** (high × high). Foundation: every other
   number is meaningless until the KPI measures the live graph. Also corrects
   `BASELINE.md`. Zero app risk.
2. **O2 — Mount React before full plugin init** (high × high). Largest TTI lever;
   removes ~17 plugin chunks (incl. three) from first paint. Needs D3 + D4.
3. **O3 — three.js off the boot path** (high × high). −330 KB brotli / ~1.5 MB raw
   eager for the common no-avatar session. Pairs naturally with O2.
4. **O4 — modulepreload first wave** (high × med). Waterfall → parallel; measurable
   under D1 throttling.
5. **O5 — lazy default locale** (med × med, high for non-EN). −~115 KB brotli eager;
   watch the first-paint-key fallback.
6. **O7 — split the residual entry chunk** (med × med-high). Do *after* O2/O3/O5 and
   re-measure with stats.html.
7. **O6 — gate route prefetch** (med × med on low-end). Cheap; directly cuts
   measured `jsTransferred`.
8. **O8 — precompressed assets / Content-Encoding** (med × med, web only). Confirm
   prod host first; N/A for desktop FS.
9. **O9 / O10 — mermaid + draco lazy audit** (low × low-med). Likely already lazy;
   verify with the D2 eager-graph section.

### One-line corrected truth for BASELINE.md

> Clean `build:web` ships **3.75 MB brotli total / 1104 KB brotli eager entry**, all
> four bundle budgets PASS. The "2.33 MB duplicate-lib FAIL" was a stale watch-mode
> `dist` artifact (`emptyOutDir: !desktopFastDist`), not the shipped bundle. The real
> levers are boot-blocking plugin init (`main.tsx:2185`), three.js on the boot path
> (`main.tsx:525`), missing `modulepreload`, and the 8.4 MB *raw* JS pulled at load
> (frontend-kpi `jsTransferred` FAIL).
