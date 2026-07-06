# Coding-capability test-harness initiative — progress & evidence log

Live tracker for the gap backlog in [`MASTER_PLAN.md`](./MASTER_PLAN.md) (85 gaps:
8 critical, 33 high, 35 medium, 9 low). Structured findings in
[`findings.json`](./findings.json). Branch: `feat/coding-capability-test-harness`.

Each completed item records the **verification evidence** (reproduced-before →
verified-after) so a reviewer can confirm it without reading the code, per
`AGENTS.md`.

Legend: ✅ done & verified · 🔧 in progress · ⏳ queued · ⛔ blocked

---

## Wave 0 — unblock CI & fix correctness bugs (blocks everything)

### ✅ 0.1 (E) Fix `@elizaos/shared` vitest resolution so the TaskInspector suite loads
- **File:** `plugins/plugin-task-coordinator/vitest.config.ts`
- **Root cause:** the `@elizaos/ui` source alias pulls in `@elizaos/shared/*`
  subpaths (`voice-eot`, `transcripts`, `contracts/*`, …). Those ship only from
  `dist/`, which was stale/unbuilt → the whole suite failed to load (`Failed to
  resolve import "@elizaos/shared/voice-eot"`), so `bun run test` exited non-zero
  and the 18-test inspector suite never ran.
- **Fix:** added blanket `@elizaos/shared` + `@elizaos/shared/*` → source aliases
  (mirrors the existing ui/tui/plugin-browser/plugin-training pattern; suite runs
  in the `node` environment so node-only shared modules load fine).
- **Evidence:**
  - BEFORE: `orchestrator-inspector-terminal-task.test.tsx` → `0 test`, suite
    failed to load on `@elizaos/shared/voice-eot`; package `test` exit 1.
  - AFTER: inspector suite **18 passed**; full package suite **136 passed (12
    files)**, exit 0.

### ✅ 0.2 (L) Default per-session workspace isolation (CRITICAL correctness)
- **Root cause (audit #1 finding):** `resolveDefaultSpawnWorkdir` collapsed every
  route-less concurrent task into ONE shared dir (a configured
  `ELIZA_ACP_WORKSPACE_ROOT`/`ACPX_DEFAULT_CWD`, or the direct-caller
  `DEFAULT_WORKDIR_ROOT`) → simultaneous projects corrupt each other's files.
- **Fix (preserves self-checkout):** the resolver now flags a *shared scratch
  root* with `isolate: true` (cwd self-checkout + route/convention/explicit dirs
  are NOT flagged); `spawnSession` then lands each session in its own
  `<root>/task-<sessionId>` subdir via a new pure, exported `computeSessionWorkdir`.
  Direct (non-orchestrated) callers always isolate (no self-checkout intent).
  Threaded through `SpawnOptions.isolateWorkdir` + both `tasks.ts` spawn sites.
  Files: `task-agent-routing.ts`, `services/types.ts`, `actions/tasks.ts`,
  `services/acp-service.ts`.
- **Evidence:** new `__tests__/unit/workspace-isolation.test.ts` proves two
  route-less concurrent spawns under a configured root get DISTINCT workdirs and
  self-checkout stays in cwd un-isolated; updated `resolve-spawn-workdir.test.ts`
  (+`isolate: true`) and `acp-service.test.ts` (direct-caller now isolates).
  Full orchestrator unit suite **687 passed (59 files)**; typecheck exit 0.

### ✅ 0.3 (H) Two-phase reload + rollback (CRITICAL correctness)
- **Root cause:** `applyPluginRuntimeMutation`'s `plugin_reload` path unloads
  plugins then registers replacements; on a register-throw it jumped straight to
  a restart fallback. When `restartRuntime` was absent (or failed) the runtime
  was left **half-torn-down** — plugins unloaded, replacement not registered.
- **Fix:** added `rollbackPartialReload` — on a reload throw, unregister anything
  newly registered, then re-register the unloaded plugins from their PREVIOUS
  resolved definitions, restoring the pre-reload graph BEFORE any restart
  fallback. Clean rollback returns `restart_required` (caller schedules a restart
  to apply the failed change; the old plugin keeps working meanwhile). Files:
  `packages/agent/src/api/plugin-runtime-apply.ts`.
- **Evidence:** NEW `plugin-runtime-apply.test.ts` (the pipeline had ZERO tests)
  — 5 passing: none / config_apply / plugin_reload / **rollback-on-register-throw
  (asserts the PREVIOUS plugin is re-registered)** / runtime_reload adapter
  escalation. Agent `typecheck` exit 0.
- **Deferred → Wave 3.4 (lifecycle/rollback):** the cold-restart "keep old
  runtime until new boots" contract lives in the opaque `restartRuntime` closure
  in the API boot path (large, full-boot-only-verifiable) + the
  `load-plugin-from-directory` edit→v2 reload test. Grouped with lifecycle
  scenarios there, per the master plan.

---

**Wave 0 COMPLETE** ✅ (0.1, 0.2, 0.3-critical, 0.4). CI suite unblocked; both
critical correctness bugs (workspace collision, reload half-state) fixed + tested.

### ✅ 0.4 (B) Repair broken task-agent live E2E + drift guard
- **Root cause (3 axes, all confirmed):** the e2e
  (`plugins/plugin-agent-orchestrator/src/__tests__/task-agent-live.e2e.test.ts`)
  pointed at a **missing** path (`packages/app-core/test/scripts/…`); invoked a
  **`counter-app` mode** the smoke script never had; and the smoke script
  (`packages/core/test/live/task-agent-live-smoke.ts`) imported **removed symbols**
  `PTYService` + `cleanForChat` → it would crash on the first live run.
- **Fix:** re-exported `cleanForChat` + `getAcpService` from the plugin index;
  rewired the smoke script `PTYService` → `AcpService.start` + register under
  `AcpService.serviceType` (so the TASKS actions resolve the *same*
  `ACP_SUBPROCESS_SERVICE` singleton the script reads output from); fixed an
  async/sync bug the rename surfaced (`await service.getSession(…)`); corrected the
  e2e path to `packages/core/test/live/…` and dropped the two unsupported
  `counter-app` tests + mode. **NEW non-live regression guard**
  `__tests__/unit/live-smoke-imports.test.ts` asserts every symbol the harness
  imports/uses still exists — catches this class of drift in the unit lane.
- **Evidence:** orchestrator unit suite **683 passed (58 files)** incl. the new
  guard; orchestrator `typecheck` exit 0.
- **Deferred (honest scope):** the actual `ORCHESTRATOR_LIVE=1` run + trajectory
  capture (needs real auth + minutes + cost) → **Wave 2**. This batch makes the
  harness compile, share the right service instance, and stay drift-proof.

## Wave 1 — evidence infrastructure (enables every capability batch)
### ⏳ 1.1 (F/G) Screenshot/video/timeline capture in scenario-runner + coding-flow recording harness + scrubbable viewer
### ⏳ 1.2 (F) Sub-agent orchestration support in harness + new finalChecks
### ⏳ 1.3 (J) Centralized model-chooser contract test (`buildEnv` + `buildOpencodeSpawnConfig` matrix)

## Wave 2 — headline live capability evidence
### ⏳ 2.1 (A/F) Live create-app loop scenario + build/launch/browser integration test
### ⏳ 2.2 (B/F/J) Spawn→route live scenario + per-agent builds + per-backend completion matrix
### ⏳ 2.3 (C) Wire Smithers multi-step graph into production + live durable-task e2e
### ⏳ 2.4 (D) z.ai usage tracking + mid-task switch test + multi-account live evidence

## Wave 3 — UI, surfacing, concurrency, lifecycle
### ⏳ 3.1 (E) PTY console tests, settings tests, rewritten live workbench e2e
### ⏳ 3.2 (K) Notification-on-completion + cadence tests + connector surfacing + `/tasks` shortcut
### ⏳ 3.3 (L) High-concurrency profile + 10-session stress + spawn-gate/file-lock tests
### ⏳ 3.4 (A/H/F) Rollback for direct edits + create→modify→reload→rollback lifecycle scenarios

## Wave 4 — platform breadth & cross-cutting evidence
### ⏳ 4.1 (I) iOS/Play remote-container + Android/AOSP device + Debian-live + Docker sandbox + remote-runner CI
### ⏳ 4.2 (G/I) Cross-platform device video/timeline capture wrappers
### ⏳ 4.3 (C/J/F) Non-sqlite Smithers backends + scheduled live-model CI + platform-tagged scenarios
### ⏳ 4.4 (LOW) cleanups — sweagent docs, weeklyPct strategy, cli-inference failover, progress docs, DOM tests
