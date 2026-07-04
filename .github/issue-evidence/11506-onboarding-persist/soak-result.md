# #11506 — On-device startup-reliability soak (Pixel 6a, VERIFIED)

Build: develop `app-debug.apk` (600 MB) carrying **#11738** (FGS `START_NOT_STICKY` after LMK) + **#11713** (bionic-host JNI guard) + the full voice/inference stack. Captured 2026-07-03 on the attached Pixel 6a (Tensor GS101, 5.7 GB RAM), local mode. Agent driven through the in-app API over `adb forward tcp:31337`.

## 1. Onboarding persistence — FIXED (the core #11506 symptom)

`GET /api/first-run/status` was `{"complete":false}` on the fresh install. Completed onboarding via `POST /api/first-run` (local runtime) → `{"complete":true}`. Then **3 force-stop + relaunch cycles**:

| cycle | boot→agent-ready | pid | first-run status |
|---|---|---|---|
| 1 | 25.3 s | 31161 | `{"complete":true}` |
| 2 | 23.8 s | 31572 | `{"complete":true}` |
| 3 | 23.9 s | 31999 | `{"complete":true}` |

Onboarding **persisted across every restart** (and across the spontaneous restart in §2). The primary symptom — "onboarding never persists" — is resolved. This confirms the code analysis: with the process stabilized, `config.meta.firstRunComplete` durably re-reads from disk at boot.

## 2. Process stability — crash-loop FIXED (#11738 verified)

10-min pid-stability soak, sampled every 20 s, **no interference** (this is the pre-#11738 "restarts every ~1-2 min" symptom):

- pid **31999 stable for ~6.7 min continuously** (0 → ~400 s), then one restart → pid **1995**, then stable again (3.4+ min continuous to end).
- **`PID_CHANGES = 1` over ~8 min** — versus the pre-fix ~4–8 restarts in the same window.

The single restart was **not** a crash-loop and **not** an LMK memory kill. ActivityManager logged its cause explicitly:

```
03:36:13.842 ActivityManager: Killing 31999:ai.elizaos.app (adj 50): stop ai.elizaos.app due to installPackageLI
03:36:14.098 ActivityManager: Start proc 1995:ai.elizaos.app for broadcast {WebsiteBlockerBootReceiver}
03:36:23.511 ActivityManager: Background started FGS: Allowed [... reasonCode:PACKAGE_REPLACED ...]
```

`installPackageLI` = a package-manager operation (a deferred post-sideload dexopt of the freshly-installed debug APK), and the FGS restart was **Allowed** via the `PACKAGE_REPLACED` temp-allowlist — exactly the graceful path, not the `ForegroundServiceStartNotAllowedException` crash-loop #11738 fixed. **Zero crash-loop restarts and zero FGS-denied restarts** were observed.

## 3. Boot duration — works, but slow (follow-up, not #11506)

- Cold boot (process start → `/api/status` 200): **35.7 s**.
- Warm restarts: **~24 s**.

The agent is `running` / `canRespond:true` at ready. The 24–36 s is dominated by **agent-runtime init** (69 MB bundle eval + PGlite DB init), not the JS first-paint that the merged boot-speed PR (#11874, three.js off the boot graph) addresses. Shrinking this is a separate optimization (lazy runtime init / bundle-eval speedups) tracked under the boot/#10724 umbrella — out of #11506's scope.

## Verdict

#11506's two symptoms are resolved on-device: the crash-loop is gone (#11738) and onboarding persists across restarts. The one restart seen was an OS package-op, gracefully handled. Boot-duration is a real but separate optimization.
