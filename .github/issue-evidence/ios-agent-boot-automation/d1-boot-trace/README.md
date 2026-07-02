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
