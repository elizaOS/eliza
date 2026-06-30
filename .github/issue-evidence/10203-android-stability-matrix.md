# #10203 — Android device-connected crash/restart stability matrix

The issue asks for a *crash/restart stability matrix* answering "Are Android
crash/restart/background paths actually exercised on connected devices?" — this
is that matrix, run on a connected Android instance (emulator-5556, Android 14,
`ai.elizaos.app`, `ElizaAgentService`). Each row injects a distinct lifecycle
failure and asserts the observed recovery, with the `adb`/logcat evidence.

| # | scenario | injection | expected | observed |
|---|---|---|---|---|
| 1 | **uncatchable crash** | `kill -9 <agent-pid>` ×3 | OS restarts the foreground service (`START_STICKY`) | recovered each time (pid 25702→26402→26692→27017), restart backoff 1s→4s→16s (OS crash-loop throttle) |
| 2 | **deliberate stop + cold relaunch** | `am force-stop` then `am start` | force-stop suppresses auto-restart; relaunch cold-starts cleanly | after force-stop: **no** zombie restart (correct); cold relaunch → new pid 31236 + WebView + `START_AGENT` service in ~2s, health endpoint live |
| 3 | **background + deep Doze** | `dumpsys deviceidle force-idle`, 12s | foreground service is Doze-exempt → survives | **survived**, stable pid 27017 before/during/after, `/api/health` answers after wake |

## Evidence (logcat)

```
# 1 — crash → START_STICKY recovery
ActivityManager: Process ai.elizaos.app (pid 25702) has died: fg TOP
ActivityManager: Scheduling restart of crashed service …/.ElizaAgentService in 1000ms for start-requested
ActivityManager: Start proc 26402:… for service {…ElizaAgentService}

# 2 — force-stop (no auto-restart) → cold relaunch
ActivityManager: Force stopping ai.elizaos.app … Killing 27017:… stop ai.elizaos.app
ActivityManager: Start proc 31236:… for next-top-activity {…MainActivity}
ActivityManager: Background started FGS: Allowed … intent START_AGENT cmp=…/.ElizaAgentService

# 3 — Doze survival
(stable pid 27017; CapacitorCookies: Getting cookies at 'http://127.0.0.1:31337/api/health' ×4 post-wake)
```

## What this closes vs. leaves

- **Closes (on a connected phone):** the Android crash → recover, deliberate-stop → cold-start, and background/Doze → survive paths the issue lists, complementing the host `stability-suite.mjs` (supervisor exit-75 relaunch + crash-loop-guard + memory-soak, all green this session).
- **Still gated:** iOS device/sim (no Linux sim) and cloud-pod chainsaw (k8s) — they need a Mac / a cluster.

Artifacts: `android-crash-recovery.{md,mp4}`, `10203-android-doze-survival.md`, `android-forcestop-coldstart.png`.
