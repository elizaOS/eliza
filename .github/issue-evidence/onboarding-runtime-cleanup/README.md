# Onboarding cleanup + runtime hardening — on-device evidence

Captured on a real **Pixel 6a (Android 16)**, debug APK from this branch
(`run-mobile-build.mjs android`, artifact-audit-passed), installed via
`adb install -r` (freshness confirmed via `lastUpdateTime`).

| File | Shows |
|------|-------|
| `01-clean-two-option-chooser.png` | The clean chooser — **Eliza Cloud (managed)** + **On this device** only (no "Bring your own keys"), prominent full-width rows with `›` chevrons + the directive frozen-composer hint. |
| `02-friendly-cloud-error.png` | Tapping Cloud while the device is offline now shows **"Couldn't reach Eliza Cloud — check your internet connection and try again."** instead of the raw `Unable to resolve host "api.elizacloud.ai"` — and re-offers the choice (recoverable). |
| `03-sheet-auto-opens.png` | Onboarding boots with the sheet **open** (greeting + options visible without a manual swipe) — before the fix it settled collapsed with the options hidden behind the grabber. |

Device WiFi was disconnected throughout, which is why the cloud connect fails —
that is exactly the transport-failure path fix #1 makes graceful.

Tests: 66/66 across the 6 touched suites; ui typecheck 0 errors; biome clean.
