# #10197 / #10203 — on-device agent crash → recovery (Android)

Closes the device-connected lane the stability scoreboard listed as *"code
present; device-connected run **gated on a phone**"*. This is that run: a real
crash injected on a connected Android instance, with the agent service asserted
to come back.

- **Device:** `sdk_gphone64_x86_64` / Android 14 (emulator-5556)
- **App:** `ai.elizaos.app`, `ElizaAgentService` (foreground service, `START_STICKY`, `WatchdogThread` health-poll + `scheduleRestart`)
- **Crash injection:** `adb shell kill -9 <agent-pid>` — an uncatchable kill that mimics an OS OOM-kill / native crash (harsher than a JS throw).

## Result — the agent recovers after every crash

| cycle | pid before | crash | pid after | OS restart backoff |
|---|---|---|---|---|
| 1 | 25702 | `kill -9` | 26402 (~2 s) | 1000 ms |
| 2 | 26402 | `kill -9` | 26692 (~4 s) | 4000 ms |
| 3 | 26692 | `kill -9` | 27017 (~16 s) | 16000 ms |

Every kill is followed by a fresh process hosting `ElizaAgentService` — the
agent comes back on its own. The restart delay **grows 1 s → 4 s → 16 s** under
repeated rapid crashes: Android's own crash-loop backoff, the OS-level analogue
of the host supervisor's `crash-loop-guard` lane — so a genuine crash recovers
fast while a tight crash-loop is throttled rather than spun.

## logcat (recovery trace)

```
ActivityManager: Process ai.elizaos.app (pid 25702) has died: fg TOP
ActivityManager: Scheduling restart of crashed service ai.elizaos.app/.ElizaAgentService in 1000ms for start-requested
ActivityManager: Start proc 26402:ai.elizaos.app/u0a192 for service {ai.elizaos.app/ai.elizaos.app.ElizaAgentService}
ActivityManager: Process ai.elizaos.app (pid 26402) has died: prcp FGS
ActivityManager: Scheduling restart of crashed service ai.elizaos.app/.ElizaAgentService in 4000ms for start-requested
ActivityManager: Start proc 26692:ai.elizaos.app/u0a192 for service {ai.elizaos.app/ai.elizaos.app.ElizaAgentService}
ActivityManager: Process ai.elizaos.app (pid 26692) has died: prcp FGS
ActivityManager: Scheduling restart of crashed service ai.elizaos.app/.ElizaAgentService in 16000ms for start-requested
ActivityManager: Start proc 27017:ai.elizaos.app/u0a192 for service {ai.elizaos.app/ai.elizaos.app.ElizaAgentService}
```

Screenrecord: `android-crash-recovery.mp4`.

## Companion: host stability suite (same run)

`node packages/app-core/scripts/stability-suite.mjs` → **all lanes pass** on this host:

- `supervisor-recovery` — induced 2 restarts (child exits `RESTART_EXIT_CODE` 75), recovered, latency 378 ms
- `crash-loop-guard` — aborts after 6 spawns (guard 5+1) instead of spinning
- `memory-soak` — steady slope −0.095 MB/iter vs leaking 3.815 MB/iter; steady peak RSS 111 MB

So both the **host supervisor** (exit-75 relaunch + crash-loop abort + leak-slope) and the **on-device Android service** (kill → `START_STICKY` restart with OS backoff) are now verified to recover from injected crashes — the two halves of #10197's "crash without recovery" gap that were runnable without a k8s cluster / iOS device.
