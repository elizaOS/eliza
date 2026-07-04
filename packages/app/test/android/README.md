# Android (and iOS) device e2e

Real-device end-to-end tests that drive the **actual app installed on an
emulator/simulator**, against the **real backend** — not desktop Chromium with
mocked `/api` (that is `playwright.ui-smoke.config.ts`). Two layers:

| Layer | What it proves | Driver |
|---|---|---|
| `mobile-local-chat-smoke.mjs` | On-device agent boots, smallest model loads, a real chat round-trips | adb + on-device agent API (`:31337`) |
| `onboarding-to-home.android.spec.ts` | Fresh Capacitor first-run onboarding selects a real remote host agent over `adb reverse`, completes first-run, and lands on the home/chat surface with screenshot + screenrecord artifacts | Playwright Android driver + deterministic host `startApiServer` |
| `native-plugin-view-smoke.android.spec.ts` | The installed app's WebView calls `ElizaSystem` through Capacitor and receives Android/Kotlin-only status + settings values, with JSON, screenshot, screenrecord, console, and logcat artifacts | Playwright Android driver + real Capacitor bridge |
| `touch-gesture.android.spec.ts` | The installed Android WebView runs the full chat gesture matrix — sheet detents, home↔launcher rail + back, push-to-talk hold, keyboard avoidance, media attachment, long-press — via real OS touch (`adb input`), asserting real touch delivery (never mouse) plus each gesture's semantics, recorded as one chunked screenrecord | Playwright Android driver + `adb shell input swipe` |
| `sleep-wake.android.spec.ts` | The installed app emits pause/resume lifecycle events across a real Android sleep/wake cycle, returns to the home shell, and remains interactive, with JSON, screenshot, screenrecord, and logcat artifacts | Playwright Android driver + adb power events |
| `ios-onboarding-smoke.mjs` | Fresh iOS Capacitor first-run onboarding selects the same real remote host agent, completes first-run, and lands on the home/chat surface with screenshot + video artifacts | `xcrun simctl` + in-WebView smoke request/result via Capacitor Preferences |
| `playwright.android.config.ts` (`test/android/*.android.spec.ts`) | Every route/feature renders on the real WebView against the live backend | Playwright Android driver (`_android`) over the WebView CDP socket |

The Playwright Android suite reuses the canonical route enumerations
(`DIRECT_ROUTE_CASES`, `MANAGER_VISIBLE_VIEW_TILE_CASES` from
`test/ui-smoke/apps-session-route-cases.ts`) so route coverage stays in lock-step
with the product.

## One-shot

```bash
bun run --cwd packages/app test:e2e:android
```

`scripts/android-e2e.mjs` orchestrates everything and **fails loudly** (non-zero
exit) on any of: emulator won't boot, app won't install, on-device agent won't
start, model won't download/run, a route won't render, cloud won't provision
(`--cloud`).

Focused slices:

```bash
# Fresh remote-connect onboarding through the Android deep-link path.
bun run --cwd packages/app test:e2e:android:onboarding

# Native Capacitor plugin x WebView smoke against host or local backend.
bun run --cwd packages/app test:e2e:android:native-plugin-view

# Full #10196 view-runtime telemetry soak against the real Android WebView.
bun run --cwd packages/app test:e2e:android:view-runtime-soak

# Real Android touch swipe on the chat grabber (#9943).
bun run --cwd packages/app test:e2e:android:touch-gesture

# #9943 sleep/wake lifecycle regression against the real Android WebView.
bun run --cwd packages/app test:e2e:android:sleep-wake

# Route-only/WebView-only pass when the local chat smoke is already done.
bun run --cwd packages/app test:e2e:android:routes
```

## Prerequisites (env)

- Android SDK with `adb`, `emulator`, and a system image. The harness resolves
  these cross-platform from `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `PATH`.
- A WebView-debuggable debug APK. Build it from the nested eliza checkout:

  ```bash
  ELIZA_MOBILE_REPO_ROOT=/home/example/eliza \
  ELIZA_WEBVIEW_DEBUG=1 \
  ELIZA_BUN_RISCV64_OPTIONAL=1 \
  bun run --cwd packages/app build:android
  # → packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk
  ```

  - `ELIZA_MOBILE_REPO_ROOT` pins repo-root resolution to the eliza checkout
    (else it walks up to the parent and builds the wrong app).
  - `ELIZA_WEBVIEW_DEBUG=1` flips `webContentsDebuggingEnabled` on so Playwright
    can attach to the WebView. Off for production/store builds.
  - `ELIZA_BUN_RISCV64_OPTIONAL=1` skips the (nonexistent) riscv64 Bun release.

## Hard-won environment facts

- **Emulator RAM.** The on-device agent (bun + a ~556MB GGUF) needs real
  headroom. A stock ≤2GB AVD OOM-kills the agent mid model-load. The harness
  boots emulators with **6GB** (`-memory 6144`); if you reuse an existing AVD,
  raise `hw.ramSize` to `6144M`.
- **SELinux.** On a stock emulator the app is `untrusted_app` and SELinux
  (enforcing) blocks the bun runtime's syscalls, so the agent never goes
  healthy. The harness runs `adb root` + `setenforce 0` on emulators
  (`ensureEmulatorPermissive`). Branded AOSP devices run the agent privileged and
  don't need this.
- **Local vs cloud onboarding.** The renderer reads runtime mode from WebView
  `localStorage` (separate from the native SharedPreferences that gate agent
  autostart). The fixtures seed `eliza:mobile-runtime-mode=local` +
  `elizaos:active-server={…,apiBase:"eliza-local-agent://ipc"}` so the WebView
  drives the on-device agent instead of falling into cloud onboarding.
- **Route navigation.** Capacitor's WebView has no SPA fallback for nested
  paths, so a hard `page.goto('/apps/x')` 404s. The harness navigates
  client-side via the History API (`gotoRoute`), like a user tap.
- **Smallest model.** `eliza-1-2b` (Q-quant, 128k ctx) — the smallest
  catalog tier. Node `fetch` chokes on HF's Xet LFS redirect; the orchestrator
  pre-caches via `curl`.

## Useful knobs

| Env / flag | Effect |
|---|---|
| `ANDROID_SERIAL` / `--serial` | Target a specific device (emulator preferred when several are attached) |
| `--build` | Build the APK before installing |
| `--skip-local-chat` | Skip the on-device agent/chat bring-up |
| `--skip-route-coverage` | Skip the Playwright WebView sweep |
| `--cloud` | Also run the real Hetzner provisioning probe |
| `--no-emulator-boot` | Use an already-running device, don't boot an AVD |
| `ELIZA_ANDROID_REQUIRE_AGENT=0` | Don't gate route coverage on local agent health (cloud/remote mode) |
| `ELIZA_EMULATOR_MEMORY_MB` / `ELIZA_EMULATOR_CORES` | Override emulator sizing |

## CI onboarding lane

`android-device-e2e.yml` now runs a load-bearing first-run lane before the
best-effort route sweep:

1. Start `packages/app-core/scripts/serve-real-local-agent.ts` on host
   `127.0.0.1:31337` with pairing disabled and deterministic model handlers.
2. Boot/install the WebView-debuggable APK on the Android emulator.
3. Run `test/android/onboarding-to-home.android.spec.ts` with
   `ELIZA_ANDROID_BACKEND=host`, so global setup wires `adb reverse
   tcp:31337 -> host:31337`.
4. The spec navigates the installed app to `/?reset`, taps through Remote
   onboarding, posts first-run to the real host agent, and asserts
   `home-launcher-surface[data-page="home"]` plus the chat composer.

Artifacts are written under
`packages/app/test-results/android-onboarding-to-home/`:
`home-landing.png`, `onboarding-to-home.mp4`, and `host-agent.log`.

## On-device agent: where it runs

The embedded agent (bun + llama) **runs on real arm64 hardware** (verified on a
Pixel 9a: `/api/health` → `ready:true` with 21 plugins, `/api/status` →
`running`). It does **not** run on a stock x86_64 emulator — bun SIGSEGVs there
even after SELinux-permissive + 6GB + AVX2 (an emulator/runtime incompatibility
the branded AOSP build avoids). So the on-device LOCAL route is validated on a
device runner; the smoke surfaces the emulator failure loudly.

## Known last gate: device pairing

With a healthy on-device agent, the WebView still gates the shell behind the
app's **device-pairing** screen ("Pairing Required — generate a code on the
server, paste it here"). For unattended e2e the agent should run with
`ELIZA_PAIRING_DISABLED=1` (skips `pairingEnabled()` in
`app-core/src/api/auth-pairing-routes.ts`), or the harness must complete the
`GET /api/auth/pair-code` → `POST /api/auth/pair` handshake and seed the
resulting session. Until then, route coverage needs a backend that's already
"connected" — a cloud-onboarded agent (`ELIZA_ANDROID_BACKEND` + a cloud token)
or pairing disabled in the test build. This is the one remaining wiring step to
fully-green on-device route coverage.

## Native plugin x WebView smoke

`native-plugin-view-smoke.android.spec.ts` uses the same real WebView fixture as
route coverage, but asserts a native bridge side effect instead of only render
safety. It calls `window.Capacitor.Plugins.ElizaSystem.getStatus()` and
`getDeviceSettings()` and requires values that the desktop Chromium web shim
cannot produce: `packageName === ai.elizaos.app`, Android role rows from
`RoleManager`, and the native-only `voiceCall` volume stream.

Artifacts are written under
`packages/app/test-results/android-native-plugin-view-smoke/`:
`native-plugin-result.json`, `native-plugin-device.png`,
`native-plugin-view-smoke.mp4`, `webview-console.log`, and `logcat.txt`.

## Chat gesture matrix (WebView)

`touch-gesture.android.spec.ts` is the full on-device chat gesture matrix
(#12344, parent #12188) — the successor to the single #9943 grabber-swipe smoke.
It attaches to the installed Android WebView, records DOM touch/pointer events,
and for each gesture dispatches OS-level `adb input` touch, asserting both that
the WebView saw real touch (`pointerType=mouse` stays absent) and the gesture's
own semantics:

- **Sheet detents** — grabber drag opens (`continuous-chat-overlay[data-open]`,
  `chat-sheet[data-detent]`) then collapses.
- **Rail pager** — home→launcher and launcher→home (`home-launcher-surface[data-page]`).
- **Push-to-talk** — a >200ms hold on `chat-composer-mic` arms dictation without
  latching the hands-free loop (mic aria-label never becomes "end conversation").
- **Keyboard avoidance** — tapping the composer raises the IME (`dumpsys
  input_method mInputShown=true`) and the composer stays within the visual
  viewport.
- **Media attachment** — the attach tap plus real `addImageFiles` intake shows a
  pending-image preview.
- **Long-press** — a held press on a sent message copies it / reveals its action
  row (skips honestly when no agent-backed bubble exists).

The whole run records through `startChunkedAndroidScreenRecord` (segments concat
with ffmpeg) so a >180s walkthrough is one file. Artifacts land under
`.github/issue-evidence/12344-android-gesture-matrix/`:
`android-gesture-matrix.mp4`, `gesture-*.png`, `android-gesture-matrix.json`,
and `logcat.txt`.

## iOS

iOS uses the same `mobile-local-chat-smoke.mjs` (simulator path via `xcrun
simctl`) and `scripts/ios-e2e.mjs`; run on a Mac (`xcrun` is macOS-only). The
WebKit WebView is not CDP-drivable like Android, so iOS route coverage is
screenshot + deep-link + backend-probe based rather than Playwright-driven.

`mobile-build-smoke.yml` also runs `scripts/ios-onboarding-smoke.mjs` after the
iOS Simulator `.app` build/stamp checks. The workflow starts the deterministic
host agent on `127.0.0.1:31337`, installs the freshly built simulator app, clears
Capacitor first-run Preferences, writes `eliza:ios-onboarding-smoke:request`,
and launches the app. The WebView then clicks the real Remote onboarding card,
fills the host-agent URL, submits first-run, and writes
`eliza:ios-onboarding-smoke:result` for the harness to poll. Artifacts land in
`packages/app/test-results/ios-onboarding-to-home/`: `fresh-onboarding.png`,
`home-landing.png`, `onboarding-to-home.mp4`, `result.json`, and
`host-agent.log`.
