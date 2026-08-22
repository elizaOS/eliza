# Linux parity and Devices & Runtimes status

Last updated: 2026-08-22 UTC

## Current state

This lane now provides a coherent Linux-native demo candidate with the same shared chat surface and compact bottom launcher used by the macOS app. The packaged Linux acceptance suite is green on this Debian host. It is not yet a generally distributable Linux release because its locally built inference libraries require glibc 2.43, above the enforced glibc 2.38 ceiling.

- Worktree: `/home/nubs/Documents/Codex/2026-08-22/eliza-linux-devices-runtimes`
- Branch: `codex/linux-devices-runtimes-20260822`
- Base: `origin/develop` at `c97833f1c53332af08d53bbf0cc029ec05d1bb42`
- Draft PR: [#24414](https://github.com/elizaOS/eliza/pull/24414)
- Publication boundary: the branch and draft PR are pushed for review. Nothing has been merged, deployed, or applied to cloud/production infrastructure.
- Preserved checkout: `/home/nubs/Documents/Codex/2026-08-14/eliza-voice-implementation-2/work/eliza` was not reset, cleaned, or used for edits.

## Delivered in this branch

- Reproducible Linux bootstrap with pinned Bun 1.3.14 and Node 24.15.0, archive checksums, frozen installation, and a strict capability doctor.
- Linux-native Electrobun packaging that selects only the native renderer and rejects wildcard RPC listeners or unsafe output permissions.
- A macOS-style bottom launcher pill that expands into the shared `ChatOverlay`, plus launcher, tray, hotkey, notification, and relaunch behavior.
- Devices & Runtimes UI, durable remote-target state, SSH enrollment/host-key handling, health/status display, and remote-command controls.
- Device-bound encrypted command envelopes, replay/expiry/fencing protection, receipt reconciliation, reconnect behavior, and relay cleanup.
- Direct pairing with secure keyring-backed persistence, reload restoration, bearer-auth recovery, and correct trust handling for the entire IPv4 `127.0.0.0/8` loopback range.
- Linux distribution gates that enforce the claimed glibc ceiling instead of silently shipping a host-specific build.

## Exact packaged candidate

- Path: `packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev`
- Product source commit: `27749d47995d96b16c9a095f03c8d819fe7af084`
- Size/inventory: 2.3 GiB; 127,628 files; zero symlinks.
- Renderer: `native` only; no packaged `libcef.so`.
- Renderer build ID: `8724935f56b63c77f6158cd588fa16a6f6763bc9f7ab0a556479f7cf48e09e58`
- Built: `2026-08-22T10:57:23.530Z`; variant `direct`; 1,058 renderer assets.
- Permissions: zero group/world-writable or setuid/setgid files.
- Cleanup: the packaged suite left no matching launcher, Playwright, Xvfb, or loopback-listener process behind.

Selected SHA-256 identities:

```text
9cce6bcdc1bc550b6533454a8470870cc321773890c0d1bd03d10d5f441bd9cd  bin/launcher
dc7c0cd922fce45f39e8f9e0eb40eb25f1df0b806cc9890b208292c3398ae9e9  Resources/main.js
c2f460fc6c0de108af6b46566dc5562e00050e4b77bc078852988b594794ea45  Resources/app/bun/index.js
dee764195b4ee18b646730a842640156b8064886071939d1574dcc79ca8a4a5e  Resources/app/renderer/index.html
40704c6f0fad4ac8215f9ce8dbcbafd4918533d0b3d39f68cdc0a92a4f858988  Resources/build.json
```

`Resources/build.json` records native-only rendering and embedded Bun 1.3.13. The repository build/test toolchain remains pinned to Bun 1.3.14; the embedded Bun version is controlled by the Electrobun dependency.

## Verification

### Current packaged acceptance

With auto-build disabled and the exact launcher above selected:

```bash
export PATH="$PWD/.cache/linux-dev-toolchain/bun-1.3.14-x64/bin:$PWD/.cache/linux-dev-toolchain/node-24.15.0-x64/bin:$PATH"
export ELIZA_TEST_PACKAGED_AUTO_BUILD=0
export ELIZA_TEST_PACKAGED_LAUNCHER_PATH="$PWD/packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev/bin/launcher"
bun run --cwd packages/app test:desktop:packaged
```

Result: **10 passed, 4 intentionally skipped, 0 failed in 4.3 minutes.** Green paths include:

- A 186-frame, 24.62-second real-time chat walkthrough MP4 with zero frame-capture failures.
- First-run onboarding persistence.
- Pairing-code redeem, secure persistence, process reload, and authenticated `/api/auth/me` recovery.
- Substantial native headless rendering, launcher-to-home navigation, and accessibility probing.
- Bottom pill placement, shared-chat expansion, keyboard toggle, and tray launcher.
- Native notifications, media/provider/plugin persistence across relaunch, shortcut bridge window summoning, and notification-store delivery.

The four skips are explicit platform or hardware/provider boundaries: live voice self-test, macOS/Windows application-menu reset, macOS tray/vibrancy, and a relaunch-helper case that currently recognizes only macOS/Windows launchers.

Additional current gates:

- First-run packaged spec: 2 passed, 0 failed.
- Focused pairing/trust tests: 3 files, 17 tests passed.
- UI TypeScript typecheck: passed.
- Biome checks over changed files: passed.
- CI Bun pin contract: 289 sites scanned; 65 contract tests passed.
- Earlier full branch suites: Electrobun 82 files with 620 passes and 15 intentional skips; app-core 2,175 tests passed; Linux remote-target suite 19 tests passed.
- Real local inference on this host: Vulkan ASR and OmniVoice TTS FFI execution passed. This is not physical microphone/speaker or live-provider proof.

Durable QA details and artifact paths are in `reports/linux-parity/packaged-qa.md`.

## Release gates still open

1. **Distribution portability:** the production-direct contract correctly fails. Eleven packaged local-inference libraries require `GLIBC_2.43`, above the supported `GLIBC_2.38` ceiling. The current artifact works on this Debian forky/sid host but must not be represented as broadly distributable.
2. **Installer lifecycle:** no `.deb`, `.rpm`, AppImage, Flatpak, clean install, upgrade, uninstall, or reinstall evidence was produced. Available disk headroom was not sufficient for another safe multi-GiB staging tree.
3. **Physical desktop QA:** Xvfb pixel and compositor-geometry checks are green, but GNOME/Wayland placement, tray integration, shortcuts, suspend/resume, and reboot persistence still require owner-visible hardware QA. Wayland did not permit reliable unattended global screenshots.
4. **Real devices/providers:** physical microphone/speaker, camera capture, live voice provider chain, second machine/Mac/VPS, WAN reconnect, and changed SSH-host-key confirmation remain separate evidence tiers.
5. **Hosted gates:** draft-PR CI must be green before review. Merge, release signing, publication, deployment, staging, and production remain approval-gated.

The native package contains no CEF runtime. Some native wrapper source/binary strings still mention historical CEF sandbox flags; absence of the CEF runtime is the supported claim, not absence of every CEF-related source string.

## Recovery

```bash
cd /home/nubs/Documents/Codex/2026-08-22/eliza-linux-devices-runtimes
git status --short --branch
git log --oneline --decorate origin/develop..HEAD
bun run linux:doctor
node packages/app-core/scripts/linux-distribution-contract.mjs \
  --build-dir=packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev \
  --claim=production-direct
```

The distribution command is expected to fail on this host-built candidate until the inference libraries are rebuilt against the supported glibc floor.
