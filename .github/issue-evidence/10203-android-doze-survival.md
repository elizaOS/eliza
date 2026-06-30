# #10203 / #9943 — on-device agent survives background + Android Doze

Companion to the crash→recovery evidence (`10197-android-crash-recovery.md`).
Where that proves the agent *comes back* after a kill, this proves it *stays
alive* across the background/foreground + deep-idle path #10203 calls out
("background/foreground behavior") and #9943 flags ("on-device/sleep-wake never
gates a PR").

- **Device:** `sdk_gphone64_x86_64` / Android 14 (emulator-5556), `ai.elizaos.app`

## Sequence

1. agent running — pid **27017**
2. background the app (`HOME`)
3. force **Android deep Doze**: `dumpsys deviceidle force-idle` → `doze state: IDLE` ("Now forced in to deep idle mode"), battery unplugged
4. hold 12 s in doze
5. wake: `deviceidle unforce` + battery reset + foreground the app

## Result — SURVIVED (same process throughout)

| checkpoint | agent pid |
|---|---|
| before doze | 27017 |
| during deep-idle | 27017 |
| after wake | 27017 |

The `ElizaAgentService` foreground service is exempt from Doze (by design), so
the agent process is **not** killed across the sleep/wake cycle — pid is stable
end-to-end. After wake, the renderer's health poll resumes and the agent answers:

```
Capacitor: callback …, pluginId: Agent, methodName: request, path: /api/health  (Bearer …, 5000ms)
CapacitorCookies: Getting cookies at: 'http://127.0.0.1:31337/api/health'   (×4, post-wake)
```

i.e. the agent's HTTP health endpoint is live and answering after the doze cycle
— the `WatchdogThread` health-poll path is exercised on a connected device.

Together with the crash→recovery cycles, the two Android device-connected
stability paths #10203 asks about — **crash (recover)** and **background/doze
(survive)** — are now both exercised on a connected device with evidence.
