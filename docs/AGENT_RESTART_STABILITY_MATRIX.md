# Agent Restart Stability Matrix

This matrix answers who owns each agent process, what restart behavior is
expected, what state must survive, and which command produces reviewer evidence.
It covers issue #10203 and should be updated when a row moves from
hardware-gated to automated.

## Environment Matrix

| Environment | Process owner | Restart policy | State that must survive | Volatile state that may drop | Evidence command or lane |
| --- | --- | --- | --- | --- | --- |
| Local CLI / dev server | `packages/app-core/scripts/run-node.mjs` supervises the agent child process | Auto-restart only on `RESTART_EXIT_CODE` (`75`); non-restart exits propagate; storm guard aborts repeated restart loops | `STATE_DIR` SQL data, memories, conversations, scheduled tasks, vault/config, content-addressed media | In-flight model calls, transient stream buffers, process-local caches | `RUN_CRASH_RESTART_E2E=1 bun run --cwd packages/agent test -- crash-restart-supervisor` |
| Agent self-requested restart | `@elizaos/shared` `requestRestart()` delegates to the registered host restart handler | Controlled restart through the host supervisor after a clean shutdown path | Same as local CLI / dev server | Same as local CLI / dev server | Unit coverage around restart handler consumers plus the local supervisor e2e above |
| Packaged desktop | Electrobun shell plus app-core runtime process | User-visible relaunch or host-supervised restart, depending on package mode | Local app state, persisted runtime state, vault/config, content-addressed media | In-flight desktop bridge requests and transient renderer state | `bun run --cwd packages/app test:desktop:packaged` and packaged relaunch specs under `packages/app/test/electrobun-packaged/` (`electrobun-relaunch.e2e.spec.ts`) |
| Cloud / dedicated agent | Cloud operator, Kubernetes deployment, sandbox/provisioning services | Kubernetes restart policy and health probes restart failed pods; version swap/rollback uses snapshot and restore | Cloud database rows, R2/media artifacts, vault-backed secrets, deployment snapshot | Container-local temp data and requests interrupted by pod restart | `bun run cloud:mock` for local service coverage; live infra crash/restart remains cloud-credential-gated |
| Capacitor Android local agent | Android app foreground service and native agent bridge | Foreground service should restart the embedded local agent or surface a diagnostic failure; bridge start/restart is idempotent | On-device store, Android Keystore-backed secrets, content-addressed media | Background sockets, Doze-deferred timers, in-flight native bridge calls | `bun run --cwd packages/app test:e2e:android:lifecycle:reboot` once #10397 lands; current stock-device evidence is blocked by `503 local_agent_unavailable` before crash injection |
| Capacitor Android cloud mode | Android WebView plus cloud API bridge | App should recover bridge/network state on foreground and avoid pretending a local agent exists | Cloud-backed account/session state and local preferences | In-flight bridge calls, network sockets, transient UI request state | `bun run --cwd packages/app test:e2e:android:cloud` (the dedicated `--cloud` lane), plus screenshot/logcat evidence |
| Capacitor iOS local agent | iOS app shell, native local runtime, mobile agent bridge | Foreground/resume should re-establish the idempotent tunnel; OS background kills must become user-visible recovery or diagnostics | On-device store, Keychain-backed secrets, content-addressed media | Suspended sockets, background timers, in-flight native bridge calls | `bun run --cwd packages/app capture:ios-sim` after `build:ios`, cap sync, and reinstall; physical-device sleep/wake remains hardware-gated |
| Scenario runner / test harness | Scenario runner creates isolated `AgentRuntime` instances | Explicit non-restart; a harness crash fails the scenario run | Scenario report artifacts and any configured test database state | The ephemeral scenario runtime | `packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>` with live model credentials for behavior changes |

## Crash Injection Expectations

Crash and restart tests must use dev/test-only injection hooks. Production builds
must not expose arbitrary crash controls.

| Fault class | Example trigger | Expected result |
| --- | --- | --- |
| Clean restart | Runtime exits with code `75` | Supervisor restarts the agent and records restart evidence |
| Fatal crash | Process exits with a non-restart code or signal | Supervisor reports or propagates the failure according to its row policy |
| Restart storm | Repeated code `75` exits inside the restart window | Supervisor aborts and logs the storm guard decision |
| Bridge disconnect | Native bridge request fails or tunnel drops | Mobile app retries idempotent start/restart or surfaces a diagnostic failure |
| Background kill | Mobile OS suspends or kills the local agent | Foreground/resume revalidates health before claiming the agent is usable |
| OOM-like growth | Memory pressure rises before exit | Memory telemetry captures before/after RSS or the row is marked N/A with a time/hardware reason |

## Evidence Requirements Per Run

Every PR that claims a row is implemented must attach the following, or mark the
item N/A with the concrete blocker:

- Command transcript showing the exact build/test command.
- Backend or native logs showing the restart/crash path.
- Memory or process evidence when the row involves a local process.
- Domain artifact proving persisted state survived when persistence is part of
  the row contract.
- Screenshot or recording for mobile/desktop flows where the UI should recover.

Issue-scoped artifacts belong under `.github/issue-evidence/<issue#>-<slug>/`.
For mobile captures, rebuild and reinstall the current tree before collecting
screenshots, recordings, or logcat output.
