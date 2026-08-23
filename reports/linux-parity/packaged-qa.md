# Linux packaged/runtime QA — CEF demo candidate

Captured: 2026-08-23 UTC

Host: Debian forky/sid, x86-64, glibc 2.43, GNOME/Wayland. Automated packaged
pixels used an isolated Xvfb X11 display.

Verdict: **green local CEF demo/review candidate on this host; not a production
release claim.** The shared macOS-style pill and chat surface, onboarding,
pairing, native bridges, CEF profile persistence, shutdown flushing, and
real-process relaunch all pass. The direct payload also passes its GLIBC and
distribution contract. Physical desktop/hardware, second-device, live-service,
installer lifecycle, signing, and publication evidence remain separate gates.

The final Linux doctor reports 35 passes, five optional warnings, and one
required host-capacity failure: 4.3 GiB free versus the 8 GiB fresh desktop
build floor. Existing artifacts are unaffected; another rebuild needs explicit
cleanup approval or another build filesystem.

## Identity and package inspection

- Branch at build time: `codex/linux-devices-runtimes-20260822`
- Product source commit: `be05b667e76b7c8f5266667bfc33f35125b75faf`
- Packaging/tooling checkpoint: `02c00a3902a35732d7cb134f98570b9d349bdbfc`
- Artifact tree: `packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev`
- Renderer build ID: `246bdd070f40c9f3db17f22a40f032cb787f1d444b277b4ffac043a7b0de51db`
- Build time: `2026-08-23T02:50:53.651Z`; variant `direct`; 1,079 renderer assets.
- Manifest: default CEF renderer, native renderer also available, CEF 147.0.10,
  embedded Bun 1.3.13.
- Inventory: 3,230,715,904 allocated bytes; 151,736 entries; five intentional
  relative CEF-library symlinks.
- Permission scan: zero group/world-writable or setuid/setgid regular files.
- ABI: 78 ELF files; maximum `GLIBC_2.38`, at the supported ceiling.

Selected SHA-256 identities:

```text
9cce6bcdc1bc550b6533454a8470870cc321773890c0d1bd03d10d5f441bd9cd  bin/launcher
40ba72d0cc6e38d04cd2ea29a650f5b3976673b2facb09fedae003b26bfdc971  bin/libNativeWrapper.so
dc7c0cd922fce45f39e8f9e0eb40eb25f1df0b806cc9890b208292c3398ae9e9  Resources/main.js
2bde89501be609ff6bbcd67fb366300ca1641cc53cc4ac724c46d422995fb83d  Resources/app/bun/index.js
c262b0eadb3e4c31527ab0420bdfa1e199505fb837c8a1ef0113b1143c37eb4b  Resources/app/renderer/index.html
b40e35df512ed9570fbdb47c3c9a45745528b85b8bc135d51dff5adb81135359  Resources/build.json
```

## Broad packaged suite

Command:

```bash
export PATH="$PWD/.cache/linux-dev-toolchain/bun-1.3.14-x64/bin:$PWD/.cache/linux-dev-toolchain/node-24.15.0-x64/bin:$PATH"
export ELIZA_TEST_PACKAGED_AUTO_BUILD=0
export ELIZA_TEST_PACKAGED_LAUNCHER_PATH="$PWD/packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev/bin/launcher"
bun run --cwd packages/app test:desktop:packaged
```

Result: **10 passed, 4 skipped, 0 failed in 3.8 minutes.**

Passed behavior:

- Substantial non-blank UI rendered through the packaged CEF shell.
- The launcher/home surfaces opened and the compact bottom pill toggled through
  keyboard and tray paths, expanding the shared `ChatOverlay`.
- The real-time walkthrough recorded 148 frames over 24.47 seconds with zero
  capture failures.
- First-run onboarding and pairing authentication completed.
- Native OS notifications passed both direct bridge and notification-store
  paths.
- Media, provider, and plugin state survived a zero-delay real-process
  relaunch.
- The packaged shortcut bridge summoned the main window.

Intentional skips:

- Live voice requires explicit real provider/API, capture, and playback device
  configuration.
- Application-menu reset and tray-vibrancy checks are macOS/Windows-specific.
- The generic relaunch menu helper currently recognizes macOS/Windows launchers;
  Linux relaunch persistence is covered by the dedicated regression path.

These are Xvfb-rendered package pixels. They do not substitute for owner-visible
GNOME/Wayland placement, animation, tray, scaling, or monitor inspection.

## CEF persistence closure

The original Linux persistence failure had two native causes:

1. CEF's Chrome runtime rejected nested request-context cache paths. The pinned
   wrapper now uses a non-empty global `CEF/Default` root and direct
   `CEF/Partition-<sha256>` named profiles.
2. Electrobun stopped the CEF loop while browsers were still live and then
   called `CefShutdown`, allowing queued storage writes to disappear. Shutdown
   now closes all browsers, continues pumping CEF until `OnBeforeClose`, then
   exits GTK and calls `CefShutdown`.

Electrobun 1.18.1's `BrowserWindow` entrypoint also dropped its `partition`
option. The fail-closed patch script now forwards that option and verifies exact
upstream/patched hashes. The Linux shell uses one explicit partitioned window,
avoiding a race with an implicit unpartitioned bootstrap view.

Evidence:

- Focused packaged regression suite: three Linux cases passed, two platform
  cases skipped, zero failures.
- The persistence case passed three consecutive `--repeat-each=3` launches.
- The broad fresh-build run above independently passed the same real-process
  relaunch case.
- Profile inspection found the persisted keys in the requested partition while
  the default profile remained empty.
- Native review patch applies cleanly to pristine Electrobun v1.18.1.

## Devices & Runtimes closure

The same-host integration suite instantiates the real
`DesktopRemoteTargetService` and `RemoteTargetVault` with faithful injected
secret-store and relay boundaries. It uses the atomic journal, real P-256
signatures and ECDH/HKDF/AES-GCM envelopes, and authenticated loopback. It
recreates the service mid-session, resumes the command, proves one acknowledged
command dispatch, revokes the host, then proves a later restart cannot restore
authority.

Together with the remote runner and main-window session suites, the focused
result is **33 passed, 0 failed**. This remains same-host process/runtime proof,
not live Linux Secret Service, deployed Cloud/PGlite, WAN, or a physical second
machine.

## Distribution boundary

Command:

```bash
node packages/app-core/scripts/linux-distribution-contract.mjs \
  --build-dir=packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev \
  --claim=production-direct
```

Result: **pass** at 78 ELF files and maximum `GLIBC_2.38`.

The result is deliberately narrower than a sandboxed production claim. The
pinned Electrobun wrapper contains the audited `no-sandbox` and
`disable-gpu-sandbox` switches, and the bundled `chrome-sandbox` lacks setuid
root capability. Direct `.deb` and AppImage candidates therefore do not claim
Chromium renderer-process sandboxing. The side-load Flatpak contract supplies
an outer application sandbox; it does not change the inner Chromium fact.

## Packaging

- Direct and Flatpak packaging tests: **31 passed, 0 failed** after adding
  nested Electrobun app discovery and ambiguity rejection.
- Debian artifact: 474,119,096 bytes, SHA-256
  `78dfe3cf76faab4660fa6ae010830791e20e258416ad6d9e7f771623abcbe04d`;
  all 151,736 archive entries are root-owned, and extracted hashes/contract
  match the frozen payload.
- AppImage: 596,452,544 bytes, SHA-256
  `fe5d211740317f048afe110be82b70a7997bd47ca95b58f6b336b2b5dd8ef27d`;
  AppStream validation passed with one optional pedantic release-history note;
  extracted hashes/contract passed and exact `AppRun` rendered UI (1/1).
- Flatpak: 454,183,528 bytes, SHA-256
  `6e70dcaf7f4d33ed1d3250ae84c1ccb35e5327a28c8a5e8af49c724ce653e78d`.
  An isolated no-deploy import passed at OSTree commit `4e92aac93f1a0ecd34925c5db56b7d5d53bf0534a30332a3ae55e27bda4d5838`
  with GNOME Platform 50, Freedesktop SDK 25.08, and only IPC/network,
  fallback-X11/Wayland/PulseAudio, and DRI permissions.
- RPM is not built because `rpmbuild` is absent and installing system tooling
  was not authorized.

## Evidence boundary

Still required for release-level confidence:

- Inspect and exercise the physical GNOME/Wayland pill, tray, shortcut,
  notifications, scales/monitors, suspend/resume, and reboot persistence.
- Exercise microphone, speaker, camera, and a live provider chain.
- Exercise a second Mac/VPS target, WAN reconnect, changed SSH host keys,
  restart recovery, and revocation with user-controlled identities.
- Exercise real Linux Secret Service and deployed Cloud/PGlite relay state.
- Perform owner-approved clean install, upgrade, uninstall, and reinstall.
- Build and inspect RPM in an approved build environment.
- Restore at least 8 GiB of root-filesystem build capacity through approved,
  target-specific cleanup or another build filesystem.
- Obtain review and hosted CI; push, PR creation, signing, publication, merge,
  deployment, and production mutation remain explicit approval actions.
