I'll synthesize the 12 domain audits into a master document. Let me produce the comprehensive markdown directly.

# elizaOS Code-Writing & Agent-Orchestration Capability — Master Audit & Gap Backlog

**Scope:** Direct code-writing tools, sub-agent (ACP) orchestration, Smithers workflow engines, multi-account quota/switching, orchestrator/task UI, scenario-runner harness, E2E recording, dynamic reload/rollback, platform coverage, model backends, user/connector surfacing, and concurrency. Synthesized from 12 domain audits.

**Verdict in one line:** The *code* is broad and largely mature (especially `plugins/plugin-agent-orchestrator`), but the *proof* is thin — almost no committed real-LLM trajectories, screenshots, video, or timelines tie the headline capabilities (live coding loop, sub-agent spawn→route, multi-account switch, 10-project concurrency) to evidence, and several flagship live harnesses are broken or stale.

---

## 1. Executive Summary

### Maturity per domain

| Domain | Maturity | One-line |
|---|---|---|
| A. Built-in code-writing tools (FILE/SHELL/WORKTREE + build-validation) | **Partial** | Tools + verification service are solid and unit-tested; the live create→code→verify→screenshot loop is never run with a real model. |
| B. Sub-agent ACP orchestration | **Partial** | Deep, green unit coverage; the flagship live task-agent E2E is broken on three axes and zero trajectory/screenshot/video evidence exists. |
| C. Smithers workflow engines (in-process + durable coding-task) | **Partial** | Both engines work against real subprocesses in tests, but the rich orchestrator graph is built-and-unit-tested yet NOT wired into production (single-turn only). |
| D. Multi-account quota tracking + switching | **Partial** | Real pool + live usage probes for Claude/Codex; z.ai usage% is never fetched and mid-task live switching is unproven with evidence. |
| E. Orchestrator/task UI surfaces | **Partial** | Mature chat/coding UX, but the biggest behavioral test suite is broken (won't load), the live e2e is stale, and PTY consoles are entirely untested. |
| F. Scenario-runner harness | **Partial** | Mature harness with trajectory + native-export; exactly ONE coding scenario, sub-agent orchestration explicitly excluded, no real screenshot/video capture. |
| G. E2E recording (screenshots/video/timelines, cross-platform) | **Partial** | Strong Playwright UI-audit stack, but no harness records a REAL coding flow as video+timeline; coding suites run stubbed; no Android/iOS/Debian device capture. |
| H. Dynamic reload / build-validation / rollback | **Partial** | Solid build-validation + in-process reload; NO rollback/undo anywhere; the core tiered reload pipeline has zero tests. |
| I. Platform coverage (cloud/desktop/AOSP/Debian/Play/iOS + remote containers) | **Partial** | Clean per-platform gate + real remote-runner substrate; zero end-to-end evidence of coding on iOS/Play/AOSP/Debian. |
| J. Model backends for coding/orchestration | **Partial** | gpt-oss-120b/Cerebras/claude/codex/z.ai wiring is mature and unit-tested; no live test proves a sub-agent COMPLETES a coding task per backend with artifacts. |
| K. Surfacing coding tasks to users/connectors | **Partial** | Real cadence engine + notification fan-out; the posting/heartbeat/notify paths are largely untested with zero surfacing evidence. |
| L. Concurrency / simultaneous projects (stress to 10) | **Partial** | Race-safe session cap is well-tested, but defaults block 10-way concurrency AND there is NO default per-session workspace isolation (collision risk). |

### The 5–8 most important findings

1. **No default per-session workspace isolation (CRITICAL, Domain L).** `resolveDefaultSpawnWorkdir` collapses every ad-hoc concurrent task with no route/worktree into a *single shared directory* (`process.cwd()` / `ELIZA_ACP_WORKSPACE_ROOT`). Multiple simultaneous projects corrupt each other's files. This is a correctness bug, not just a test gap.

2. **The headline live coding loops are broken or stubbed (CRITICAL, Domains A/B/G).** The APP-create live scenario deliberately omits `START_CODING_TASK` and accepts "could not dispatch" as pass; the task-agent E2E points at a nonexistent path, imports a removed `PTYService`, and calls a mode the smoke rejects; the only coding-surface E2E spec (`orchestrator-gui-workbench.spec.ts`) mocks every API. No real model ever drives a code-write end-to-end.

3. **No rollback/undo for code or runtime state (CRITICAL, Domain H).** A broken plugin/view live-load is surfaced honestly but never reverted — `applyPluginRuntimeMutation` can unload plugins then fail mid-reload, and the cold runtime strategy explicitly cannot restore the previous runtime ("requires a two-phase restart contract" that doesn't exist). There is no git checkpoint/source rollback per coding task.

4. **Sub-agent orchestration has zero scenario-runner coverage and zero captured trajectory/screenshot/video (CRITICAL/HIGH, Domains B/F/K).** The product's headline capability is `LIVE_ONLY_REMAINDER` — explicitly excluded from the harness and only unit-tested with mocks. PR_EVIDENCE mandates real-LLM trajectories; this domain has none committed.

5. **The Smithers durable graph is built + fully unit-tested but NOT wired into production (HIGH, Domain C).** The only production caller hardcodes `maxTurns:1` with no provision/submit/approval/parallel, so "Smithers drives multi-step coding tasks" is true of the engine and false of the shipped path.

6. **Two test suites are silently red/dead (HIGH, Domain E).** `plugin-task-coordinator`'s biggest behavioral suite (TaskInspector) fails to load (`@elizaos/shared/voice-eot` alias missing) so `bun run test` exits non-zero and it never runs; the live workbench e2e asserts test IDs that no longer exist, providing ~zero coverage.

7. **z.ai/Kimi/GLM usage% is never tracked (HIGH, Domain D).** Accounts are tracked and key-validated, but no `pollZaiUsage` exists, so quota-aware/least-used treat every z.ai account as 0% and the dashboard shows no usage bar — silent, not surfaced.

8. **Defaults block the 10-project target and z.ai/Play/iOS coding is unproven (HIGH, Domains L/I).** `ELIZA_ACP_MAX_SESSIONS` defaults to 8 (<10) and `ELIZA_MAX_CONCURRENT_SPAWNS` to 2 (docs say "unset"); iOS→remote-container delegation, Android/AOSP-with-shell, and Debian-live coding have every layer unit-tested but no end-to-end run.

---

## 2. What Already Exists & Is Solid (do NOT rebuild)

### A. Built-in code-writing tools
- **`codingToolsPlugin`** (FILE/SHELL/WORKTREE + SandboxService/FileStateService/SessionCwdService/RipgrepService) — `plugins/plugin-coding-tools/src/index.ts`
- **SHELL exec chokepoint** with mode dispatch + timeout/process-group kill — `plugins/plugin-coding-tools/src/lib/run-shell.ts`; action at `src/actions/bash.ts`
- **FILE edit/write** with stale-read gate + secret guard — `src/actions/edit.ts`, `src/actions/write.ts`
- **Path-policy sandbox** (per-OS blocklist, realpath, allow-roots) — `src/services/sandbox-service.ts`
- **AppVerificationService** (typecheck/lint/test/build/launch/browser-screenshot/structured-proof, per-check logs) — `plugins/plugin-app-control/src/services/app-verification.ts`; diagnostics + screenshot capture in `verification-helpers.ts`
- **APP create flow** (template copy + dispatch coding sub-agent with verifier contract) — `plugins/plugin-app-control/src/actions/app-create.ts`
- **Mobile-safe FILE bridge** — `plugins/plugin-device-filesystem/src/services/device-filesystem-bridge.ts`
- **Lower-level sandboxed shell** (PTY, named sessions, approvals) — `plugins/plugin-shell/services/shellService.ts`

### B. Sub-agent ACP orchestration
- **AcpService** (subprocess lifecycle, transport selection, spawn/cancel/stop, orphan GC) — `plugins/plugin-agent-orchestrator/src/services/acp-service.ts`
- **NativeAcpClient** (embedded ACP JSON-RPC over stdio, permission/fs/terminal handlers) — `src/services/acp-native-transport.ts`
- **SubAgentRouter** (terminal-event → synthetic memory, routing keys, round-trip cap) — `src/services/sub-agent-router.ts`
- **OrchestratorTaskService** (durable task store + ACP bridge) — `src/services/orchestrator-task-service.ts`
- **task-agent-routing / interruption-decider / sub-agent-inbox / coding-account-selection / spawn-trajectory** — same `src/services/` dir
- **Separate sandboxed claude-CLI driver** (not ACP) — `packages/plugin-remote-manifest/src/sub-agent-claude-code/sub-agent-service.ts`
- **SWE-bench trajectory benchmark harness + viewer** — `packages/benchmarks/orchestrator`

### C. Smithers engines
- **In-process workflow engine** (DAG→parallel/sequence, stdin/stdout node protocol, n8n retry, metrics) — `plugins/plugin-workflow/src/services/smithers-runtime.ts`; production caller `embedded-workflow-service.ts`
- **RAG generation pipeline** — `plugins/plugin-workflow/src/utils/generation.ts`, `workflow-service.ts`
- **Durable Smithers coding-task runner** (provision→turn-loop→approval→submit, parallel fan-out, crash-resume) — `plugins/plugin-agent-orchestrator/src/services/smithers-task-runner.ts`; executor `smithers-task-executor.ts`; types `smithers-task-types.ts`

### D. Multi-account
- **AccountPool** (4 strategies, session affinity, burst-spread, health filtering, keep-alive sweep) — `packages/app-core/src/services/account-pool.ts`
- **Live usage probes** (`pollAnthropicUsage`/`pollCodexUsage`, JSONL day counters) — `packages/app-core/src/services/account-usage.ts`
- **Coding-account bridge** (globalThis symbol, env-patch injection, CODEX_HOME materialization) — `packages/app-core/src/services/coding-account-bridge.ts` (reader: `plugins/plugin-agent-orchestrator/src/services/coding-account-selection.ts`)
- **Accounts REST API** — `packages/agent/src/api/accounts-routes.ts`; **accounts widget** — `packages/ui/src/components/chat/widgets/agent-orchestrator-accounts-view.tsx`

### E. Orchestrator/task UI
- **OrchestratorWorkbench** (3925-line chat/coding room, SSE streaming, inspector, recovery actions) — `plugins/plugin-task-coordinator/src/OrchestratorWorkbench.tsx`
- **orchestrator-stream renderer + buildConversation transform** — `src/orchestrator-stream.tsx`, `src/orchestrator-stream.helpers.ts`
- **CodingAgentTasksPanel**, **PtyConsoleBase/Drawer/SidePanel + PtyTerminalPane**, **OrchestratorSpatialView** (TUI/GUI/XR), **15 capability descriptors** — same `src/` dir

### F. Scenario-runner
- **Executor / interceptor / final-checks (~30) / judge / reporter+run-viewer / native-export / CLI / runtime-factory** — `packages/scenario-runner/src/{executor,interceptor,final-checks/index,judge,reporter,native-export,cli,runtime-factory}.ts`
- **The one coding scenario** (FILE/SHELL/WORKTREE deterministic) — `test/scenarios/deterministic-coding-tools-actions.scenario.ts`
- **Action-coverage ratchet gate** — `src/__tests__/deterministic-action-coverage.test.ts`

### G. E2E recording
- **Root recording orchestrator + suite registry + contact-sheets + viewer** — `scripts/e2e-recordings/{run-all,suites,generate-contact-sheets,generate-viewer}.mjs`
- **Cloud aesthetic audit** — `packages/cloud-frontend/tests/e2e/aesthetic-audit.spec.ts`
- **App UI-smoke matrix** (web/mobile/voice/desktop/audit) — `packages/app/playwright.ui-smoke.config.ts`; Android CDP `playwright.android.config.ts`; electrobun packaged `playwright.electrobun.packaged.config.ts`
- **Live-test artifact-coverage gate** — `packages/scripts/check-live-test-artifact-coverage.mjs`

### H. Reload / build-validation
- **loadPluginFromDirectory** (cache-busted ESM reimport + register) — `packages/agent/src/runtime/load-plugin-from-directory.ts`
- **VerificationRoomBridgeService** (verify→live-load→chat verdict) — `plugins/plugin-app-control/src/services/verification-room-bridge.ts`
- **Plugin import staging** (ESM module-graph cache-bust) — `packages/agent/src/runtime/plugin-resolver.ts`
- **Plugin lifecycle teardown** — `packages/agent/src/runtime/plugin-lifecycle.ts`
- **View bundle disk serving + cache-bust** — `packages/agent/src/api/views-routes.ts`
- **Runtime-ops manager (hot/warm/cold, phase timeline)** — `packages/agent/src/runtime/operations/manager.ts`

### I. Platform coverage
- **Sandbox/build-variant policy** — `packages/core/src/{sandbox-policy,build-variant}.ts`
- **Orchestrator platform gate** — `plugins/plugin-agent-orchestrator/src/services/terminal-capabilities.ts`
- **E2BRemoteCapabilityRouterService** (e2b/eliza-cloud/home) — `packages/agent/src/services/e2b-capability-router.ts`; **shell-execution-router** `shell-execution-router.ts`
- **Cloud coding-remote-runner** — `packages/cloud/services/coding-remote-runner/src/index.ts`; **control-plane provisioning** `packages/cloud/api/v1/coding-containers/route.ts`, `packages/cloud/shared/src/lib/services/coding-containers.ts`

### J. Model backends
- **gpt-oss-120b default + Cerebras detection** — `packages/core/src/contracts/service-routing.ts`, `plugins/plugin-elizacloud/src/models/text.ts`, `src/utils/config.ts`
- **Sub-agent model+auth selection (buildEnv) + opencode config** — `plugins/plugin-agent-orchestrator/src/services/{acp-service,opencode-config}.ts`
- **plugin-openai Cerebras mode / plugin-codex-cli / plugin-cli-inference / plugin-anthropic-proxy** — respective plugin dirs
- **Cerebras-as-judge** — `packages/scenario-runner/src/cerebras-judge.ts`; **goal verifier** `plugins/plugin-agent-orchestrator/src/services/goal-llm-verifier.ts`

### K. Surfacing
- **Progress hook + cadence engine + heartbeat** — `plugins/plugin-agent-orchestrator/src/index.ts` (`registerProgressHook`, `resolveSubAgentProgressPolicy`, `startHeartbeat`)
- **task_complete → AgentNotification** — `src/services/sub-agent-router.ts`
- **Notification contract + store + native bridge** — `packages/core/src/types/notification.ts`, `packages/ui/src/state/notifications/notification-store.ts`, `packages/ui/src/bridge/native-notifications.ts`
- **Connector capabilities** — `plugins/plugin-discord/service.ts` (full set), `plugins/plugin-telegram/src/service.ts` (no edit/react)

### L. Concurrency
- **Race-safe session cap + mutex** — `plugins/plugin-agent-orchestrator/src/services/acp-service.ts` (`reserveSessionSlot`)
- **Tiered SessionStore + WriteQueue + file-lock** — `src/services/session-store.ts`
- **CodingWorkspaceService + workspace-lifecycle GC** — `src/services/{workspace-service,workspace-lifecycle}.ts`

---

## 3. Master GAP CHECKLIST

> Order: CRITICAL → HIGH → MEDIUM → LOW; within severity, grouped by domain. Deduped across audits.

### CRITICAL

- [ ] **[CRITICAL] (L) No default per-session workspace isolation — concurrent tasks collide in one directory** — Change `resolveDefaultSpawnWorkdir` to default to a per-session subdir (`<root>/<sessionId>`) or auto-enable a worktree per concurrent session; add a test asserting two route-less concurrent spawns get distinct workdirs + no cross-session writes. Files: `plugins/plugin-agent-orchestrator/src/services/task-agent-routing.ts`, `src/services/workspace-service.ts`, `__tests__/unit/resolve-spawn-workdir.test.ts`.
- [ ] **[CRITICAL] (A/F) No live-LLM end-to-end create-app loop (scaffold→coding agent→verify→screenshot)** — Add a live-only scenario that registers `START_CODING_TASK` + `AppVerificationService` and runs APP create against a live model, asserting template copy, child edits, verdict=pass, `screenshot.png` + per-check logs; emit JSON report + jsonl + run viewer to `.github/issue-evidence/`. Files: `plugins/plugin-app-control/test/scenarios/` (new), `plugins/plugin-app-control/src/actions/app-create.ts`.
- [ ] **[CRITICAL] (B) Live task-agent E2E harness is broken on three independent axes** — Repoint path to `packages/core/test/live/task-agent-live-smoke.ts`, replace removed `PTYService` import with `AcpService` + `tasksAction`, add (or drop) the `counter-app` mode, and add a module-import smoke to catch shape drift. Files: `plugins/plugin-agent-orchestrator/src/__tests__/task-agent-live.e2e.test.ts`, `packages/core/test/live/task-agent-live-smoke.ts`.
- [ ] **[CRITICAL] (F) No sub-agent / coding-agent orchestration scenarios in the harness** — Add a turn-kind/seed harness (deterministic ACP/PTY replay fixture + live variant) that spawns a coding sub-agent, asserts sub-agent room + diff produced; add finalChecks `subAgentSpawned`/`taskRoomCreated`/`diffProduced`/`buildPassed`. Files: `packages/scenario-runner/src/executor.ts`, `src/final-checks/index.ts`, new scenario under `test/scenarios/`.
- [ ] **[CRITICAL] (F) No build/typecheck/test validation of generated code in the harness** — Add a `buildValidation` final-check (run build/typecheck/test in seeded workspace, assert exit 0) + a scaffold→build scenario; capture build logs in the run-viewer. Files: `packages/scenario-runner/src/final-checks/index.ts`, new scenario.
- [ ] **[CRITICAL] (H) No rollback/recovery on a broken plugin reload (in-memory graph left half-torn-down)** — Implement two-phase reload: snapshot plugin ownership graph + adapter before unload/register, restore on register-throw OR failed post-reload health check; build the "two-phase restart contract" the cold strategy references. Files: `packages/agent/src/api/plugin-runtime-apply.ts`, `packages/agent/src/runtime/operations/manager.ts`, `cold-strategy.ts`, `load-plugin-from-directory.ts` + new tests.
- [ ] **[CRITICAL] (G) No end-to-end recording of a REAL coding flow (video + timeline)** — Build a coding-flow recording harness: Playwright spec (or orchestrator-UI wrapper) against a real model + real sub-agent spawn, recording video+trace+screenshots per milestone, emitting `timeline.json` joined to scenario-runner jsonl turn ids; add a "coding timeline" viewer aligning video↔trajectory↔screenshot. Files: `scripts/e2e-recordings/` (new suite + generator), `packages/scenario-runner/`.
- [ ] **[CRITICAL] (I) No end-to-end evidence a coding agent runs on iOS/Play via remote container** — Author a `coding-via-remote-container` scenario (`ELIZA_PLATFORM=ios`, `eliza-cloud` runner against docker-compose runner + mock/real `/coding-containers`) that creates+modifies an app, plus a Capacitor/Playwright iOS-or-Android device test capturing video + before/after screenshots. Files: `packages/agent/src/services/e2b-capability-router.ts`, `packages/cloud/services/coding-remote-runner/`, new scenario + device spec.

### HIGH

- [ ] **[HIGH] (A) build/launch/browser-screenshot verification checks lack integration coverage** — Add a chromium-gated (`itIf`) integration test scaffolding a tiny app, running `profile=full` with a launched dev server + `ELIZA_CHROME_PATH`, asserting non-empty `screenshot.png` and pass/fail on injected console errors. Files: `plugins/plugin-app-control/src/services/app-verification.ts`, `src/services/__tests__/app-verification.integration.test.ts`.
- [ ] **[HIGH] (A/B/C/D/E/G/H/I/J/K/L) No committed evidence artifacts (trajectory/screenshot/video/timeline/log) for the coding+orchestration domains** — Stand up a recorded walkthrough harness + committed-evidence convention under `.github/issue-evidence/<issue#>-<slug>/` (compressed video + `timeline.json` + key screenshots + scenario jsonl + structured `[ClassName]` logs); extend `check-live-test-artifact-coverage.mjs` to fail coding/orchestrator PRs lacking the bundle. Files: `.github/issue-evidence/`, `packages/scripts/check-live-test-artifact-coverage.mjs`, `scripts/e2e-recordings/`.
- [ ] **[HIGH] (A/L) No concurrency / many-projects (≥10) coverage** — Add a stress/scenario test firing ≥10 concurrent APP-create / SHELL+FILE sessions in distinct rooms; assert per-conversation cwd/sandbox isolation, no verification runId collision, no cross-room leakage; capture per-run timeline. Files: `plugins/plugin-app-control/src/services/app-worker-host-service.ts`, `plugins/plugin-coding-tools/`, `plugins/plugin-agent-orchestrator/scripts/` (new concurrent harness).
- [ ] **[HIGH] (B/F/J) No real-LLM trajectory evidence for spawn→route, despite PR_EVIDENCE mandate** — Author `packages/scenario-runner/test/scenarios/orchestrator-spawn-route.scenario.ts` spawning a sub-agent via TASKS_CREATE against a live model; assert synthetic `task_complete` routes back AND `handle.linkChild` produced a linked child step; emit report + jsonl + viewer to `.github/issue-evidence/`. Files: `plugins/plugin-agent-orchestrator/src/services/spawn-trajectory.ts`, new scenario.
- [ ] **[HIGH] (B) Live coverage limited to codex/opencode build + claude/codex sequential; elizaos, pi-agent, native claude builds unproven** — Add gated live build E2Es (`ORCHESTRATOR_LIVE` lane, per-agent skip-on-missing-auth) for elizaos, pi-agent, native claude that each build a real artifact via native transport and assert the artifact + task_complete. Files: mirror `plugins/plugin-agent-orchestrator/scripts/live-codex-spawn-e2e.ts`.
- [ ] **[HIGH] (B/G) Served-app verification uses net reachability + sentinel strings, not screenshot/video** — After the sub-agent serves an app, drive a headless browser (Playwright already in `packages/app-core/core`) to load the URL, capture before/after full-page screenshots + short video, assert rendered DOM (not just port-open). Files: `packages/core/test/live/task-agent-live-smoke.ts`, recording harness.
- [ ] **[HIGH] (C) Orchestrator Smithers graph is built+unit-tested but NOT wired into production** — Wire a real multi-step config through `runDurableTask` (pass `maxTurns` from the round-trip cap, `provision:true` for workspace tasks, `submit`/`approvalBeforeSubmit` for PR submission, `parallelAgents` for swarm) + a wiring test asserting the spec passed to `runTaskWithSmithers`; OR explicitly document single-turn-by-design. Files: `plugins/plugin-agent-orchestrator/src/services/smithers-task-integration.ts`, `src/actions/tasks.ts`.
- [ ] **[HIGH] (C/F) No real-LLM trajectory / run-viewer evidence for any Smithers path** — Add scenarios: (1) NL→WORKFLOW create→activate→execute asserting Smithers metrics + a real node firing; (2) TASKS_CREATE durable coding via `runDurableTask` against a real ACP agent. Run on gpt-oss-120b + claude; land artifacts under `.github/issue-evidence/`. Files: `packages/scenario-runner/test/scenarios/` (new).
- [ ] **[HIGH] (D) z.ai (and Kimi/GLM) usage% is never fetched — only key validation** — Add `pollZaiUsage`/`pollMoonshotUsage` to `account-usage.ts` (endpoint or rate-limit headers), wire into `AccountPool.refreshUsage` for zai-api/zai-coding/moonshot-api, add a unit test asserting `sessionPct` populated; if no endpoint exists, document + show "usage unavailable" in the widget instead of a silent empty bar. Files: `packages/app-core/src/services/account-usage.ts`, `account-pool.ts`, `packages/agent/src/api/accounts-routes.ts`, `packages/ui/.../agent-orchestrator-accounts-view.tsx`.
- [ ] **[HIGH] (D) Mid-task live account SWITCHING (rate-limit → re-select) untested with evidence** — Add an integration test injecting a 429 for a running session asserting (a) `markRateLimited` called, (b) next same-type spawn picks a different account, (c) original re-admitted after reset; plus a gated live scenario capturing the switch as a trajectory + timeline. Files: `plugins/plugin-agent-orchestrator/src/services/orchestrator-task-service.ts`, `packages/app-core/src/services/account-pool.ts`.
- [ ] **[HIGH] (E) TaskInspector behavioral suite is broken and silently not running** — Add `@elizaos/shared` (+ subpath) src alias to `plugins/plugin-task-coordinator/vitest.config.ts` (mirroring `@elizaos/ui`) or build shared first; confirm the inspector suite runs green and wire it into CI so the failure can't recur silently. Files: `plugins/plugin-task-coordinator/vitest.config.ts`, `__tests__/unit/orchestrator-inspector-terminal-task.test.tsx`.
- [ ] **[HIGH] (E) Live workbench e2e is stale (~zero real coverage)** — Rewrite against the real DOM contract (`orchestrator-conversation-block`, `orchestrator-user/agent-message`, `orchestrator-tool-call`, inspect→OperatorDetailDrawer tabs, stop/Esc, pause/resume/validate, load-older); run against `bun run cloud:mock` so it executes in CI. Files: `plugins/plugin-task-coordinator/test/orchestrator-workbench.live.e2e.test.ts`.
- [ ] **[HIGH] (E) PTY console UX (live terminal coding experience) is entirely untested** — Add DOM tests with a mocked client (buffered-output hydrate, `pty-output` WS append, input/Enter/Ctrl-C/stop, 200k buffer trim, session-switch resubscribe, unsubscribe-on-unmount, xterm lazy-mount/dispose) + an e2e opening a real PTY session asserting streamed output + interrupt. Files: `plugins/plugin-task-coordinator/src/{PtyConsoleBase,PtyTerminalPane,PtyConsoleDrawer}.tsx`.
- [ ] **[HIGH] (E) No committed visual/trajectory/video/log evidence for the coding chat UX** — Scenario-runner coding-task run against a live model + full-page before/after screenshots of the real workbench/inspector/PTY console + video walkthrough + backend/frontend logs; land under `.github/issue-evidence/`. Files: `plugins/plugin-task-coordinator/src/__e2e__/run-dashboard-shot.mjs` (extend to real components), recording harness.
- [ ] **[HIGH] (F) No real screenshot/video/UI capture for coding/orchestration UI surfaces** — Bridge scenario-runner to the Playwright/app ui-smoke lane (or add a computer-use/browser capture step) so a scenario can write real PNG/webm into `<runDir>/artifacts` and render them inline in `writeScenarioRunViewer`. Files: `packages/scenario-runner/src/{reporter,executor,interceptor}.ts`.
- [ ] **[HIGH] (F/L) No multi-project concurrency / scale scenarios** — Add an orchestration scenario (or multi-process driver à la `scripts/run-scenarios-isolated.mjs`) launching N concurrent coding tasks, asserting task-room/worktree isolation + per-project timeline in the viewer (the CLI's single-shared-runtime/PGLite limit must be worked around). Files: `packages/scenario-runner/src/cli.ts`, new driver.
- [ ] **[HIGH] (F) No create→modify→reload→rollback lifecycle scenarios** — Author lifecycle scenarios: APP create → VIEWS edit → reload assert → inject build error → assert surfaced → rollback → assert prior state; add finalChecks `reloadOccurred`/`rollbackRestored`. Files: `packages/scenario-runner/src/final-checks/index.ts`, new scenarios. (Depends on Domain H rollback implementation.)
- [ ] **[HIGH] (G) Coding/orchestration suites not part of the recording orchestrator in REAL mode** — Add a real-mode suite entry (`orchestrator-live`) booting the live app stack + a real provider key + real coding-tools/agent-orchestrator services, recording video, gated on a model key; keep the stubbed run separate in the viewer. Files: `scripts/e2e-recordings/suites.mjs`, `packages/app/playwright.ui-smoke.config.ts`.
- [ ] **[HIGH] (G/I) No video/timeline capture on Android/AOSP, Debian, Play, iOS remote-container coding flows** — Add device-level capture wrappers: `adb screenrecord` (Android/AOSP), `xcrun simctl io recordVideo` (iOS), `Xvfb+ffmpeg` (Debian/AOSP container); register as suites so `test:e2e:record` covers each platform. Files: `packages/app/scripts/android-e2e.mjs`, `scripts/e2e-recordings/suites.mjs`, `packages/os/{android,linux}/`.
- [ ] **[HIGH] (H) plugin-runtime-apply.ts (core tiered reload pipeline) has zero tests** — Add `plugin-runtime-apply.test.ts` covering config_apply, plugin_reload (unload+register), runtime_reload escalation for adapter plugins, and a `registerPlugin` throw → restart fallback (and, once built, rollback). Files: `packages/agent/src/api/plugin-runtime-apply.ts` (+ new test).
- [ ] **[HIGH] (H) No end-to-end edit→rebuild→live-reload→assert-new-behavior test** — Scaffold a built plugin returning v1, load, rewrite `dist/index.js` to v2, reload, assert runtime serves v2; sibling test where re-import throws and asserts prior v1 still registered. Files: `packages/agent/src/runtime/load-plugin-from-directory.test.ts`.
- [ ] **[HIGH] (H) Broken-reload recovery only asserted via mocked chat text** — Add an integration test POSTing a genuinely broken plugin dir to the real `/api/plugins/load-from-directory`, asserting HTTP 422 + no partial registration (actions/providers/views unchanged). Files: `plugins/plugin-app-control/src/services/__tests__/verification-room-bridge.test.ts`, `packages/agent/src/api/server.ts`.
- [ ] **[HIGH] (I) No coding/orchestrator e2e on Android or AOSP device** — Add a `*.android.spec.ts` that, on an AOSP/Cuttlefish image with a staged shell, invokes TASKS spawn (or deterministic local runner) to create a file and asserts the workspace diff (trace+screenshot); add a Cuttlefish CI lane running it as the boot-validate final step. Files: `packages/app/playwright.android.config.ts`, `packages/os/android/Makefile`.
- [ ] **[HIGH] (I) No Debian-live (elizaOS Live) coding-agent boot smoke** — Extend `just boot` (or new `just coding-smoke`) to boot the ISO in QEMU, bring up the bundled agent, run a minimal local coding task, emit log + screenshot; wire into `verify-release.sh`. Files: `packages/os/linux/Justfile`.
- [ ] **[HIGH] (I) Live remote-container smoke is credential-gated, not in CI, emits no rich evidence** — Add a CI lane running `test:sandbox-live --strict` against a docker-compose'd coding-remote-runner (`home` provider, no external creds), producing a JSON report + captured runner logs to `.github/issue-evidence/`; make the home-provider variant non-skippable. Files: `packages/agent/scripts/live-sandbox-smoke.ts`.
- [ ] **[HIGH] (J) No end-to-end live test that a sub-agent COMPLETES a coding task per backend (gpt-oss-120b/claude/codex/z.ai) with captured artifacts** — Gated live scenario matrix [opencode/gpt-oss-120b-Cerebras, claude/opus, codex/gpt-5.5, opencode/zai-glm-4.7] building a tiny app; capture report + jsonl + git changeset and assert `session.metadata.account/model` matches the requested backend. Files: `packages/scenario-runner/test/scenarios/` (new).
- [ ] **[HIGH] (J) gpt-oss-120b built-in coding path has no committed trajectory** — Run `packages/scenario-runner/bin/eliza-scenarios` against live elizacloud gpt-oss-120b for a coding-delegation scenario (TASKS_SPAWN_AGENT); commit report + viewer + jsonl; wire as nightly (extend `cerebras-nightly.yml`). Files: `.github/workflows/cerebras-nightly.yml`, new scenario.
- [ ] **[HIGH] (K) No test asserts coding-task completion emits an AgentNotification** — In `sub-agent-router.test.ts`, register a mock NOTIFICATION service and assert `notify` is called once on `task_complete` with category `agent`, source `orchestrator`, deepLink `/orchestrator`, groupKey `orchestrator:<sessionId>`, and NOT on error/blocked/streaming. Files: `plugins/plugin-agent-orchestrator/__tests__/unit/sub-agent-router.test.ts`.
- [ ] **[HIGH] (K) emitProgress routing ladder + cadence is untested** — Add a unit test driving `registerProgressHook` against a mock runtime with controllable connector caps, asserting: compact debounced single post after delayMs; ack mode one ACK per room within dedup window + no edit; silent posts nothing; threaded creates one thread per label; edit-capable edits in place; heartbeat skips empty + dedupes. Files: `plugins/plugin-agent-orchestrator/src/index.ts` (+ new test).
- [ ] **[HIGH] (K) No end-to-end surfacing test through a real connector** — Scenario/live-smoke spawning a short task verifying, on Discord (full caps) vs Telegram (no edit/react), exactly one ACK + one completion summary, threads only where supported, no dup/empty messages; capture trajectory + connector message log. Files: `plugins/plugin-discord/service.ts`, `plugins/plugin-telegram/src/service.ts`, new scenario.
- [ ] **[HIGH] (K) Zero trajectory/log/video/timeline evidence for the surfacing domain** — Recorded walkthrough harness running a real coding task capturing the `[orchestrator]` progress/heartbeat/notify logs, a cadence timeline (spawn ACK→ticks→completion), and screenshots/video of the message in Discord/Telegram + in-app/OS notification; land under `.github/issue-evidence/`. Files: recording harness, `plugins/plugin-agent-orchestrator/src/index.ts`.
- [ ] **[HIGH] (L) System cannot handle 10 simultaneous projects with default config** — Add a documented high-concurrency profile (`ELIZA_ACP_MAX_SESSIONS>=10`, tuned `ELIZA_MAX_CONCURRENT_SPAWNS`) + a stress test spawning 10 sessions asserting all reach ready/complete; reconcile README/CLAUDE.md claim that `ELIZA_MAX_CONCURRENT_SPAWNS` is "unset" with the actual default of 2. Files: `plugins/plugin-agent-orchestrator/src/services/acp-service.ts`, `src/actions/common.ts`, `CLAUDE.md`/`README.md`.
- [ ] **[HIGH] (L) No end-to-end / stress test for N simultaneous coding tasks** — Author a scenario-runner scenario (and a concurrent composed harness like `compose-multi-account-e2e` but parallel) launching 10 tasks via TASKS_CREATE, capturing a trajectory per session, asserting isolated-workspace completion + a timeline; lower `ACPX_SUB_AGENT_ROUND_TRIP_CAP` for the test env. Files: `plugins/plugin-agent-orchestrator/scripts/`, `packages/scenario-runner/`.

### MEDIUM

- [ ] **[MEDIUM] (A/H) No rollback/undo / git-checkpoint for direct code edits** — Add a backup/rollback capability (snapshot edited files OR worktree/branch per task with `git reset` on failure) + a scenario asserting a failed verification leaves the workdir restorable; at minimum test WORKTREE exit cleanup as the rollback boundary. Files: `plugins/plugin-coding-tools/src/services/`, `plugins/plugin-app-control/src/actions/app-create.ts`, `views-create.ts`.
- [ ] **[MEDIUM] (A) SHELL action has no real build-failure → diagnostic surfacing test** — Deterministic scenario where SHELL runs a failing `bun run build`/`tsc` in a seeded project; assert the ActionResult carries `exit_code` + stderr tail, then a FILE edit + re-run SHELL produces exit 0; capture the two-step trajectory. Files: `plugins/plugin-coding-tools/src/actions/bash.ts`, new scenario.
- [ ] **[MEDIUM] (A/I) Mobile/device backends (Capacitor iOS/Android) untested for file writes** — Add a device-backed integration harness (or contract test with mocked Capacitor Filesystem) exercising read/write/list through the Capacitor backend; document the on-device evidence step (screenshot + log) for AOSP/iOS. Files: `plugins/plugin-device-filesystem/src/services/device-filesystem-bridge.ts`.
- [ ] **[MEDIUM] (B/C/L) No concurrency / error-rollback / cancel-mid-build scenario with a real agent** — Integration tests: N concurrent native spawns (cap + distinct workdirs), failing-command spawn → errored status + clean teardown, cancel mid-turn → cooperative cancel + inbox drain; raise `ELIZA_ACP_MAX_SESSIONS` to 10+ in the concurrency test. Files: `plugins/plugin-agent-orchestrator/src/services/acp-service.ts`, `sub-agent-inbox.ts`.
- [ ] **[MEDIUM] (B/D/J) Multi-account model switching (z.ai/GLM/Kimi, gpt-oss-120b) only documented, not live-validated** — Gated live tests linking a pooled ln/z.ai/GLM account, spawning opencode (and elizaos) on gpt-oss-120b, asserting a real completion + correct injected key; capture spawn env + completion. Files: `plugins/plugin-agent-orchestrator/scripts/`, `coding-account-selection.ts`.
- [ ] **[MEDIUM] (B/D) Standalone live scripts produce no checked-in evidence and are outside CI** — Add a `--report` flag to each live script writing a JSON run report + produced artifact + session-event timeline under `.github/issue-evidence/<issue>-<slug>/`; document exact command + expected artifact in the package README; add the hermetic `compose-multi-account-e2e.ts` to the `test:e2e` lane. Files: `plugins/plugin-agent-orchestrator/scripts/{live-codex-spawn-e2e,live-opencode-build-e2e,compose-multi-account-e2e}.ts`.
- [ ] **[MEDIUM] (C) Non-sqlite Smithers backends (postgres/pglite) never run live** — Add a gated integration test running `runTaskWithSmithers`/`runWorkflowWithSmithers` with `SMITHERS_DB_PROVIDER=pglite` against a real pglite-capable build verifying durable resume, OR assert+document that the pinned `smithers-orchestrator@0.22.0` lacks postgres/pglite so the branch is intentional dead code. Files: `plugins/plugin-{workflow,agent-orchestrator}/src/services/smithers-*.ts`.
- [ ] **[MEDIUM] (C) db-backend tests assert a re-implemented copy of the inline subprocess script, not the executed string** — Refactor the inline backend-selection into an exported pure function injected into the script (or export+snapshot the script string) so the test exercises the executed code; add a live pglite/postgres subprocess run. Files: `plugins/plugin-{workflow,agent-orchestrator}/__tests__/unit/smithers-db-backend.test.ts`.
- [ ] **[MEDIUM] (C) No end-to-end live test of runTaskWithSmithers against a real coding agent** — Gated live e2e (`RUN_LIVE_ACPX=1`) calling `runDurableTask`/`runTaskWithSmithers` with a real `AcpService`, agent makes a 2-turn file edit, kill subprocess mid-run, assert resume continues same session/workspace; capture stdout protocol + final diff. Files: `plugins/plugin-agent-orchestrator/src/services/smithers-task-runner.ts`.
- [ ] **[MEDIUM] (C) RAG generation correctness unverified against real models; no concurrency stress** — Live generation eval (use existing WORKFLOW eval_samples + GEPA optimizer case) wired to gpt-oss-120b/claude asserting deploy-ready output; concurrency test executing 10 workflows simultaneously through `EmbeddedWorkflowService` asserting isolation + no subprocess leak. Files: `plugins/plugin-workflow/src/utils/generation.ts`, `services/embedded-workflow-service.ts`.
- [ ] **[MEDIUM] (D) Offline composed E2E and live scripts not in any automated CI lane** — Add `test:e2e:multi-account` (`compose-multi-account-e2e.ts`, hermetic) to the `test:e2e` lane in `run-all-tests.mjs`; document a periodic/manual schedule for the real-quota live scripts. Files: `packages/scripts/run-all-tests.mjs`, `plugins/plugin-agent-orchestrator/scripts/compose-multi-account-e2e.ts`.
- [ ] **[MEDIUM] (E) CodingAgentSettingsSection and sub-sections are untested** — DOM tests for tab switching (elizaos/pi-agent/opencode/claude/codex), model selection persisting via prefs client, approval-preset changes, GitHub connection card states; integration test of the auth-sanitize/preflight-normalize helpers in the settings flow. Files: `plugins/plugin-task-coordinator/src/CodingAgentSettingsSection.tsx`.
- [ ] **[MEDIUM] (E/L) No concurrency / scale coverage for many simultaneous task rooms** — Test rapidly switching `selectedId` across many in-flight tasks asserting no cross-task transcript merge (token/selection guards hold); load test `buildConversation` with thousands of merged chunk/tool events for render-cost regressions; route test for 10 concurrent rooms in `/api/orchestrator/rooms` + before/after screenshots. Files: `plugins/plugin-task-coordinator/src/OrchestratorWorkbench.tsx`, `plugins/plugin-agent-orchestrator/src/api/orchestrator-routes.ts`.
- [ ] **[MEDIUM] (F/J) No multi-model / multi-account switching coverage in the harness** — Live-only scenario matrix running the same coding task under each provider + an account-switch scenario asserting the orchestrator routes to the selected model/account; add a finalCheck/report grouping by provider (native rows already carry provider). Files: `packages/scenario-runner/src/final-checks/index.ts`, `reporter.ts`.
- [ ] **[MEDIUM] (F/G) No first-class timeline artifact** — Emit `timeline.json` (ordered events: turn start/end, action start/end, sub-agent spawn/exit, build start/end) and render a scrubbable horizontal timeline in `writeScenarioRunViewer` aligning video time ↔ trajectory turn ↔ screenshot. Files: `packages/scenario-runner/src/reporter.ts`, `scripts/e2e-recordings/generate-viewer.mjs`.
- [ ] **[MEDIUM] (F/I) No platform-targeted scenarios (cloud/desktop/AOSP/Debian/Play/iOS)** — Parameterize scenarios by target platform + add a remote-container driver; at minimum tag scenarios with target platform and add platform-specific finalChecks (native bridge availability) wired to `os/` + remote-container infra. Files: `packages/scenario-runner/schema/index.d.ts`, `src/runtime-factory.ts`.
- [ ] **[MEDIUM] (G) Error/rollback/concurrency coding states not visually recorded** — Coding scenarios forcing a compile/test failure, a rollback, and 10 concurrent project rooms, each recorded with video + timeline + per-room screenshots, asserting UI states (error banner, rollback diff, concurrent room rail). Files: recording harness, `scripts/e2e-recordings/suites.mjs`.
- [ ] **[MEDIUM] (H) View-bundle rebuild-and-reserve is untested at the route level** — Views-routes bundle test: serve bundle, capture ETag, rewrite the file (new mtime/size), assert a fresh request returns 200 + new bytes + new ETag, and `?v=<oldHash>` vs `?v=<newHash>` cache headers differ. Files: `packages/agent/src/api/views-routes.ts`, `views-routes.hero.test.ts`.
- [ ] **[MEDIUM] (I) No concurrency / 10-project / rollback evidence for remote or local coding execution** — Integration test opening ≤10 concurrent coding sessions/containers (mixed local + remote), asserting queueing/cap, kill/keepAlive, workspace cleanup; capture a concurrent-run timeline. Files: `packages/agent/src/services/e2b-capability-router.ts`, `packages/cloud/shared/src/db/repositories/agent-sandboxes.ts`.
- [ ] **[MEDIUM] (I) Desktop (Electrobun) coding path only smoke-tested with mocked APIs** — `playwright.electrobun.packaged` e2e launching the packaged direct-build app, running a real local TASKS create against a deterministic/local runner, capturing video + before/after screenshots of the workbench diff. Files: `packages/app/playwright.electrobun.packaged.config.ts`, new spec.
- [ ] **[MEDIUM] (I) Apple-Container / Docker local-safe sandbox backend for coding untested end-to-end** — Gated integration test (docker available) running a coding command via `runShell` local-safe with a real Docker `SandboxManager`, asserting host fs untouched + logs show backend=docker. Files: `packages/agent/src/services/{shell-execution-router,sandbox-engine}.ts`.
- [ ] **[MEDIUM] (J) Sub-agent model selection is dispersed and not centrally validated** — Add a unit matrix calling real `buildEnv` + `buildOpencodeSpawnConfig` (no mock) for {claude,codex,opencode,elizaos,pi-agent} × {api-key, subscription, cloud, cerebras, local}, snapshotting the resolved (provider, model, auth, dropped-keys) tuple — the missing "model chooser" contract test. Files: `plugins/plugin-agent-orchestrator/src/services/{acp-service,opencode-config}.ts`.
- [ ] **[MEDIUM] (J) z.ai/GLM/Kimi have no first-party coding-CLI path and no rotation test** — Either add a test proving opencode can target z.ai (`ELIZA_OPENCODE_BASE_URL` + key) and document it as the z.ai coding path, or add an explicit assertion that z.ai is intentionally built-in-only for coding. Files: `plugins/plugin-agent-orchestrator/src/services/{coding-account-selection,opencode-config}.ts`.
- [ ] **[MEDIUM] (J) Live model tests all opt-in and absent from default CI** — Scheduled (nightly/weekly) CI lane running gated coding-model live tests (cerebras-spawn-subagent-refusal, native-acp-smoke per agent type, minimal coding-completion scenario) when secrets present, skipping cleanly otherwise (mirror cerebras-nightly secret-gate). Files: `.github/workflows/` (new lane).
- [ ] **[MEDIUM] (K) AgentNotification fan-out to OS/mobile not verified for orchestrator-sourced notifications** — Integration test ingesting an orchestrator-shaped notification while window unfocused asserting desktop+native sinks fire with correct title/body/deepLink; mobile bridge test stubbing Capacitor `LocalNotifications` asserting `schedule()` with the `/orchestrator` deep link. Files: `packages/ui/src/state/notifications/notification-store.ts`, `packages/ui/src/bridge/native-notifications.ts`.
- [ ] **[MEDIUM] (K) No coding-task slash command / shortcut / home-screen widget on connectors** — Add a connector-safe agent-target command (e.g. `/tasks` or `/coding`) listing active sub-agent sessions+progress via TASKS_LIST_AGENTS, register as an explicit shortcut, and test via `connector-catalog` that it appears on chat connectors; if a mobile home-screen coding-status widget is intended, add it to `plugin-native-*`. Files: `plugins/plugin-commands/src/actions/shortcuts.ts`, `connector-catalog.ts`.
- [ ] **[MEDIUM] (L) SessionEventQueue is dead/unwired code** — Either wire `SessionEventQueue` into `SubAgentRouter`/`AcpService` event emission (test ordered delivery + cross-session isolation under interleaving) or delete it. Files: `plugins/plugin-agent-orchestrator/src/services/session-event-queue.ts`, `sub-agent-router.ts`, `acp-service.ts`.
- [ ] **[MEDIUM] (L) No cross-process / multi-instance file-lock contention test** — Test two `FileSessionStore` instances on the same file racing creates/updates, asserting no lost writes + correct stale-lock takeover. Files: `plugins/plugin-agent-orchestrator/__tests__/unit/session-store.test.ts`.
- [ ] **[MEDIUM] (L) Spawn-gate (waitForSpawnSlot) has no unit test** — Unit tests for `waitForSpawnSlot`: disabled (limit ≤0), blocking-then-releasing as sessions terminate, giveup-after-maxWaitMs warn-and-proceed, correct active-session counting excluding terminal statuses. Files: `plugins/plugin-agent-orchestrator/src/actions/common.ts`.

### LOW

- [x] **[LOW] (A) Retired NFT-drop plugin scope entry** — Removed the retired NFT-drop plugin from the code-writing domain scope; future NFT coverage belongs in a web3/contracts domain if needed. Files: scope/docs only.
- [ ] **[LOW] (B) sweagent vendor source unused at runtime; SWE-bench capability not connected to ACP** — Either document `packages/sweagent` as benchmark-only (clarify scope) or add an integration path + test driving a SWE-bench-style task through the ACP orchestrator reconciled with the `benchmarks/orchestrator` viewer format. Files: `packages/sweagent/README.md`, `packages/benchmarks/orchestrator/`.
- [ ] **[LOW] (C) No timeline/screenshot/video evidence for Smithers-driven runs** — When wiring the multi-step path, capture before/after of the orchestrator task widget + a run timeline (from `TaskRunResult.metrics`) + a short video of a Smithers-driven coding task under `.github/issue-evidence/`. Files: recording harness. (Depends on Domain C wiring gap.)
- [ ] **[LOW] (D) Anthropic weekly usage (weeklyPct) parsing untested; Anthropic probe has no unit test** — Add `account-usage.test.ts` covering `pollAnthropicUsage` (both flat + nested shapes asserting sessionPct + weeklyPct + resetsAt), `pollCodexUsage`, `utilizationToPct` edge cases, `normalizeResetTimestamp` sec-vs-ms. Files: `packages/app-core/src/services/account-usage.ts`.
- [ ] **[LOW] (D) quota-aware strategy uses sessionPct only (ignores weeklyPct) and is not the runtime default** — Extend quota-aware (and optionally least-used) to consider `weeklyPct` (skip if `max(sessionPct,weeklyPct) >= threshold`) + a test; document the trade-off if intentional. Files: `packages/app-core/src/services/account-pool.ts`.
- [ ] **[LOW] (E) Reasoning/plan React renderers and TaskCardList lack direct tests** — Focused DOM tests: `ReasoningCell` expand/collapse + streaming spinner, plan-step glyph/status mapping, `TaskStatusChip`/`TaskStatusMedallion` icon+tone per status; optionally commit a curated `run-dashboard-shot` subset as visual baseline. Files: `plugins/plugin-task-coordinator/src/orchestrator-{reasoning,plan}.tsx`, `TaskCardList` primitives.
- [ ] **[LOW] (J) plugin-cli-inference single-token limitation (no AccountPool failover) untested** — Unit test confirming handlers THROW on auth failure / rate-limit (non-zero exit) so runtime `useModel` failover engages; document the single-token constraint. Files: `plugins/plugin-cli-inference/src/claude-cli.ts`.
- [ ] **[LOW] (K) ACK mode and ELIZA_SUB_AGENT_PROGRESS_* aliases under-documented vs implemented** — Update `plugins/plugin-agent-orchestrator/CLAUDE.md` (+ AGENTS.md copy) to document `ack` mode, the `ELIZA_SUB_AGENT_PROGRESS_*` aliases, and the silent synonyms, matching `parseProgressMode`. Files: `plugins/plugin-agent-orchestrator/CLAUDE.md`.

---

## 4. Test & Evidence Plan

For each capability: the harness/test to add and the evidence types to capture. Unless noted, real-LLM trajectory artifacts go to `.github/issue-evidence/<issue#>-<slug>/` (JSON report + native jsonl + run viewer); video/screenshots/timeline go to the same bundle per AGENTS.md.

| Capability | Test / harness to add | Evidence to capture | Artifact location |
|---|---|---|---|
| Live create-app loop (A) | Live scenario in `plugin-app-control/test/scenarios/` registering `START_CODING_TASK` + `AppVerificationService` | trajectory (jsonl + viewer), per-check logs, `screenshot.png`, before/after screenshots, video | `.github/issue-evidence/<#>-coding-create-app/` |
| Build/launch/browser verify (A) | chromium-gated integration test in `app-verification.integration.test.ts` | screenshot, per-check logs, report verdict | verification dir + evidence bundle |
| SHELL build-failure→fix (A) | deterministic two-step scenario (fail build → edit → exit 0) | trajectory, exit_code/stderr in ActionResult | scenario report |
| Sub-agent spawn→route (B/F) | `orchestrator-spawn-route.scenario.ts` (live) + deterministic ACP/PTY replay fixture | trajectory with linked child step, session-event timeline, logs | evidence bundle |
| Per-agent live builds (B/J) | gated `ORCHESTRATOR_LIVE` lane (elizaos/pi-agent/claude/codex/opencode) | per-agent artifact + task_complete, structured run report, served-app screenshot + video | evidence bundle |
| Smithers multi-step graph (C) | wiring test (spec passed to `runTaskWithSmithers`) + live durable-task e2e + crash-resume | trajectory, metrics timeline, final diff, stdout protocol | evidence bundle |
| WORKFLOW generation+execute (C) | live generation eval (gpt-oss-120b/claude) + 10-workflow concurrency test | trajectory, engine metrics, build/run logs | scenario report |
| z.ai usage tracking (D) | `account-usage.test.ts` + `pollZaiUsage` unit test | log (probe result), widget screenshot (usage bar or "unavailable") | evidence bundle |
| Mid-task account switch (D) | 429-injection integration test + gated live exhaustion scenario | switch timeline, before/after usage-bar screenshots, logs | evidence bundle |
| Multi-account live (D/B/J) | convert live scripts to `--report`; add hermetic compose-e2e to CI | run report, spawn-env timeline, populated-pool widget screenshot, video of diverging bars | evidence bundle |
| TaskInspector / workbench UI (E) | fix vitest alias; rewrite live e2e to real DOM contract; run vs `cloud:mock` | full-page before/after screenshots, video, console/network logs | evidence bundle |
| PTY console (E) | DOM tests (hydrate/append/trim/interrupt/unsubscribe) + real PTY e2e | screenshot + video of streamed output + interrupt | evidence bundle |
| Coding-flow video+timeline (G) | real-mode `orchestrator-live` suite + coding-timeline viewer | video, scrubbable timeline.json aligned to jsonl, milestone screenshots, logs | `e2e-recordings/` + committed bundle |
| Cross-platform device capture (G/I) | adb screenrecord / simctl recordVideo / Xvfb+ffmpeg wrappers as suites | per-platform video + screenshots + logs | platform evidence bundles |
| Reload edit→v2 + broken-reload (H) | end-to-end reimport test + real broken-plugin 422 integration test + `plugin-runtime-apply.test.ts` | logs, runtime-ops phase timeline | evidence bundle |
| Rollback (H) | two-phase reload + git-checkpoint + revert-on-failure tests; lifecycle scenario | before/after state, rollback diff screenshot, trajectory | evidence bundle |
| iOS/Play remote-container coding (I) | `coding-via-remote-container` scenario + iOS/Android device test | trajectory, runner logs, video + before/after screenshots | evidence bundle |
| AOSP/Debian boot coding smoke (I) | Cuttlefish CI lane + `just coding-smoke` | log + screenshot of workspace diff | OS release artifacts + bundle |
| Model-per-backend completion (J) | gated live scenario matrix asserting session model/account | trajectory + git changeset per backend, provider-grouped report | evidence bundle |
| Notification on completion (K) | unit assert `notify` on task_complete; OS/mobile fan-out integration test | logs, in-app/OS/mobile notification screenshots | evidence bundle |
| Progress cadence (K) | `emitProgress`/heartbeat unit test + real-connector surfacing scenario | cadence timeline, Discord/Telegram message screenshots, video | evidence bundle |
| 10-project concurrency (L) | high-concurrency profile + 10-session stress scenario + concurrent compose harness | per-session timeline, isolated-workspace assertions, workbench-with-10-rooms screenshot | evidence bundle |

---

## 5. Recommended Execution Order

Batches within a wave can run in parallel as independent implementation workflows; later waves depend on earlier ones as noted.

### Wave 0 — Unblock the test suite & fix correctness bugs (do FIRST; blocks everything else)
*These are prerequisites — green CI and a non-corrupting concurrency model must exist before evidence is meaningful.*
- **Batch 0.1 (Domain E):** Fix the `@elizaos/shared/voice-eot` vitest alias so the TaskInspector suite loads; confirm `plugin-task-coordinator` test exits 0 and wire into CI.
- **Batch 0.2 (Domain L) — CRITICAL correctness:** Implement default per-session workspace isolation in `resolveDefaultSpawnWorkdir` + test. *(Blocks all concurrency scenarios in Waves 2–3.)*
- **Batch 0.3 (Domain H) — CRITICAL correctness:** Implement two-phase reload + rollback (snapshot/restore plugin graph + adapter, build the cold-restart contract) + `plugin-runtime-apply.test.ts`. *(Blocks reload/rollback scenarios in Wave 3.)*
- **Batch 0.4 (Domain B):** Repair the broken task-agent live E2E (path, `PTYService`→`AcpService`, mode) + add an import-shape smoke. *(Unblocks live orchestration evidence in Wave 2.)*

### Wave 1 — Stand up the evidence infrastructure (parallel; enables every other batch's evidence)
- **Batch 1.1 (Domains F/G):** Add real screenshot/video capture into scenario-runner + the coding-flow recording harness + scrubbable timeline viewer aligning video↔jsonl↔screenshot; define the committed-evidence convention under `.github/issue-evidence/` and extend `check-live-test-artifact-coverage.mjs` to enforce it.
- **Batch 1.2 (Domain F):** Add sub-agent orchestration support to the harness (turn-kind/seed + deterministic ACP/PTY replay fixture) + new finalChecks (`subAgentSpawned`/`taskRoomCreated`/`diffProduced`/`buildPassed`/`buildValidation`/`reloadOccurred`/`rollbackRestored`). *(Depends on 0.4 for the live variant.)*
- **Batch 1.3 (Domain J):** Add the centralized model-chooser contract test (`buildEnv`+`buildOpencodeSpawnConfig` matrix) — pure unit, no live deps, high value, independent.

### Wave 2 — Headline live capability evidence (parallel; each depends on Wave 1's harness)
- **Batch 2.1 (Domains A/F):** Live create-app loop scenario + build/launch/browser integration test (depends on 1.1, 1.2).
- **Batch 2.2 (Domains B/F/J):** Spawn→route live scenario + per-agent (`ORCHESTRATOR_LIVE`) builds + per-backend completion matrix + served-app screenshot/video (depends on 0.4, 1.1, 1.2, 1.3).
- **Batch 2.3 (Domain C):** Wire the Smithers multi-step graph into production + wiring test + live durable-task e2e + Smithers trajectory evidence (depends on 1.2).
- **Batch 2.4 (Domain D):** z.ai usage tracking (`pollZaiUsage`) + mid-task switch test + multi-account live evidence + `account-usage.test.ts` (independent of Wave 1 for unit parts; uses 1.1 for evidence).

### Wave 3 — UI, surfacing, concurrency, lifecycle (parallel)
- **Batch 3.1 (Domain E):** PTY console DOM/e2e tests, settings-section tests, rewritten live workbench e2e, coding-chat UX evidence (depends on 0.1, 1.1).
- **Batch 3.2 (Domain K):** Notification-on-completion + cadence/`emitProgress` tests + real-connector surfacing scenario + surfacing evidence + the connector-safe `/tasks` shortcut (depends on 1.1).
- **Batch 3.3 (Domain L):** High-concurrency profile + 10-session stress scenario + concurrent compose harness + spawn-gate/SessionEventQueue/file-lock tests (depends on 0.2, 1.2).
- **Batch 3.4 (Domains A/H/F):** Rollback/undo for direct edits + git-checkpoint + create→modify→reload→rollback lifecycle scenarios (depends on 0.3, 1.2).

### Wave 4 — Platform breadth & cross-cutting evidence (parallel; largest infra, lowest urgency)
- **Batch 4.1 (Domain I):** iOS/Play remote-container coding scenario + Android/AOSP device coding e2e + Debian-live boot coding smoke + Docker local-safe sandbox test + remote-runner CI lane (depends on Wave 1 + the device-capture wrappers from 1.1).
- **Batch 4.2 (Domains G/I):** Cross-platform device video/timeline capture wrappers registered as recording suites; error/rollback/concurrency visual recordings (depends on 1.1, 3.3, 3.4).
- **Batch 4.3 (Domains C/J/F):** Non-sqlite Smithers backend validation, scheduled live-model CI lane, platform-tagged scenarios + remote-container driver, db-backend test refactor (depends on 2.3).
- **Batch 4.4 (LOW cleanups, any time):** Document sweagent as benchmark-only; weeklyPct strategy extension; cli-inference failover test; progress-mode docs; reasoning/plan/TaskCard DOM tests; mobile FILE backend contract test.

**Dependency summary:** Wave 0 (correctness + unblock) → Wave 1 (evidence infra) → Waves 2/3 (capability evidence, parallel) → Wave 4 (platform breadth). The two true blockers are 0.2 (workspace isolation — without it concurrency scenarios prove a broken design) and 0.3 (rollback — without it the lifecycle/reload scenarios have nothing to assert). Batch 1.1 is the critical-path enabler: nearly every HIGH evidence gap across all 12 domains routes through the screenshot/video/timeline capture it builds.
