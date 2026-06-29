# #10203 — Agent crash/restart stability matrix

The work-order answer to "who owns the agent process, when does it restart, what
survives, and how do you prove it." This is the acceptance-criterion-#1 matrix,
plus the crash-injection hooks, memory telemetry, and the test/evidence lanes
that exercise each row.

## 1. Ownership × restart policy × persistence × evidence

| Environment | Process owner / supervisor | Restart policy | Persists across restart | Drops (volatile) | Evidence command |
| --- | --- | --- | --- | --- | --- |
| **Local CLI / dev / packaged desktop** | `packages/app-core/scripts/run-node.mjs` spawns the agent; respawns the child on **exit code 75** (`RESTART_EXIT_CODE`), rebuilding if `dist` is stale | **Auto-restart** on code 75; **storm-guard**: > `MAX_RESTARTS_IN_WINDOW` (5) restarts in `RESTART_WINDOW_MS` (60s) → abort exit 1; non-75 codes propagate; signals → exit 1 | SQL store (`${STATE_DIR}` PGlite/Postgres): conversations, memories, scheduled tasks, config, wallet/vault, media (content-addressed) | in-memory caches (`stateCache`), in-flight model calls, unsaved stream buffers, the requesting turn | `RUN_CRASH_RESTART_E2E=1 bun run --cwd packages/agent test -- crash-restart-supervisor` (proves respawn + storm-guard); restart cadence in `${STATE_DIR}/telemetry/restart/events.json` |
| **Restart request from inside the agent** | `@elizaos/shared` `requestRestart()` → host `setRestartHandler` → `process.exit(75)` | Controlled restart (config change, plugin install/eject, self-edit) — flushes state, then the supervisor relaunches | as above (clean shutdown path) | as above | `requestRestart()` consumers: `packages/agent/src/actions/{plugin,runtime}.ts`, `services/plugin-installer.ts`, `app-core/src/cli/run-main.ts` |
| **Cloud / dedicated agent** | Kubernetes `Deployment` reconciled by `@elizaos/operator` (Pepr) in `eliza-agents` ns; KEDA `ScaledObject`; per-pod `agent-server`; health via `eliza-sandbox` `health_url` | **k8s auto-restart** (Pod `restartPolicy: Always` + liveness/readiness); version swap = snapshot → image cutover → restore (#9964); rollback restores prior image | Railway Postgres (per-org DB), R2 media, vault; snapshot-before-swap captures agent state | container-local tmp, in-flight requests during cutover | `bun run cloud:mock` + hit the dedicated-agent proxy; `packages/cloud/shared/src/lib/services/eliza-sandbox.test.ts` (snapshot/upgrade/downgrade); pod logs `[agent-sandbox] / [provisioning-jobs]` |
| **Capacitor iOS (local agent)** | iOS app shell; `packages/app/src/mobile-lifecycle.ts` foreground/background; bundled JSC/bun runtime; `plugin-native-mobile-agent-bridge.startInboundTunnel` (idempotent start/restart) | **User-visible recovery** — OS may suspend/kill in background; on foreground the lifecycle re-dispatches resume + re-establishes the network bridge; tunnel restart is idempotent | on-device SQLite/PGlite store; vault in iOS Keychain | background sockets, suspended timers | `bun run --cwd packages/app capture:ios-sim` (after `build:ios` + cap sync + reinstall) — **device/sim-gated, see §5** |
| **Android (local / system agent)** | Android app / launcher shell; foreground service; OkHttp WebSocket bridge; same lifecycle seam | **User-visible recovery** + foreground-service keep-alive; Doze/background kill → resume on foreground; bridge restart idempotent | on-device store; vault in Android Keystore | background sockets, Doze-deferred work | `bun run --cwd packages/app capture:android-emu` (after `build:android` + `adb install -r`) — **device/emu-gated, see §5** |
| **Test harness** | `scenario-runner` boots a real `AgentRuntime` per scenario (`runtime-factory.ts`); vitest unit/integration | **Explicit non-restart** — a harness crash fails the run; isolation is `per-scenario` | scenario PGlite (ephemeral) | everything (ephemeral by design) | `packages/agent/src/runtime/crash-injection.test.ts` (14 keyless unit tests) |

## 2. Crash / hang injection hooks (`crash-injection.ts`)

New: `packages/agent/src/runtime/crash-injection.ts` — a **dev/test-only**,
**production-gated** fault injector. Disarmed by default; **refuses to arm in a
production runtime** (`NODE_ENV=production` / `ELIZA_BUILD_VARIANT=production`)
unless `ELIZA_ALLOW_CRASH_INJECT=1`, because an armed crash hook in prod is itself
an availability vulnerability.

Arm with `ELIZA_CRASH_INJECT="<point>:<mode>[:<arg>],..."`:

- **points:** `boot`, `ready`, `steady`, `plugin-load`, `model-load`, `native-bridge`, `message`, `voice`
- **modes:** `exit` (fatal crash), `throw` (unguarded bug), `reject` (unhandled rejection), `hang` (block N ms / indefinitely), `oom` (grow heap N-MB chunks), `restart` (clean exit 75)

`maybeInjectFault(point)` is the seam called at each lifecycle point; it fires at
most once per point (no storm). Examples that map to a real recovery path:

| Inject | Simulates | Expected supervised outcome |
| --- | --- | --- |
| `ELIZA_CRASH_INJECT=boot:exit` | fatal crash during boot | local: supervisor respawns; cloud: k8s restarts Pod |
| `ELIZA_CRASH_INJECT=plugin-load:throw` | a bad plugin | boot fails loudly; supervisor restarts; last-failed plugin recorded |
| `ELIZA_CRASH_INJECT=steady:oom:200` | memory leak / OOM | memory sampler trend shows growth; runtime OOM-kills; supervisor restarts |
| `ELIZA_CRASH_INJECT=native-bridge:restart` | bridge loss → clean restart | exit 75 → supervised respawn; tunnel re-established idempotently |
| `ELIZA_CRASH_INJECT=model-load:hang:5000` | model load hang | readiness gate stalls; watchdog/operator probe can act |

## 3. Memory / health telemetry (`boot-telemetry.ts`)

Already wired in `packages/agent/src/runtime/eliza.ts`:

- `recordBootEvent(label)` → `${STATE_DIR}/telemetry/restart/events.json` (bounded rolling array) — fires at the **start** of every boot, so a restart storm where boots never finish is still countable.
- `startMemorySampler({intervalMs})` → periodic RSS, tracks peak, flushes `${STATE_DIR}/telemetry/memory/latest.json` on `beforeExit`/`SIGTERM` — the **before/after memory summary** for long-running and crash-injection runs.
- `recordBootTelemetry(summary)` → boot phase timings + `process.memoryUsage()` snapshot.

A long-running or crash-injection run therefore yields: restart cadence
(`restart/events.json`), a memory trend with peak (`memory/latest.json`), and
boot timings — the artifacts the closing-PR evidence requires.

## 4. Test coverage delivered in this change

| Test | Lane | Proves |
| --- | --- | --- |
| `src/runtime/crash-injection.test.ts` (14) | default (keyless) | parse, the production safety gate (refuses to arm in prod), every fault mode, fire-once |
| `test/crash-restart-supervisor.test.ts` (7) | on-demand `RUN_CRASH_RESTART_E2E=1` (real `bun` child processes) | crash injection produces the right exit codes; supervisor **respawns on 75 until clean**, **propagates** non-75, and **aborts a restart storm** after MAX+1 — the live-agent crash→restart path |

```
$ bunx vitest run src/runtime/crash-injection.test.ts            # 14 passed
$ RUN_CRASH_RESTART_E2E=1 bunx vitest run test/crash-restart-supervisor.test.ts  # 7 passed
$ bunx vitest run test/crash-restart-supervisor.test.ts          # 7 skipped (fast lane)
```

## 5. Hardware / environment-gated lanes — explicit N/A with reasons

Per the acceptance criteria, these are the rows that need real devices/infra and
are **documented manual lanes**, not silently skipped:

| Lane | Status | Reason / command |
| --- | --- | --- |
| iOS background/foreground/sleep-wake on device or simulator | **N/A here — sim/hardware-gated** | needs a booted iOS sim + a fresh `build:ios` install; `bun run --cwd packages/app capture:ios-sim` (relates to #9967/#9958) |
| Android background/Doze/foreground-service kill on device/emulator | **N/A here — device/emu-gated** | needs an Android emulator/device + `build:android` + `adb install -r`; `bun run --cwd packages/app capture:android-emu` (#9967) |
| Cloud dedicated-agent crash → k8s restart, version swap/rollback round-trip | **N/A here — live-infra-gated** | needs the live cloud stack / provisioning daemon; `bun run cloud:mock` covers the local pieces; full round-trip relates to #9964 |
| Long-running OOM-trend capture (hours) | **N/A here — time-gated** | run `ELIZA_CRASH_INJECT=steady:oom:200` against a local agent and collect `memory/latest.json`; not a CI-time lane |

Local-agent crash/restart (logs + exit-code contract + storm-guard) **is**
proven keyless above. Cloud-agent crash/restart is covered at the unit/service
level (`eliza-sandbox.test.ts`); the live round-trip is the infra-gated lane.
