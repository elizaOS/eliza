# Android (and iOS) device e2e

Real-device end-to-end tests that drive the **actual app installed on an
emulator/simulator**, against the **real backend** — not desktop Chromium with
mocked `/api` (that is `playwright.ui-smoke.config.ts`). Two layers:

| Layer | What it proves | Driver |
|---|---|---|
| `mobile-local-chat-smoke.mjs` | On-device agent boots, smallest model loads, a real chat round-trips | adb + on-device agent API (`:31337`) |
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

## Prerequisites (env)

- Android SDK with `adb`, `emulator`, and a system image. The harness resolves
  these cross-platform from `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `PATH`.
- A WebView-debuggable debug APK. Build it from the nested eliza checkout:

  ```bash
  ELIZA_MOBILE_REPO_ROOT=/home/shaw/milady/eliza \
  ELIZA_WEBVIEW_DEBUG=1 \
  ELIZA_BUN_RISCV64_OPTIONAL=1 \
  ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 \
  bun run --cwd packages/app build:android
  # → packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk
  ```

  - `ELIZA_MOBILE_REPO_ROOT` pins repo-root resolution to the eliza checkout
    (else it walks up to the milady parent and builds the wrong app).
  - `ELIZA_WEBVIEW_DEBUG=1` flips `webContentsDebuggingEnabled` on so Playwright
    can attach to the WebView. Off for production/store builds.
  - `ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1` skips the arm64 MTP/vulkan llama lib
    (a real-device optimization irrelevant to an x86_64 emulator; the standard
    `libllama-cpp-x86_64.so` runs there).
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
- **Smallest model.** `eliza-1-0_8b` (Q-quant, 32k ctx, ~556MB) — the smallest
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

## iOS

iOS uses the same `mobile-local-chat-smoke.mjs` (simulator path via `xcrun
simctl`) and `scripts/ios-e2e.mjs`; run on a Mac (`xcrun` is macOS-only). The
WebKit WebView is not CDP-drivable like Android, so iOS route coverage is
screenshot + deep-link + backend-probe based rather than Playwright-driven.
