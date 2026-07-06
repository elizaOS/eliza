# @elizaos/capacitor-system

A Capacitor plugin that bridges Android system-role status and device-settings control into the elizaOS mobile runtime.

## Purpose / Role

Exposes Android system capabilities — role status (home, dialer, SMS, assistant), screen brightness, and audio-volume control — to TypeScript code running inside a Capacitor-based Eliza agent on Android. On web/browser it provides fallback implementations that either return empty data or throw descriptive errors. This package is a Capacitor plugin, not an elizaOS plugin that registers actions/services with `AgentRuntime`; it is consumed by higher-level elizaOS packages that need native Android access.

## Plugin Surface

This is a **Capacitor plugin**, not an elizaOS runtime plugin. It does not register actions, providers, evaluators, services, or routes with `AgentRuntime`. It exposes one Capacitor plugin object:

| Export | Description |
|--------|-------------|
| `System` | Registered as `"ElizaSystem"` via `registerPlugin`. Import from `@elizaos/capacitor-system`. |

### `System` methods (all return Promises)

| Method | Platform | Description |
|--------|----------|-------------|
| `getStatus()` | Android + web | Package name + role-status array (home, dialer, sms, assistant). Web always returns empty roles. |
| `requestRole({ role })` | Android only | Launches system role-request dialog. Requires Android 10+. |
| `openSettings()` | Android only | Opens main system Settings activity. |
| `openNetworkSettings()` | Android only | Opens Wi-Fi settings. |
| `openWriteSettings()` | Android only | Opens WRITE_SETTINGS permission screen for the app. |
| `openDisplaySettings()` | Android only | Opens display settings. |
| `openSoundSettings()` | Android only | Opens sound/volume settings. |
| `getDeviceSettings()` | Android + web | Brightness (0–1), brightness mode, WRITE_SETTINGS permission flag, and volume levels for all streams. Web returns static fallback values. |
| `setScreenBrightness({ brightness })` | Android only | Sets system brightness (0–1). Requires WRITE_SETTINGS permission. |
| `setVolume({ stream, volume, showUi? })` | Android only | Sets volume for a named audio stream. |

### Exported types (from `src/definitions.ts`)

- `AndroidRoleName` — `"home" | "dialer" | "sms" | "assistant"`
- `AndroidRoleStatus` — per-role status object (`role`, `androidRole`, `held`, `holders`, `available`)
- `SystemStatus` — `{ packageName, roles: AndroidRoleStatus[] }`
- `AndroidRoleRequestResult` — `{ role, held, resultCode }`
- `SystemVolumeStream` — `"music" | "ring" | "alarm" | "notification" | "system" | "voiceCall"`
- `SystemVolumeStatus` — `{ stream, current, max }`
- `DeviceSettingsStatus` — `{ brightness, brightnessMode, canWriteSettings, volumes }`
- `SystemPlugin` — interface implemented by both native and web layers

## Layout

```
plugins/plugin-native-system/
  src/
    index.ts          Entry point; calls registerPlugin("ElizaSystem") and re-exports definitions
    definitions.ts    All TypeScript types and the SystemPlugin interface
    web.ts            Web fallback (SystemWeb extends WebPlugin); returns fallback data or throws
    web.test.ts       Vitest unit tests for the web fallback layer
  android/
    src/main/
      AndroidManifest.xml                        Declares MODIFY_AUDIO_SETTINGS + WRITE_SETTINGS
      java/ai/eliza/plugins/system/
        SystemPlugin.kt                          Native Android implementation (Kotlin)
    build.gradle                                 Android library build config
  rollup.config.mjs   Bundles dist/esm -> IIFE + CJS for web runtime
  tsconfig.json
  package.json
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-system clean           # remove build output
bun run --cwd plugins/plugin-native-system build           # build package artifacts
bun run --cwd plugins/plugin-native-system typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-system lint            # mutating Biome check
bun run --cwd plugins/plugin-native-system lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-system format          # write formatting
bun run --cwd plugins/plugin-native-system format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-system test            # run package tests
bun run --cwd plugins/plugin-native-system prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-system build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / Env Vars

No environment variables. No elizaOS config keys. The plugin has no runtime configuration; behavior is determined entirely by the Android platform and granted permissions.

Android permissions declared in `AndroidManifest.xml` (merged into the host app):
- `android.permission.MODIFY_AUDIO_SETTINGS` — required for `setVolume`
- `android.permission.WRITE_SETTINGS` — required for `setScreenBrightness`; user must grant via Settings on Android 6+

`setScreenBrightness` additionally requires `WRITE_SETTINGS` to be granted at runtime (checked via `Settings.System.canWrite`). Call `openWriteSettings()` first to direct the user to the permission screen.

`requestRole` requires Android 10 (API 29+). On older devices it rejects with an error.

## How to Extend

### Add a new plugin method

1. Add the method signature to `SystemPlugin` in `src/definitions.ts`.
2. Add a web fallback in `src/web.ts` (`SystemWeb` class) — throw a descriptive error or return a safe default.
3. Add the `@PluginMethod` implementation in `android/src/main/java/ai/eliza/plugins/system/SystemPlugin.kt`.
4. If the method requires a new Android permission, add a `<uses-permission>` entry to `android/src/main/AndroidManifest.xml`.
5. Run `bun run --cwd plugins/plugin-native-system build` to verify TypeScript compilation.

### Add a new Capacitor event

Use `notifyListeners("eventName", data)` in the Kotlin plugin and `System.addListener("eventName", handler)` on the JS side. Add the listener type to `SystemPlugin` in `definitions.ts`.

## Conventions / Gotchas

- **Plugin name is `"ElizaSystem"`** — this string must match `@CapacitorPlugin(name = "ElizaSystem")` in Kotlin and the first arg to `registerPlugin` in `src/index.ts`. Mismatches silently fall back to the web implementation.
- **Capacitor, not elizaOS runtime** — `System` is imported and called directly in TypeScript; it does not participate in `AgentRuntime` plugin registration. Do not confuse with elizaOS action/provider/service plugin objects.
- **Android-only methods throw on web** — all settings-open and write methods throw `Error` in `SystemWeb`. Guard call sites with platform checks or catch the error.
- **WRITE_SETTINGS is a special permission** — it cannot be requested via `requestPermissions`; the user must be redirected to `openWriteSettings()`. Check `canWriteSettings` in the `DeviceSettingsStatus` response before calling `setScreenBrightness`.
- **Role queries require Android 10+** — `getStatus()` returns an empty `roles` array on Android < 10 (it does not reject). `requestRole()` rejects on Android < 10.
- **Build output** — `dist/esm/` is produced by `tsc`, then Rollup bundles it to `dist/plugin.js` (IIFE) and `dist/plugin.cjs.js` (CJS). The Android AAR is built separately by Gradle inside the host Capacitor project.
- **Test suite** — `src/web.test.ts` contains Vitest unit tests for the web fallback layer (`bun run --cwd plugins/plugin-native-system test`). The Android Kotlin device reads are covered by an **instrumented test**, `android/src/androidTest/.../SystemDeviceReaderInstrumentedTest.kt`, run on a real device/emulator via `./gradlew :elizaos-capacitor-system:connectedDebugAndroidTest` from `packages/app-core/platforms/android` (issue #9967). The reads live in `SystemDeviceReader` precisely so they are exercisable without a Capacitor `Bridge`/WebView; `SystemPlugin` delegates to it and marshals the result into the unchanged JS shape.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
