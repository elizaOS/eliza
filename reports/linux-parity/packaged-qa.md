# Linux packaged/runtime QA — native demo candidate

Captured: 2026-08-22 UTC

Host: Debian forky/sid, x86-64, glibc 2.43, GNOME/Wayland. Automated packaged pixels used an isolated Xvfb X11 display.

Verdict: **green native demo candidate on this host; not yet a distributable Linux release.** The macOS-style bottom pill, shared chat, onboarding, pairing persistence, native bridges, and relaunch state all pass the broad packaged suite. The release gate remains closed because locally built inference libraries exceed the supported glibc ceiling and no installer lifecycle or physical-device matrix has been exercised.

## Identity and package inspection

- Branch: `codex/linux-devices-runtimes-20260822`
- Draft PR: [#24414](https://github.com/elizaOS/eliza/pull/24414)
- Exact product source commit: `27749d47995d96b16c9a095f03c8d819fe7af084`
- Artifact: `packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev`
- Renderer build ID: `8724935f56b63c77f6158cd588fa16a6f6763bc9f7ab0a556479f7cf48e09e58`
- Build time: `2026-08-22T10:57:23.530Z`; variant `direct`; 1,058 renderer assets.
- Manifest: native renderer only; no packaged `libcef.so`; embedded Bun 1.3.13.
- Inventory: 2.3 GiB, 127,628 files, zero symlinks.
- Permission scan: zero group/world-writable or setuid/setgid entries.
- Process cleanup: no matching packaged app, Playwright, Xvfb, or listener remained after the suite.

Selected SHA-256 identities:

```text
9cce6bcdc1bc550b6533454a8470870cc321773890c0d1bd03d10d5f441bd9cd  bin/launcher
dc7c0cd922fce45f39e8f9e0eb40eb25f1df0b806cc9890b208292c3398ae9e9  Resources/main.js
c2f460fc6c0de108af6b46566dc5562e00050e4b77bc078852988b594794ea45  Resources/app/bun/index.js
dee764195b4ee18b646730a842640156b8064886071939d1574dcc79ca8a4a5e  Resources/app/renderer/index.html
40704c6f0fad4ac8215f9ce8dbcbafd4918533d0b3d39f68cdc0a92a4f858988  Resources/build.json
```

## Broad packaged suite

Command:

```bash
export PATH="$PWD/.cache/linux-dev-toolchain/bun-1.3.14-x64/bin:$PWD/.cache/linux-dev-toolchain/node-24.15.0-x64/bin:$PATH"
export ELIZA_TEST_PACKAGED_AUTO_BUILD=0
export ELIZA_TEST_PACKAGED_LAUNCHER_PATH="$PWD/packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev/bin/launcher"
bun run --cwd packages/app test:desktop:packaged
```

Result: **10 passed, 4 skipped, 0 failed in 4.3 minutes.**

Passed behavior:

- The packaged app rendered substantial UI and passed a non-blank accessibility probe.
- The launcher and home surfaces opened through the native shell.
- The compact bottom pill was placed, toggled by keyboard, opened from the tray, and expanded into the shared `ChatOverlay` rather than a Linux-only imitation.
- The real-time walkthrough captured 186 frames over 24.62 seconds at 7.55 captured frames/second, with zero frame failures.
- First-run onboarding persisted.
- A pairing code was redeemed, written through secure storage, restored after process reload, and used for authenticated `/api/auth/me` access.
- Native notifications worked, and notification-store events reached the OS bridge.
- Media/provider/plugin state persisted across relaunch.
- The packaged shortcut bridge summoned the main window.

Intentional skips:

- Live voice self-test requires `ELIZA_VOICE_DESKTOP_SELFTEST=1`, real provider/API configuration, and distinct real capture/playback devices.
- Application-menu reset is a macOS/Windows behavior.
- Tray-vibrancy assertions are macOS-specific.
- One generic relaunch helper currently recognizes only macOS/Windows launcher forms.

## Durable visual evidence

- Chat walkthrough video: `packages/app/test-results/desktop-chat-walkthrough.e-0ac5b-ugh-records-a-real-time-MP4/desktop-chat-walkthrough.mp4`
- Walkthrough frames: the same directory under `walkthrough-frames/frame-000000.png` through `frame-000185.png`.
- Substantial native render: `packages/app/test-results/desktop-launch-render.e2e--6aa25-ers-substantial-UI-headless/desktop-launch-render.png`
- Launcher: `packages/app/test-results/desktop-launcher-smoke.e2e-1e992-ata-page-AX-probe-non-blank/desktop-launcher-launcher.png`
- Home: `packages/app/test-results/desktop-launcher-smoke.e2e-1e992-ata-page-AX-probe-non-blank/desktop-launcher-home.png`
- Bottom pill: `packages/app/test-results/electrobun-bottom-bar.e2e--ab6fc-ey-toggle-and-tray-launcher/bottom-launcher-pill.png`
- Expanded shared chat: `packages/app/test-results/electrobun-bottom-bar.e2e--ab6fc-ey-toggle-and-tray-launcher/expanded-shared-chat.png`
- Relaunch persistence: `packages/app/test-results/electrobun-packaged-regres-56127-lugin-state-across-relaunch/persistence-before-relaunch.png`, `persistence-settings-after-relaunch.png`, and `persistence-plugins-after-relaunch.png`.

These are Xvfb-rendered package pixels. They are valid automated native-shell evidence, but they do not substitute for owner-visible GNOME/Wayland placement, tray, animation, and monitor-scale inspection.

## Closure of the original failures

| Earlier failure | Current resolution |
| --- | --- |
| Walkthrough could not find the home pill | The launcher now uses the shared chat surface; the full 186-frame walkthrough passes. |
| Onboarding flow was displaced by permission priming | The harness and product sequencing now complete and persist first-run onboarding. |
| Pairing did not reach authenticated state | Pairing status setters, durable target persistence, secure-store environment preservation, and IPv4 `127/8` trust restoration now pass through reload. |
| Headless bottom bar reported unusable geometry | The native placement contract and packaged geometry assertion now pass; physical Wayland placement remains a separate gate. |
| Shortcut expected a late test seed instead of the registered production value | The bridge test now follows the real startup lifecycle and successfully summons the window. |

## Pairing and security observations

The pairing flow now treats `/api/auth/status` as the authoritative unauthenticated/pairing signal, redeems the code, persists the secret through the desktop keyring path, reloads the package, and verifies authenticated access. The packaged harness preserves only `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` from the user session so Linux secure storage can be reached without broadly inheriting the environment.

The runtime URL trust gate recognizes the complete IPv4 loopback range (`127.0.0.0/8`), not only `127.0.0.1`, so valid paired loopback targets survive startup restoration without weakening non-loopback trust checks.

The artifact uses no CEF runtime. Historical CEF-related strings remain in source/native-wrapper payloads, so this report claims native-only execution and absence of packaged `libcef.so`, not absence of every CEF word or sandbox-flag string.

## Distribution contract

Command:

```bash
node packages/app-core/scripts/linux-distribution-contract.mjs \
  --build-dir=packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev \
  --claim=production-direct
```

Expected current result: **failure**. Eleven fused local-inference libraries require `GLIBC_2.43` while the production-direct ceiling is `GLIBC_2.38`:

- `libelizainference.so`
- `libggml-base.so` and `.so.0`
- `libggml-cpu.so` and `.so.0`
- `libggml-vulkan.so` and `.so.0`
- `libllama.so` and `.so.0`
- `libmtmd.so` and `.so.0`

This is a correct fail-closed release gate. The current package is suitable for a controlled demo on the verified Debian forky/sid host, not for a broad Linux release claim.

## Evidence boundary

Still required for release-level confidence:

- Build the fused inference stack against the supported glibc floor, then repeat the complete package and dependency audit.
- Produce and test supported installable formats through clean install, upgrade, uninstall, and reinstall.
- Inspect the physical GNOME/Wayland pill, tray, shortcuts, animation, multiple scales/monitors, suspend/resume, and reboot persistence.
- Exercise physical microphone/speaker and camera devices plus a live voice provider chain.
- Exercise a second Linux/Mac/VPS target, WAN disconnect/reconnect, and changed SSH-host-key confirmation with user-controlled identities.
- Obtain green hosted CI and review; merge, signing, release publication, deployment, and production remain separate approvals.
