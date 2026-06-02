# Agent Boot & Plugin Loading — Optimization Research

Scope: `packages/agent/src/runtime/**`, `packages/agent/src/api/views-*`,
`packages/app-core/src/runtime/{eliza.ts,dev-server.ts}`, `boot-timer.ts`,
`boot-telemetry.ts`, `plugin-resolver.ts`, `packages/app-core/src/config/`.

Measured on `develop` @ `8a6114be47` (local mode), Linux x86_64, with ~8 sibling
agent processes also running (this contention is itself a finding — see F8).
State dir: `~/.local/state/eliza`. Telemetry: `~/.local/state/eliza/telemetry/`.

---

## A. Critical Assessment

### A.1 The headline number is real and FAILS budget

Ground-truth cold boot, isolated port, telemetry on:

```
node packages/benchmarks/loadperf/boot-kpi.mjs   (ELIZA_API_PORT=31355)
→ readyMs = 28398 ms   (budget 25000 → FAIL)
→ peakRssMb = 1272.7   (budget 1600 → pass)
```

A second clean instrumented run reached `ready:true` at **t+23085 ms**
(22 plugins, 0 failed). A third run under heavy contention spiked to **>33 s**
and then errored. Boot time is both **over budget** and **high-variance**.

The earlier recorded `latest.json` showing `readyMs:70` / `peakRssMb:46.6` is a
**measurement artifact**, not a fast boot: that capture was taken when the
spawned dev-server died early / a stale server answered, and `waitForReady()`
in `lib.mjs:121` treats a 200 with `ready===undefined` as ready. The KPI's own
budget check passed against a server that was never actually up. This is the
single most important correctness issue in the harness for this scope (see F1).

### A.2 What `ready:true` actually gates on

- `dev-server.ts:436` starts the API server with `initialAgentState:"starting"`.
- `health-routes.ts:531`: `ready = state.agentState !== "starting" && !== "restarting"`.
- `agentState` flips to `"running"` only in `dev-server.ts:223` (`apiUpdateStartup({state:"running"})`),
  which runs **after** `await createRuntime()` returns in `bootstrapRuntime()`
  (`dev-server.ts:200`).
- `createRuntime()` → `startEliza({headless:true})`. In headless mode `startEliza`
  returns the runtime at `eliza.ts:4864`, immediately after the **blocking** boot
  phase (`initializeRuntimeServices`, `eliza.ts:4771`) and after firing
  `kickoffDeferredBoot()` (`eliza.ts:4860`, fire-and-forget `void`).

So readiness should be gated on the **blocking** phase only. The BootTimer
confirms the blocking phase is cheap:

```
~/.local/state/eliza/telemetry/boot/latest.json   ([eliza-boot] BootTimer)
  static-plugins-blocking-import   834 ms  (t+834)
  pre-resolve-setup                265 ms  (t+1099)
  resolve-plugins-blocking-import  244 ms  (t+1343)
  register-sql                     503 ms  (t+1846)
  svc:pre-init                      30 ms  (t+1876)
  svc:runtime.initialize           309 ms  (t+2185)
  → total to readiness gate: ~2186 ms
```

**The blocking boot to the readiness gate is ~2.2 s, yet wall-clock `ready:true`
is 23–28 s.** The other ~20–26 s is the gap this report dissects.

### A.3 Where the 20+ seconds actually goes (wall-clock reconstruction)

From the instrumented run (`ELIZA_API_PROCESS_SPAWNED_AT_MS` set, `LOG_LEVEL=info`):

| Phase | Evidence (file:line of log) | Wall cost |
| --- | --- | --- |
| **tsx transpile + ESM import of dev-server graph** (pre-module-body) | `dev-server.ts:51` "pre-body/import delay" | **3147 ms** (5528 ms under contention) |
| API server `startApiServer()` await | `dev-server.ts:481` "API server ready … (1251ms)" | **1251 ms** |
| **gap: apiReady → `scheduleRuntimeBootstrap`** inside `main()` | `dev-server.ts:520` "Startup init complete in 7042ms" | **~5.8 s** (22.2 s under contention) |
| blocking agent boot (BootTimer total) | `eliza.ts:4599` `svc:runtime.initialize` | **~1.7–2.2 s** |
| **deferred boot starving the event loop before `state:running` flips** | `eliza.ts:4815` `runDeferredBoot`; `dev-server.ts:223` | **~10 s** |

Two structural problems dominate:

1. **The "non-blocking" deferred boot blocks readiness in practice.**
   `kickoffDeferredBoot()` (`eliza.ts:4814`) is `void`-ed, but `runDeferredBoot`
   immediately does `resolveDeferredPluginsForBoot()` → `resolvePlugins(...,phase:"deferred")`
   which `import()`s **12–13 plugin modules**. Log: `[eliza] Plugin loading took
   6961ms` and `deferred:resolve-plugins-import: 8553ms` (`eliza.ts:4705`).
   These dynamic imports are CPU-bound module evaluation on the single main
   thread. The `await createRuntime()` continuation in `bootstrapRuntime`
   (`dev-server.ts:200`) — which is what flips `agentState` to `"running"` and
   makes `ready:true` — cannot run until that import storm yields the loop.
   **Proof:** `Runtime created in 11837ms` (`dev-server.ts:202`, logged at stdout
   line 256) appears *after* `Plugin loading took 6961ms` (line 191) and after
   `deferred:complete` (line 249), even though the headless return
   (`Runtime initialised in headless mode`, line 154) logged ~10 s earlier. The
   deferred wave runs to completion before the readiness flip gets a turn.

2. **A ~5.8 s gap (22 s under load) between "API server ready" and
   "Startup init complete"** inside `main()` in `dev-server.ts` (between line 481
   and line 520). The awaited work there is `syncResolvedApiPort`, the dynamic
   `import("../api/server-cors.js")` (`dev-server.ts:473`),
   `ensureAuthPairingCodeForRemoteAccess()` (`dev-server.ts:484`), and banner
   formatting — all one-time but partly I/O/import-bound, and it competes with
   the tail of the API server's own async work.

### A.4 Memory

Peak RSS 1010–1272 MB. `process.memoryUsage()` at boot-telemetry record time:
`external: 417 MB`, `arrayBuffers: 19 MB`, `heapTotal: 449 MB`. The large
`external` is native-addon / node-llama-cpp / PGlite WASM territory, pulled in by
`@elizaos/plugin-local-inference` (BLOCKING) and `@elizaos/plugin-sql` (PGlite).
Embedding GGUF is correctly deferred (`warmEmbeddingModel`, `eliza.ts:4500`,
fired at `eliza.ts:4752`) and only prefetches to disk — it does not load into
memory at boot, so it is **not** a boot-RSS contributor. RSS is within budget but
the 417 MB external is the lever if the budget tightens.

### A.5 Caching that already exists (do not re-implement)

The 186-package "plugin-manifest fs scan" the brief flags as cacheable **is
already cached**, twice:
- `pluginCandidateCache` (`plugin-resolver.ts:1310`) — keyed on a signature of
  the mtimes of each scanned root (`computePluginCandidateSignature`,
  `plugin-resolver.ts:1358`). 179 `node_modules/@elizaos/{plugin,app}-*` + 185
  workspace `plugins/*` dirs, scanned once per process.
- `pluginVerdictCache` (`plugin-resolver.ts:1326`) — keyed on candidate signature
  + a fingerprint of env+config.

So discovery is **not** the bottleneck. The cost is **module `import()`
evaluation** of the resolved plugins, plus filesystem **staging** (F4).

---

## B. Optimization Catalog

| # | Optimization | Conf. | Impact | Risk | Rank |
| --- | --- | --- | --- | --- | --- |
| F1 | Fix boot-KPI false-positive: require `ready===true` (not 200-with-no-field) | High | High (correctness of the whole gate) | Low | 1 |
| F2 | Decouple `state:"running"` flip from deferred event-loop starvation (flip on blocking-phase completion, not after `await createRuntime` is starved) | High | High (~10 s) | Med | 2 |
| F3 | Yield the loop between deferred plugin imports / cap deferred concurrency so the readiness continuation is not starved | High | High (~8–10 s) | Low | 3 |
| F4 | Skip per-plugin `fs.cp` staging for workspace-override + dev plugins (`stagePluginImportRoot`) | Med-High | High (multiple seconds of deferred I/O; also disk growth) | Med | 4 |
| F5 | Close the apiReady→bootstrap `main()` gap (5.8 s): start runtime bootstrap before the cosmetic banner/pairing/cors-import block | High | Med (~hundreds ms–seconds) | Low | 5 |
| F6 | Reduce tsx transpile cost of the dev-server import graph (precompiled entry / fewer eager static imports) | Med | Med (~3 s pre-body) | Med | 6 |
| F7 | Make `computeVerdictFingerprint` cheaper (hash, not full env+config string, built twice/boot) | Med | Low (10s of ms) | Low | 7 |
| F8 | Document/normalize measurement under CPU contention; pin boot-kpi to fewer cores or quiesce siblings | High | Med (variance, not mean) | Low | 8 |

---

## C. Detailed Findings

### F1 — Boot-KPI reports a false PASS when the server isn't actually ready

**(1) Problem + evidence.** `lib.mjs:121`:
```js
if (body == null || body.ready === undefined || body.ready === true) {
  return { readyMs: Date.now() - begin, health: body };
}
```
The health endpoint (`health-routes.ts:534`) **always** returns a `ready` field,
so the `ready === undefined` branch should never fire for a live agent server —
but it fires for *any other* 200 (a stale server on the port, a different
service, an early liveness handler). The recorded `results/boot/latest.json`
(`readyMs:70, peakRssMb:46.6, healthReady:null`) is exactly this: `healthReady`
is `null`, meaning the body had no `ready:true`, yet the KPI recorded PASS. A 46 MB
RSS is impossible for a booted agent (real boot is ~1000 MB). The gate is lying.

**(2) Fix sketch.** In `waitForReady` (`lib.mjs:104`) require `body?.ready === true`
for the spawn path; keep the 200-compat only behind an explicit opt-in flag for
"older builds". For `boot-kpi.mjs` specifically, fail the run if `health.ready`
is not `true` at return. (Out of *this* report's edit scope — harness file — but
it is the prerequisite for trusting every other number.)

**(3) Measurement.** Before: `latest.json` `readyMs:70 healthReady:null pass:true`.
After (already observed by polling `ready===true` manually): `readyMs≈23000–28000`.
Command to reproduce the truthful number today, bypassing the harness bug:
```bash
SPAWN=$(node -e 'console.log(Date.now())'); \
ELIZA_API_PROCESS_SPAWNED_AT_MS=$SPAWN ELIZA_HEADLESS=1 ELIZA_API_PORT=31355 \
  node --conditions=eliza-source --import tsx \
  packages/app-core/src/runtime/dev-server.ts & \
node -e 'const b="http://127.0.0.1:31355";const s=Date.now();(async()=>{for(;;){try{const r=await fetch(b+"/api/health");const j=await r.json();if(j.ready===true){console.log("ready",Date.now()-s);process.exit()}}catch{}await new Promise(r=>setTimeout(r,150))}})()'
```

**(4) Confidence:** High. **(5) Impact:** High — without it, no boot optimization
is measurable. **(6) Risk:** Low. **(7) Verify:** assert `result.summary.healthReady === true`
in the KPI; assert `readyMs > 5000` sanity floor (a real agent boot can never be
sub-second).

---

### F2 — Readiness flips only after the deferred wave drains the event loop

**(1) Problem + evidence.** `agentState` → `"running"` happens at
`dev-server.ts:223` only after `await createRuntime()` (`dev-server.ts:200`)
resolves. `createRuntime` → `startEliza` returns at `eliza.ts:4864`, but it first
calls `kickoffDeferredBoot()` (`eliza.ts:4860`) which schedules `runDeferredBoot`
(`eliza.ts:4814`). Although `void`-ed, the deferred wave's synchronous `import()`
evaluation monopolizes the main thread, so the `await createRuntime()` promise
continuation (the `apiUpdateRuntime`/`state:"running"` block) does not get a
turn until the deferred imports finish. Stdout proof: `Runtime initialised in
headless mode` (line 154) → `Plugin loading took 6961ms` (line 191) →
`Runtime created in 11837ms` (line 256). The 10 s between line 154 and 256 is
pure starvation: nothing should be between the headless return and the
caller's "Runtime created" log except a microtask hop.

**(2) Fix sketch.** Flip `agentState`→`running` (and broadcast `ready:true`) the
moment the **blocking** phase completes, decoupled from the deferred wave. Two
clean options:
  - In `dev-server.ts` `bootstrapRuntime`, call `apiUpdateStartup({state:"running"})`
    immediately after `apiUpdateRuntime(rt)` (which it already does at line 215–223)
    — the bug is not the ordering in dev-server, it's that the `await` never
    resolves promptly. So the real fix is F3 (yield the loop), OR
  - Have `startEliza` resolve its returned promise *before* invoking
    `kickoffDeferredBoot` by deferring the kickoff to a macrotask
    (`setTimeout(kickoffDeferredBoot, 0)` / `setImmediate`) AFTER the function
    returns, so the caller's continuation runs first. Today `kickoffDeferredBoot`
    is called synchronously inside `startEliza` before `return runtime`
    (`eliza.ts:4860` then `4864`); even though the deferred body is async, its
    first `await resolvePlugins(...)` kicks off import work synchronously up to
    the first real await.

**(3) Measurement.** Before: blocking gate at BootTimer t+2186 ms, but `ready:true`
at wall t+23085 ms. After (target): `ready:true` within ~2–4 s of the blocking
gate completing (i.e. wall ≈ pre-body 3 s + apiReady 1.3 s + gap fix F5 + blocking
2 s ≈ **7–9 s**). Reproduce with the F1 poller; compare wall-`ready` to the
`svc:runtime.initialize` lap in `telemetry/boot/latest.json`.

**(4) Confidence:** High (mechanism proven by log ordering). **(5) Impact:** High,
~10 s. **(6) Risk:** Med — must ensure deferred capabilities still register and
that the UI's "agent running" state isn't shown before chat actually works.
Verify a chat round-trips immediately after `ready:true` (the message-handler
actions are in the blocking set; deferred plugins are connectors/feature surfaces,
not the core chat path — see `core-plugins.ts:112` BLOCKING_CORE_PLUGINS).
**(7) Verify nothing breaks:** after the change, POST a message to
`/api/messages` (or the chat endpoint) right after `ready:true` and confirm a
response; confirm deferred plugins still log "registered" within ~10 s; run
`bun run --cwd packages/agent test` for the runtime boot suite.

---

### F3 — Deferred plugin imports run with no event-loop yielding

**(1) Problem + evidence.** `resolveDeferredPluginsForBoot` (`eliza.ts:4694`)
calls `resolvePlugins(config,{phase:"deferred"})` which loads 13 plugins; the
register step (`registerDeferredRuntimePlugins`, `eliza.ts:4666`) uses
`Promise.all(...)` so all register concurrently, but the expensive part is the
**import evaluation** that precedes it. `[eliza] Plugin loading took 6961ms`
with per-plugin times of 243–881 ms (`task-coordinator 565`, `agent-orchestrator
881`, `commands 652`, `video 644`, `shell 757`, `coding-tools 707`) — these are
sequential module evaluations that never yield to let the readiness continuation
(F2) run.

**(2) Fix sketch.** (a) Hand control back after the blocking phase: schedule the
deferred resolve on a `setImmediate`/`queueMicrotask` boundary so the readiness
flip's continuation runs first (pairs with F2). (b) Optionally insert
`await new Promise(r=>setImmediate(r))` between deferred plugin imports/registers
so the HTTP server and the readiness broadcast keep getting turns. (c) Consider a
worker thread for plugin module evaluation only if (a)+(b) prove insufficient —
higher risk, not recommended first.

**(3) Measurement.** Before: deferred lap `deferred:resolve-plugins-import: 8553ms`
(`eliza.ts:4705`), and `ready:true` blocked behind it. After: deferred lap
unchanged in *total* but `ready:true` no longer waits on it; re-read
`telemetry/boot/latest.json` laps + the F1 wall-`ready`.

**(4) Confidence:** High. **(5) Impact:** High (the ~8–10 s is the bulk of the
gap). **(6) Risk:** Low (pure scheduling). **(7) Verify:** confirm all 13 deferred
plugins still register (grep stdout for `deferred: ✓`), `validateIntentActionMap`
(`eliza.ts:4763`) still runs once, no double-registration.

---

### F4 — Per-plugin filesystem staging (`fs.cp` into a fresh mkdtemp) on every boot

**(1) Problem + evidence.** `importPluginModuleFromPath` (`plugin-resolver.ts:717`)
calls `stagePluginImportRoot` (`plugin-resolver.ts:1190`) which, for installed
plugins, does `fs.mkdtemp` then `fs.cp(packageRoot → staged, {recursive:true})`
(`plugin-resolver.ts:1217`) plus node_modules staging (`stageNodeModulesEntries`,
`plugin-resolver.ts:966`, more recursive `fs.cp`). It even prunes prior staging
dirs (`pruneStalePluginInstances`, `plugin-resolver.ts:1074`) and the comment at
`1061` notes "the same plugin can accumulate thousands of stale installs … and
consume hundreds of GB." This recursive copy runs per installed plugin per boot
and is I/O-bound work piled onto the deferred wave. Workspace-override plugins
(resolved via `getWorkspacePluginOverridePath`, `plugin-resolver.ts:548`) and
statically-imported plugins skip staging; only the installed-from-disk path
stages — but on a dev box with installed plugins this is multiple seconds of
recursive copy.

**(2) Fix sketch.** For the common case (dev/local mode, workspace + node_modules
symlinks, no per-boot mutation), skip the copy and import directly from
`packageRoot` when the package has a stable `dist/` and no pending reinstall —
gate on a "needs fresh snapshot" flag instead of always staging. The staging
exists to defeat ESM module-graph caching across hot-reloads of *mutated*
plugins; a cold boot has no prior graph to bust, so the first boot can import in
place. Keep staging only for the reinstall/hot-swap path.

**(3) Measurement.** Before: instrument `stagePluginImportRoot` with a lap, or
diff `deferred:resolve-plugins-import` (8553 ms) against a run with
`ELIZA_STAGE_FULL_PLUGIN_PACKAGE` unset and plugins symlinked (workspace path,
no staging) — the workspace-only blocking phase resolves in 244 ms vs deferred
8553 ms partly because deferred plugins hit the staging copy. After: re-measure
the deferred lap and wall-`ready`.

**(4) Confidence:** Med-High (path is clearly per-boot recursive `fs.cp`; exact
seconds depend on how many plugins are *installed* vs symlinked on the target).
**(5) Impact:** High when installed plugins are present; also fixes unbounded
disk growth. **(6) Risk:** Med — must not break hot-reload of mutated plugins;
keep staging on the reinstall path. **(7) Verify:** install a plugin, reinstall a
changed version, confirm the new code loads (staging still used on reinstall);
confirm cold boot imports without minting a new `.runtime-imports/<plugin>/…` dir.

---

### F5 — 5.8 s gap inside `main()` between API-ready and runtime bootstrap

**(1) Problem + evidence.** `dev-server.ts:481` logs `API server ready … (1251ms)`
but `dev-server.ts:520` logs `Startup init complete in 7042ms`. The ~5.8 s
between is: `syncResolvedApiPort` (`dev-server.ts:468`), dynamic
`import("../api/server-cors.js")` (`dev-server.ts:473`),
`ensureAuthPairingCodeForRemoteAccess()` (`dev-server.ts:484`), `resolveApiToken`,
and ~30 lines of banner `console.log`. Under contention this ballooned to
22195 ms — meaning some of it is import/CPU-bound and starvation-sensitive, not
fixed-cost printing. `scheduleRuntimeBootstrap(0,…)` (`dev-server.ts:517`) only
fires after all of it.

**(2) Fix sketch.** Move `scheduleRuntimeBootstrap(0,"startup")` to immediately
after `apiUpdateStartup({phase:"api-ready"})` (`dev-server.ts:448`), before the
cosmetic banner + pairing + cors-invalidate block. The bootstrap is already async
(`setTimeout`-scheduled), so the banner can print concurrently. The cors-cache
invalidation and pairing code are not prerequisites for runtime boot.

**(3) Measurement.** Before: "Startup init complete in 7042ms". After: bootstrap
`Runtime bootstrap starting` log timestamp should move ~5 s earlier relative to
"API server ready". Diff the two stdout log lines.

**(4) Confidence:** High. **(5) Impact:** Med (hundreds of ms of fixed cost, but
removes 5 s of *starvation-amplified* serial work from the critical path).
**(6) Risk:** Low. **(7) Verify:** pairing code + banner still print; CORS still
allows the resolved port (the invalidate runs before any cross-origin request
arrives in practice; if racy, await it but off the bootstrap path).

---

### F6 — tsx transpile of the dev-server import graph (3–5.5 s pre-body)

**(1) Problem + evidence.** `dev-server.ts:51` logs `pre-body/import delay:
3147ms` (5528 ms under contention). This is `--import tsx` transpiling + ESM
graph evaluation of everything `dev-server.ts` statically imports
(`dev-server.ts:35–79`: `@elizaos/shared`, `../api/auth-pairing-routes`,
`../api/server`, and transitively `./eliza` which is a 46 KB module with a huge
static import surface, `eliza.ts:1–260`). This happens before any boot logic runs
and before the readiness gate.

**(2) Fix sketch.** (a) For the production/benchmark path, run a **prebuilt**
`dist/` entry instead of tsx-transpiling source on every spawn (the desktop shell
already imports `dist/entry.js` per app-core CLAUDE.md). (b) Convert heavy static
imports in `dev-server.ts` / top of `eliza.ts` to dynamic `import()` inside the
boot functions where they're first used, shrinking the eager graph tsx must
transpile before `main()`. Candidates: the `@elizaos/shared` barrel
(`eliza.ts:101`) pulls a large surface; `createElizaPlugin`/api modules.

**(3) Measurement.** Before: `pre-body/import delay: 3147ms` (`dev-server.ts:51`).
After: re-read the same log line. Also compare `node --import tsx … dev-server.ts`
vs `node dist/.../dev-server.js` cold.

**(4) Confidence:** Med (the 3 s is measured; the achievable reduction depends on
how much of the graph is genuinely needed before listen). **(5) Impact:** Med
(~3 s). **(6) Risk:** Med — moving static→dynamic imports can reorder side effects;
the file already documents one module-init cycle hazard (`eliza.ts:71–83`) — do
not break it. **(7) Verify:** `bun run --cwd packages/agent typecheck`; boot still
reaches `ready:true`; no `undefined export` crashes (the cycle guard).

---

### F7 — `computeVerdictFingerprint` serializes the entire env + config, twice per boot

**(1) Problem + evidence.** `plugin-resolver.ts:1338` builds the verdict-cache key
by sorting and joining **every** `process.env` entry plus `JSON.stringify(config)`
(`plugin-resolver.ts:1342–1348`), once per `resolvePlugins` call. `resolvePlugins`
runs at least twice per boot (blocking `eliza.ts:3704`, deferred `eliza.ts:4701`).
With a large env (hundreds of vars on a dev box) + a large config this is a
multi-KB string built and compared each time. The comment calls it "cheap relative
to ~180 disk reads" — true, but the 180 reads are themselves cached
(`pluginCandidateCache`), so the fingerprint is now a larger share of the
non-cached resolve cost than intended.

**(2) Fix sketch.** Hash the fingerprint (e.g. a cheap non-crypto hash of the
sorted env entries + config string) and store/compare the hash, not the full
string. Or capture the env/config snapshot once at boot start and pass a stable
version token, since neither changes between the blocking and deferred passes in
a single boot (config is only rewritten by first-run setup, which is its own
restart).

**(3) Measurement.** Before/after: micro-instrument with `performance.now()`
around the `verdictKey` build (`plugin-resolver.ts:1560`) and log; or A/B the
`resolve-plugins-blocking-import` lap (currently 244 ms).

**(4) Confidence:** Med (the cost is real but small). **(5) Impact:** Low (tens of
ms). **(6) Risk:** Low — a hash collision would wrongly reuse verdicts; use a
64-bit+ hash and include lengths to make collisions implausible. **(7) Verify:**
verdicts still recompute when an env var that flips a `shouldEnable` changes
(toggle e.g. `ENABLE_AUTONOMY` and confirm re-evaluation).

---

### F8 — Boot is single-threaded and import-bound, so it is acutely CPU-contention-sensitive

**(1) Problem + evidence.** Three runs of the same boot produced 23085 ms,
28398 ms, and >33201 ms (the last erroring) — the variance tracks the number of
sibling processes contending for cores (8 parallel agents were running per the
task context; BASELINE.md:30 also notes a prior boot died to a "concurrent
process rewriting packages/app-core"). Because the critical path is dominated by
synchronous tsx transpile + ESM module evaluation (F6) and serial plugin
imports (F3), it has near-zero parallelism to hide contention.

**(2) Fix sketch.** Not a code fix per se: (a) the F2/F3/F5/F6 fixes shrink the
serial import surface and thus the contention exposure; (b) the boot-kpi should
either quiesce siblings or pin to a fixed cpuset (`taskset`) and record load
average alongside `readyMs` so regressions are separable from noise.

**(3) Measurement.** Record `os.loadavg()` and `os.cpus().length` in the boot-kpi
result payload; run N=5 and report median + p95, not a single sample.

**(4) Confidence:** High. **(5) Impact:** Med (variance/repeatability, not mean).
**(6) Risk:** Low. **(7) Verify:** run boot-kpi 5× on a quiet box; expect tight
clustering after F2/F3.

---

## D. Measurement & Benchmark Plan (exact commands)

All commands from repo root `packages/...` (i.e. run inside
`/home/shaw/milady/eliza`).

**D.1 Truthful cold readyMs + peak RSS (works today; fix F1 to make the harness
trustworthy):**
```bash
node packages/benchmarks/loadperf/boot-kpi.mjs --json
# isolate from a stale dev server on 31337:
ELIZA_API_PORT=31355 LOADPERF_BASE_URL=http://127.0.0.1:31355 \
  node packages/benchmarks/loadperf/boot-kpi.mjs --json
```
Reject the result unless `summary.healthReady === true` and `readyMs > 5000`.

**D.2 Per-phase BootTimer breakdown (blocking phase only):**
```bash
cat ~/.local/state/eliza/telemetry/boot/latest.json
# laps: static-plugins-blocking-import, pre-resolve-setup,
#       resolve-plugins-blocking-import, register-sql, svc:pre-init,
#       svc:runtime.initialize  → total ≈ readiness-gate cost (~2.2s)
```

**D.3 Full wall-clock critical path (the part BootTimer does NOT cover):**
```bash
SPAWN=$(node -e 'console.log(Date.now())')
ELIZA_API_PROCESS_SPAWNED_AT_MS=$SPAWN ELIZA_HEADLESS=1 ELIZA_API_PORT=31357 \
  LOG_LEVEL=info node --conditions=eliza-source --import tsx \
  packages/app-core/src/runtime/dev-server.ts > /tmp/boot.log 2>&1 &
# then poll ready===true (see F1 snippet) and grep the markers:
grep -E "pre-body/import delay|API server ready|Startup init complete|\
Runtime bootstrap starting|svc:runtime.initialize|Runtime initialised in headless|\
Plugin loading took|deferred:resolve-plugins-import|Runtime created|Runtime ready" /tmp/boot.log
```
Key spans to watch:
- `pre-body/import delay` (F6, ~3 s)
- `API server ready (…ms)` (~1.3 s)
- `Startup init complete in …ms` minus the above (F5 gap, ~5.8 s)
- `Plugin loading took …ms` / `deferred:resolve-plugins-import` (F3, ~8.5 s) —
  and whether `Runtime created` is starved behind it (F2).

**D.4 Deferred-staging cost (F4):** add a temporary lap in
`stagePluginImportRoot` or compare `deferred:resolve-plugins-import` between a
boot with installed plugins vs all-symlinked workspace plugins.

**D.5 Repeatability (F8):** run D.1 five times; report median + p95; capture
`uptime`/`loadavg` per run.

---

## E. Prioritized Backlog (ranked by confidence × impact)

1. **F1 — Fix the boot-KPI false PASS.** *Prerequisite for everything.* The
   committed `latest.json` (70 ms / 46 MB) is fictional; real cold boot is
   23–28 s and **fails** the 25 s budget. (High × High)

2. **F2 + F3 — Stop the deferred wave from starving the readiness flip.** Yield
   the event loop after the blocking phase so `agentState:"running"`/`ready:true`
   is broadcast ~immediately at BootTimer t+2.2 s instead of after the ~8–10 s
   deferred import storm. Largest single win (~10 s). (High × High)

3. **F4 — Skip per-boot `fs.cp` plugin staging on the cold path.** Import installed
   plugins in place on first boot; reserve staging for hot-reload/reinstall. Saves
   seconds of deferred I/O and stops unbounded `.runtime-imports` disk growth.
   (Med-High × High)

4. **F5 — Fire `scheduleRuntimeBootstrap` before the banner/pairing/cors block.**
   Removes ~5.8 s (starvation-amplified) of serial pre-bootstrap work from the
   critical path. (High × Med)

5. **F6 — Cut the tsx pre-body import delay (~3 s).** Prebuilt `dist` entry for the
   benchmark/prod path and/or dynamic-import the heaviest static deps in
   `dev-server.ts`/`eliza.ts`, respecting the documented module-init cycle.
   (Med × Med)

6. **F8 — Make boot measurement contention-robust** (median/p95, loadavg capture,
   optional cpuset pin). (High × Med, variance only)

7. **F7 — Hash `computeVerdictFingerprint`** instead of building/comparing the full
   env+config string twice per boot. (Med × Low)

**Projected effect (F2+F3+F5 alone):** wall `ready:true` ≈ pre-body (3 s) +
apiReady (1.3 s) + blocking boot (2 s) ≈ **6–9 s**, comfortably under the 25 s
budget and ~3–4× faster than today, with no loss of deferred capability (they
register in the background as before). Adding F4/F6 targets sub-6 s.

> Note: All findings are research-only. No source files in scope were modified
> (per the 8-parallel-agent protocol). The single deliverable is this report.
