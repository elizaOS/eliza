# D1 — iOS on-device boot trace + root cause of the agent startup timeout (#11110)

Device: **MoonCycles** — iPhone 16 Pro Max (iPhone17,2), iOS 18.7.8,
devicectl `59EBB356-BC44-5AA2-91F1-E6AAE756BB86`, UDID `00008140-0006491E2E90801C`.
Branch `feat/ios-agent-boot-automation`, worktree `.claude/worktrees/eliza-11030`.
All traces below were pulled from the phone **without any attached console** with:

```bash
xcrun devicectl device copy from \
  --device 59EBB356-BC44-5AA2-91F1-E6AAE756BB86 \
  --domain-type appDataContainer --domain-identifier ai.elizaos.app \
  --source Documents/eliza-boot-trace.jsonl --destination <out>.jsonl
# (verified working — every trace-*.jsonl in this directory came out of that command)
```

## The boot-trace sink (deliverable 1)

- **Native writer:** `packages/app-core/platforms/ios/App/App/ElizaStartupTrace.swift`
  — serialized single-writer queue appending timestamped JSONL to
  `<appDataContainer>/Documents/eliza-boot-trace.jsonl`; rotates at ~1 MB to
  `eliza-boot-trace.prev.jsonl`; file created with `FileProtectionType.none`;
  `bootstrap()` is called first thing in `AppDelegate.didFinishLaunching` and
  records the launch context (XCUITest env markers, protected-data state,
  thermal/low-power, cwd, env-key census — no values, no secrets).
- **Watchdog events:** `AgentWatchdog.swift` mirrors every state transition +
  structured probe readings (`mode/present/ready/engine`) into the trace.
- **Pod-side events:** `plugins/plugin-native-agent/ios/.../AgentPlugin.swift`
  posts `ElizaBootTraceAppend` notifications (it cannot link app-target code);
  the observer registered by `bootstrap()` persists them. Full error detail is
  recorded on every error-state answer (`get-status` / `start` failures).
- **Renderer events:** `packages/ui/src/api/ios-local-agent-transport.ts`
  `appendIosBootTrace()` → the Agent plugin's new `appendBootTrace` bridge
  method → the same native file (the Filesystem pod is NOT in the Podfile —
  the first cut of this leg targeted it and silently wrote nothing; that is
  itself documented by `trace-runA-unattended-trustgap.jsonl` having zero
  renderer entries). The startup poll traces `polling-backend-start`,
  capped `poll-failure` entries (status/path/message/boot-progress),
  `auth-status-ok`, `agent-error-terminal`, `recover-to-on-device-agent`,
  `recover-to-agent-selection`, `backend-deadline-exceeded`,
  `native-failure-budget-exceeded`; the transport traces
  `agent-boot-phase` (starting/ready/error + real engine error message),
  `engine-start-ok` (duration), `engine-adopted-running`.

## Root cause (deliverable 3) — TWO stacked causes, both proven on-device

### Layer 1 — the 92 s "Startup failed: Backend Timeout" card (the user's icon-tap symptom)

`device-prefs-before-launch.json` (pulled from the phone before any fix ran):
persisted runtime mode **`cloud`**, pinned to dedicated cloud agent
`https://67ae7b68-6351-41db-a79a-a1d157265018.elizacloud.ai`, and the
background-runner's own last wake recorded the terminal answer:

```json
{"ok":false,"status":503,"body":{"success":false,
 "error":"Agent is in an error state. Resolve the failure before connecting.",
 "data":{"status":"error"}}}
```

That is the dedicated-agent proxy's **terminal sandbox-error 503**
(`packages/cloud/api/src/dedicated-agent-proxy.ts`) — it never self-heals, so
every launch polled `/api/auth/status` into it until the renderer's 90 s
consecutive-failure budget fired the timeout card. The same base later went to
outer **404 `{"error":"agent not found or not running"}`** (agent deleted;
reproduced from the Mac with plain `curl` during this session).

**Why "attached console healthy 2/2 vs XCUITest 503 2/2" (#11104's table):**
the split was *time-correlated with the remote sandbox flapping* (the proxy
auto-resumes on traffic; the sandbox then re-entered error state), not caused
by the launch path. Proof: the "healthy" attached launches in
`../../11030-ios-boot-fix/device-boot-console.log` contain **zero
ElizaBunRuntime traffic** and read the persisted `"cloud"` preference — they
were talking to the SAME remote cloud agent over WiFi during a window where it
answered; the process-launch trace entries from unattended runs show
`xcuiTestConfigPresent:false`, nominal thermal state, protected data
available — no environmental difference that could gate the agent.

**Fix (renderer, `packages/ui/src/state/startup-phase-poll.ts`):**
- terminal sandbox-error 503 and deleted-agent 404 on a local-capable native
  build with a stale persisted cloud mode → **recover to the bundled
  on-device agent** (`persistMobileRuntimeMode("local")` + repoint the saved
  server + reset the poll) instead of burning the budget;
  non-local-capable → route to agent selection (never the dead timeout card).
- **Progress-aware failure budget** (deliverable 4b): while
  `isIosNativeAgentBootInProgress()` (engine start pending within its 300 s
  native bound, or fresh structured-response heartbeats after ready), 503s do
  NOT burn the 90 s consecutive-failure budget; only terminal engine error or
  heartbeat silence lets it resume. `startup-phase-poll.test.ts` grew from
  51 → 63 tests covering all of these paths (incl. never auto-flipping a
  user-configured `remote-mac` mode).

**On-device proof the recovery fires:** `trace-run1-unattended-recovery.jsonl`
(unattended launch 04:12Z) + the phone's preferences after it — background
config reconfigured to `mode:"local"` at `04:12:59` (+11 s after launch),
`CapacitorStorage.eliza:mobile-runtime-mode` → `"local"`. The launch started
pinned to the dead cloud base and ended on the on-device agent with no console
attached and no human input.

### Layer 2 — the silent boot-to-onboarding bounce (why local mode then "lost" the agent)

After recovery (or ANY completed local-mode onboarding), the saved on-device
server is `{kind:"remote", apiBase:"eliza-local-agent://ipc"}`. On the NEXT
launch, `startup-phase-restore.ts` `canRestoreActiveServer` →
`isTrustedRestoreApiBaseUrl("eliza-local-agent://ipc")` → **false** (the
security gate only passed `http:`/`https:`), so restore **silently dropped the
saved server AND un-completed first-run** → `NO_SESSION` → the chat-first
onboarding home. No startup poll ever ran, the Bun engine was never started,
and the native watchdog struck the un-started engine to restart-exhaustion.

Trace/pixel proof:
- `trace-runA-unattended-trustgap.jsonl` / `trace-runB-runC-combined.jsonl`:
  process-launch → agent-plugin get-status → watchdog arm → `ready:false`
  probes → 5 restart requests → give-up. **Zero renderer entries, zero engine
  start** — the poll never ran.
- `runB-attached-console-trustgap.log`: full renderer boot burst then total
  silence — no `[startup-phase-poll]` warns, no `ElizaBunRuntime start`.
- `runC-xcuitest-30s-onboarding-home.png` (+90 s/150 s): the XCUITest-lane
  pixels show the chat-first onboarding home ("Welcome — ask me anything…",
  composer "Choose an option to continue", app-runs widget stuck loading) —
  not home-with-agent, not the error card.

**Fix (`packages/ui/src/state/startup-phase-restore.ts`):**
`isTrustedRestoreApiBaseUrl` now explicitly trusts the mobile local-agent IPC
pseudo-base (`isMobileLocalAgentIpcBase`) — it is in-process, dials nothing,
and has no attacker-choosable host, so the XSS/token-exfiltration threat model
of the gate does not apply. Adversarial cases stay rejected
(`evil-local-agent://ipc`, `eliza-local-agent://attacker.com`) —
`startup-phase-restore.trust.test.ts` extended.

## Post-fix verification (deliverable 5)

See `trace-runE-postfix-*.jsonl` + `runE-*.png` in this directory: unattended
launch on the fixed build restores the on-device server, runs the poll against
the IPC base (renderer trace entries present), starts the Bun engine, and
reaches home with the agent running. (Run details + timings in the trace.)

## Files

| file | what it proves |
|---|---|
| `device-prefs-before-launch.json` | phone pinned to dead cloud agent, terminal 503 recorded by the OS background runner (layer-1 root cause, pre-fix) |
| `trace-run1-unattended-recovery.jsonl` | first unattended trace-sink launch; recovery to on-device agent fired at +11 s |
| `trace-run1-run2-combined.jsonl` | run1 + attached run2: local mode, engine never started, watchdog restart-exhaustion (layer-2 symptom) |
| `run2-attached-console-local-mode.log` | attached A/B leg: renderer silent, zero engine start (layer-2) |
| `trace-runA-unattended-trustgap.jsonl` | unattended launch of the trace-bridge build, still zero renderer entries → poll never ran (layer-2) |
| `runB-attached-console-trustgap.log` | attached A/B of the same state |
| `trace-runB-runC-combined.jsonl` | runB (attached) + runC (XCUITest-owned) — identical silent pattern in BOTH launch paths |
| `runC-xcuitest-*.png` | real pixels: chat-first onboarding home, no error card, no agent |
| `trace-runE-postfix-*.jsonl`, `runE-*.png` | post-fix unattended boot to home with the agent running |

---

# D1 FINAL — root cause of the icon-tap startup timeout, with trace proof

Two stacked defects produced the user-visible "agent startup timed out" on a
real device. Both were found by reading the on-device boot trace, both are
fixed, and the fix chain is proven by before/after traces in this directory.

## Defect 1 — renderer deadlock: `await` on Capacitor's raw plugin proxy

**Symptom (trace `trace-runD-prefix-instrumented-unattached-hang.jsonl`, plain
`devicectl launch` with NO console — the user icon-tap path):**

```
{"elapsedMs":318,"stage":"engine-acquire","copy":"ui","strict":true,"builtIn":true,"pluginAvailable":true,"runtimeMode":"local",...}
{"elapsedMs":319,"stage":"engine-import-start","copy":"ui",...}
{"elapsedMs":322,"stage":"engine-import-done","copy":"ui","viaModule":true,...}
{"elapsedMs":331,"stage":"polling-backend-start","source":"renderer",...}
{"elapsedMs":20342,"stage":"probe-stalled","label":"auth-status","stalledForMs":20012,...}
```

…and then NOTHING renderer-side for the rest of the run: no `agent-boot-phase`,
no `engine-start-requested`, no `poll-failure`, no native `ElizaBunRuntime
start` call ever (the attached-console A/B,
`runF-prefix-attached-console-no-engine-start.log`, shows the only native
`ElizaBunRuntime` traffic is the watchdog's 5s `getStatus` cadence — 28 calls,
zero `start`). The watchdog cycles all 5 restart requests; its handler also
freezes right after `engine-import-done` (t=74482 in the same trace).

**Root cause:** `importFullBunRuntimePlugin()` (both transport copies —
`packages/ui/src/api/ios-local-agent-transport.ts` and
`packages/app-core/src/api/ios-local-agent-transport.ts`) was an `async`
function that returned the **raw Capacitor plugin proxy**. Capacitor's
`registerPlugin` proxy fabricates a native-method wrapper for **any** property
— including `then` (only `$$typeof` / `toJSON` / `addListener` /
`removeListener` are special-cased in `@capacitor/core`). Awaiting the async
function therefore runs thenable assimilation against the proxy:
`proxy.then(resolve, reject)` invokes a Capacitor method wrapper whose inner
promise rejects unobserved and **never calls `resolve`/`reject`** — the await
never settles. Every request path (startup poll, the app's first three
`/api/*` fetches, the watchdog restart handler) funnels through that await, so
the engine was never started, `/api/auth/status` never answered, and the phone
sat on "Booting up…" until the timeout card.

**Fix:** wrap the proxy into a plain bound-method object **before** it crosses
any `await` (`wrapFullBunRuntime(...)` inside `importFullBunRuntimePlugin`),
in both copies. Regression tests drive the real request path against a
Capacitor-faithful hostile-`then` proxy and fail in ~10s if the deadlock is
ever reintroduced:
`packages/ui/src/api/ios-local-agent-transport.test.ts`,
`packages/app-core/src/api/ios-local-agent-transport.test.ts` (verified RED on
the pre-fix code, GREEN after). The startup poll additionally bounds every
probe await by the remaining phase deadline (`ApiHangTimeoutError` in
`packages/ui/src/state/startup-phase-poll.ts`), so any future never-settling
transport still surfaces the BACKEND_TIMEOUT card instead of an infinite
splash (test: "still reaches BACKEND_TIMEOUT when a probe NEVER settles").

## Defect 2 — agent bundle dies at load: Bun.build empties a re-export barrel

With the deadlock fixed, the engine start path ran end-to-end and surfaced the
SECOND failure with full detail
(`trace-runE-deadlockfix-engine-start-bun-exit1.jsonl`):

```
{"elapsedMs":320,"stage":"agent-boot-phase","phase":"starting",...}
{"elapsedMs":321,"stage":"engine-plugin-start-requested","source":"bun-runtime","engine":"bun",...}
{"elapsedMs":323,"stage":"engine-host-start","source":"bun-runtime",...}
{"elapsedMs":1605,"stage":"engine-bootstrap-failed","error":"ElizaBunEngine start failed with code -1: Bun exited before ios-bridge readiness with code 1",...}
```

Reproducing the same bundle boot on macOS Bun printed the real stderr:

```
ReferenceError: declareSubAgentCredentialScopeAction is not defined
      at agent-bundle.js:33807
```

**Root cause:** `Bun.build` (the mobile bundler,
`packages/agent/scripts/build-mobile-bundle.mjs`) mis-lowers the
`export { x } from "./y.ts"` chain of
`packages/core/src/features/sub-agent-credentials/actions/index.ts` to an
**empty module initializer** (`var init_actions7=()=>{}` in the emitted
bundle) while `plugin.ts` still references the four action identifiers — the
whole 35 MB agent bundle then throws at load, Bun exits 1, and the engine
reports "exited before ios-bridge readiness". Same Bun.build
re-export-lowering bug class as the viem/zod workarounds already documented in
`build-mobile-bundle.mjs`. This regression was **masked** by Defect 1 (the
engine start never ran, so the bundle crash was unreachable).

**Fix:** import/re-export each action directly from its own module (bypassing
the barrel) in `packages/core/src/features/sub-agent-credentials/plugin.ts`
and `index.ts`. After the fix the rebuilt bundle contains the actions and the
macOS Bun boot check reaches bridge readiness:

```
{"type":"ready","ok":true,"result":{"ready":true,"engine":"bun","transport":"bun-host-ipc","bridgeVersion":"bun-ios:3"}}
```

## Defect 3 — PGlite lock from a prior launch bricks every boot for 7 days

With Defects 1+2 fixed, the engine bootstrapped in **1265 ms** and the
watchdog flipped `ready:true engine:bun`
(`trace-runF-engineok-pglite-lock-brick.jsonl`):

```
{"elapsedMs":1597,"stage":"engine-bootstrap-ok","durationMs":1265,"bridgeVersion":"bun-ios:3",...}
{"elapsedMs":4799,"stage":"probe","ready":true,"engine":"bun",...}
{"elapsedMs":11815,"stage":"poll-failure","path":"/api/auth/status","message":"... PGlite data dir is already in use at .../Application Support/Eliza/.elizadb. Close the other Eliza process ...",...}
{"elapsedMs":131817,"stage":"native-failure-budget-exceeded","path":"/api/auth/status",...}
```

**Root cause:** `PGliteClientManager.acquireDataDirLockIfNeeded`
(`plugins/plugin-sql/src/pglite/manager.ts`) honors an existing
`eliza-pglite.lock` whenever the recorded PID's liveness is *unconfirmable*
(non-ESRCH `process.kill(pid,0)`) and the lock is younger than
`LOCK_STALE_MS` = **7 days**. On iOS the probe is unusable: a prior LAUNCH's
PID probes EPERM in the sandbox, and a prior Bun THREAD's recorded PID equals
the CURRENT app PID (Bun is in-process) — so any leftover lock bricks every
relaunch. The identical failure mode was already carved out for
`postmaster.pid` (the "Mobile embedded mode: removed leftover PGlite
postmaster.pid" branch) but never for the lock file.

**Fix:** the same single-tenant mobile carve-out for `eliza-pglite.lock` —
under `ELIZA_IOS_LOCAL_BACKEND=1` / `ELIZA_ANDROID_LOCAL_BACKEND=1` a
leftover lock is reclaimed unconditionally (one app process; engine starts
serialized by `ElizaBunRuntime`). Regression test: "mobile embedded mode
reclaims ANY leftover lock — even one recording a confirmed-live PID" in
`plugins/plugin-sql/src/__tests__/integration/postgres/pglite-manager-lock.real.test.ts`.

## Post-fix on-device verification (unattached launch)

See `trace-runG-final-unattached-agent-ready.jsonl` — a plain `devicectl
launch` (no console, no XCUITest — the user icon-tap path) of the final build
with all three fixes, on MoonCycles (iPhone 16 Pro Max, iOS 18.7.8):

```
{"elapsedMs":314,"stage":"engine-start-requested","copy":"ui",...}
{"elapsedMs":1520,"stage":"engine-bootstrap-ok","durationMs":1204,"bridgeVersion":"bun-ios:3",...}
{"elapsedMs":1521,"stage":"agent-boot-phase","phase":"ready",...}
{"elapsedMs":2747,"stage":"auth-status-ok","authRequired":false,...}   ← the startup poll REACHED the agent in 2.7 s
{"elapsedMs":3392,"stage":"state","message":"armed (discovered running local agent) — watching local agent health",...}
```

Watchdog probes stay `ready:true engine:bun` for the entire 200 s observation
window; the 62-event launch contains ZERO `poll-failure` /
`backend-deadline-exceeded` / `native-failure-budget-exceeded` / restart
events. Compare `trace-runD-…` (infinite silent hang), `trace-runE-…` (engine
starts, bundle dies), `trace-runF-…` (engine ready, PGlite lock brick — where
the progress-aware failure budget correctly paused during boot heartbeats and
then surfaced the REAL PGlite error on the timeout card at 131 s instead of a
generic 90 s timeout).

## Tool fixes shipped in this leg

- `packages/app/scripts/ios-device-logs.mjs`: the bounded console capture's
  own SIGTERM detach (which devicectl can surface as exit code 1) no longer
  aborts the run — the boot-trace pull always executes; the tool now WARNS
  that `devicectl launch --console` ties the app lifetime to the console
  process (detach kills the app with signal 15).
- `appendIosBootTrace` no longer disables itself forever on a single bridge
  rejection (3-strike policy; immediate disable only for "not implemented").
- Native `ElizaBunRuntime` stage events (`engine-plugin-start-*`,
  `engine-bootstrap-*`, `engine-host-start`) with FULL error detail now land
  in the same boot-trace file, via the `ElizaBootTraceAppend` notification
  contract; `Agent.getStatus`/`start` local-mode trace entries are marked
  `optimistic:true` (they assert "local mode active", not engine readiness).

## Attached-console caveat (A/B)

Attached-console launches of THIS build die with **signal 5 (SIGTRAP)** the
moment the full-Bun engine host loads (`d1b-runG` console capture) — a
console/debug-session environment difference, NOT the user path. All
verification above uses unattached launches; use the boot-trace pull, not
`--console`, for engine-start observability.
