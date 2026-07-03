# #12185 sub-issue 4 — Android assistant role (VoiceInteractionService)

Evidence that Eliza is now a first-class Android **digital assistant** (`ROLE_ASSISTANT`
holder via a real `VoiceInteractionService`), captured on `emulator-5584`
(Android 15 / API 35, Pixel-class AVD).

## Files

| File | What it proves |
|---|---|
| `01-assist-settings-eliza.png` | Settings → **Digital assistant app** shows **"Default digital assistant app — Eliza"** with the Eliza logo and the assist-context toggles (Use text from screen / Use screenshot) enabled. Eliza is the *selected* system assistant — only possible if the new VIS makes it a valid candidate. |
| `03-assist-invocation-logcat.txt` | Secure settings (`voice_interaction_service = ai.elizaos.app/.ElizaVoiceInteractionService`), the role-framework accepting Eliza, and the logcat trace: session shown → hand-off (`elizaos://voice?source=android-assistant-session`) → the deep link **landing in `ai.elizaos.app/.MainActivity`**. |

## How it was verified

1. `assembleDebug` of `packages/app-core/platforms/android` compiled cleanly with the new
   Java (`ElizaVoiceInteractionService`, `…SessionService`, `…Session`, `ElizaRecognitionService`),
   resources, and manifest; `aapt2 dump xmltree` confirmed all three services + the
   `android.voice_interaction` metadata + `BIND_VOICE_INTERACTION` in the packaged APK.
2. `adb install -r`, then `cmd role add-role-holder android.app.role.ASSISTANT ai.elizaos.app`
   **succeeded** — the role framework only accepts packages that qualify as an assistant
   (valid VoiceInteractionService or ACTION_ASSIST activity). Holder flipped
   `com.google.android.googlequicksearchbox` → `ai.elizaos.app`.
3. `cmd voiceinteraction show` invoked the active VIS → the session rendered the voice bar and
   handed off; the deep link landed in `MainActivity` (see `03`).

## Role-reset-on-reinstall gotcha (dossier source [15])

On `adb install -r` (dev loop) the platform can clear the `assistant` /
`voice_interaction_service` Secure Settings, so Eliza must be **re-selected** as the digital
assistant after each reinstall — Settings → Apps → Default apps → Digital assistant app, or
`adb shell cmd role add-role-holder --user 0 android.app.role.ASSISTANT ai.elizaos.app`. This
also affects the shipping app on sideload/dev loops; it is a platform behavior, not a regression.

## Caveat on the APK used

The APK here is a **compile-verification build** (`ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1`, no web
renderer bundle, no on-device inference lib) because the isolated worktree lacks the staged
`jniLibs`/web assets. It proves the whole sub-issue-4 native surface (VIS is the active
assistant, session fires, deep link lands). Because it has no renderer, `MainActivity` ANRs
after the hand-off ("Eliza isn't responding") — expected for this build; a full
`bun run build:android` APK ships the renderer + engine and lands on the voice UI.
