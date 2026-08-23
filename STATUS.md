# Linux parity and Devices & Runtimes status

Last updated: 2026-08-23 UTC

## Outcome

The independently actionable local engineering work is complete for the x64
candidate. Linux now uses the shared macOS-style compact launcher pill and chat
surface, a CEF 147 Electrobun shell with durable partitioned profiles, secure
Devices & Runtimes flows, portable local inference, and reproducible direct
packages. The exact package payload passes the `production-direct` contract
and its broad packaged acceptance suite.

This is a **local demo/review candidate, not a production release claim**.
Physical GNOME/Wayland and hardware QA, a second Mac/VPS runtime, real Secret
Service and deployed-Cloud proof, system installer lifecycle, RPM tooling,
review, signing, publication, merge, and deployment remain environment,
credential, physical-device, or authority gates.

The final doctor also records a host-capacity gate: 4.3 GiB is free on the root
filesystem versus the 8 GiB required for another desktop rebuild. The completed
artifacts launch from their current locations, but a fresh rebuild requires
owner-approved cleanup of generated outputs or caches. No unrelated cache or
workspace data was deleted to manufacture a green doctor result.

- Worktree: `/home/nubs/Documents/Codex/2026-08-22/eliza-linux-devices-runtimes`
- Local branch at packaging time: `codex/linux-devices-runtimes-20260822`
- Product payload source: `be05b667e76b7c8f5266667bfc33f35125b75faf`
- Packaging/tooling checkpoint: `02c00a3902a35732d7cb134f98570b9d349bdbfc`
- Merged base: `origin/develop` at `99188ccd5be87354502cc7db07ac50f45170ccab`
- Original merged work: [PR #24414](https://github.com/elizaOS/eliza/pull/24414), merge commit `acf111c4a`
- Publication state: local commits only in this continuation; no push, new PR,
  merge, signing, release, deployment, or system installation was performed.

## Delivered

- Reproducible Linux bootstrap with pinned Bun 1.3.14 and Node 24.15.0,
  checksum verification, frozen installs, and a capability doctor.
- CEF 147 Linux x64 packaging with strict RPC, permission, ABI, renderer,
  inventory, unsafe-switch, and distribution-claim gates.
- A fail-closed Electrobun 1.18.1 hotfix that forwards named partitions,
  maps them to direct SHA-256 CEF profiles, and closes/drains browsers so CEF
  flushes profile state before shutdown.
- The macOS-style bottom launcher pill expanding the shared `ChatOverlay`, plus
  tray, hotkey, notification, background, and relaunch behavior.
- Devices & Runtimes UI with durable selection, health, conversations, chat,
  SSH enrollment, keyring references, host-key binding, restart intent, and
  rehydration.
- Secure five-minute code-only activation, device-bound encrypted envelopes,
  replay/expiry/fencing protection, exact-once cancellation, reconnect,
  reconciliation, revocation, and bounded cleanup.
- Same-host lifecycle proof through the real `DesktopRemoteTargetService` and
  `RemoteTargetVault`, faithful injected secret storage, atomic journal,
  authenticated loopback, service recreation, exact-once dispatch, revocation,
  and no authority resurrection after restart.
- Reproducible Debian Bookworm portable inference builder and provenance for
  Vulkan ASR and OmniVoice TTS.
- Hardened `.deb`, AppImage, and side-load Flatpak packaging paths, including
  deterministic nested Electrobun app discovery and fail-closed ambiguity.
- A read-only whole-laptop Git preservation inventory in
  `reports/linux-parity/laptop-git-inventory.md`.

## Frozen CEF payload

- Path: `packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev`
- Built: `2026-08-23T02:50:53.651Z`; variant `direct`; 1,079 renderer assets.
- Renderer build ID: `246bdd070f40c9f3db17f22a40f032cb787f1d444b277b4ffac043a7b0de51db`.
- Size/inventory: 3,230,715,904 allocated bytes; 151,736 entries.
- Renderer: default `cef`, with `native` also available; CEF
  `147.0.10+gd58e84d+chromium-147.0.7727.118`.
- ABI: 78 ELF files; maximum required `GLIBC_2.38`, equal to the supported
  ceiling. Portable inference libraries require at most `GLIBC_2.34`.
- Permissions: zero writable or setuid/setgid regular files. Five intentional
  relative symlinks expose CEF libraries from `bin/cef/`.
- Chromium boundary: the pinned wrapper disables Chromium renderer/GPU
  sandboxes and `chrome-sandbox` is not setuid-root capable. Direct artifacts
  do not claim renderer-process sandboxing; Flatpak supplies an outer app
  sandbox instead.
- Embedded Bun: 1.3.13, controlled by Electrobun. Repository tooling remains
  pinned to Bun 1.3.14.

Selected SHA-256 identities:

```text
9cce6bcdc1bc550b6533454a8470870cc321773890c0d1bd03d10d5f441bd9cd  bin/launcher
40ba72d0cc6e38d04cd2ea29a650f5b3976673b2facb09fedae003b26bfdc971  bin/libNativeWrapper.so
dc7c0cd922fce45f39e8f9e0eb40eb25f1df0b806cc9890b208292c3398ae9e9  Resources/main.js
2bde89501be609ff6bbcd67fb366300ca1641cc53cc4ac724c46d422995fb83d  Resources/app/bun/index.js
c262b0eadb3e4c31527ab0420bdfa1e199505fb837c8a1ef0113b1143c37eb4b  Resources/app/renderer/index.html
b40e35df512ed9570fbdb47c3c9a45745528b85b8bc135d51dff5adb81135359  Resources/build.json
1900fe614895951e06014e477b1bec3bccea14529092fb927b630a315985e21c  Resources/app/eliza-dist/local-inference/lib/libelizainference.so
```

Native hotfix identities:

```text
e7172d886925e4d728cf35cbee5a52ad17c33e9bb4c40248a788a0a10100df53  upstream Electrobun wrapper
40ba72d0cc6e38d04cd2ea29a650f5b3976673b2facb09fedae003b26bfdc971  patched Electrobun wrapper
b7e043197daca54f028b63fc1d05b12e6b69901a76ddbcea84adb653652d5430  electrobun-1.18.1-cef-profile-x64.bsdiff
```

## Distributables

### Debian

- Artifact: `packages/app-core/platforms/electrobun/artifacts/elizaos-app_2.0.3-beta.7_amd64.deb`
- Size: 474,119,096 bytes.
- SHA-256: `78dfe3cf76faab4660fa6ae010830791e20e258416ad6d9e7f771623abcbe04d`.
- All 151,736 archive entries are `root/root`. The extracted payload matches
  the frozen hashes and passes the `production-direct` contract.

### AppImage

- Artifact: `packages/app-core/platforms/electrobun/artifacts/Eliza-2.0.3-beta.7-linux-x64.AppImage`
- Size: 596,452,544 bytes; mode `0755`.
- SHA-256: `fe5d211740317f048afe110be82b70a7997bd47ca95b58f6b336b2b5dd8ef27d`.
- AppStream validation succeeds; the only pedantic note is optional release
  history metadata.
- Its extracted payload matches the frozen hashes, passes the distribution
  contract, and its exact `AppRun` rendered substantial UI in Xvfb (1/1).

### Flatpak

- Artifact: `/tmp/eliza-flatpak-artifacts-20260823-be05/Eliza-2.0.3-beta.7-linux-x86_64.flatpak`.
- Size: 454,183,528 bytes.
- SHA-256: `6e70dcaf7f4d33ed1d3250ae84c1ccb35e5327a28c8a5e8af49c724ce653e78d`.
- Isolated no-deploy import passed at commit
  `4e92aac93f1a0ecd34925c5db56b7d5d53bf0534a30332a3ae55e27bda4d5838`,
  using GNOME Platform 50 and Freedesktop SDK 25.08. Its declared permissions
  are IPC/network, fallback-X11/Wayland/PulseAudio, and DRI.
- The packaging contract verifies the outer sandbox and explicitly does not
  claim Chromium renderer-process sandboxing or Flathub/store readiness.

### RPM

- Not built: `rpmbuild` is not installed and no system mutation was authorized.
  The RPM code path and dependency metadata remain covered by packaging tests.

## Verification

- Fresh no-streaming desktop build completed and stamped the renderer/service
  worker to `be05b667e`.
- `production-direct` contract: pass; 151,736 entries, 78 ELF files, maximum
  `GLIBC_2.38`.
- Exact broad packaged acceptance: 10 passed, 4 intentional platform/hardware
  skips, 0 failed in 3.8 minutes. The walkthrough recorded 148 frames over
  24.47 seconds with zero capture failures.
- Focused CEF packaged regressions: all three Linux cases passed, including a
  zero-delay real-process relaunch; two platform cases skipped. The persistence
  case also passed three consecutive repeat runs.
- Same-host remote lifecycle, runner, and main-window session suites: 33/33.
- Direct plus Flatpak packaging suites after nested-build repair: 31/31.
- Exact Debian archive: all entries root-owned; extracted contract and frozen
  hashes passed. Exact AppImage: extracted contract/hashes plus launch/render
  passed. Exact Flatpak: hash and isolated no-deploy import/metadata passed.
- App and Electrobun typechecks passed. Targeted storage bridge tests passed
  6/6; main-window session tests passed 9/9.
- Native patch verification passed, and the review source patch applies cleanly
  to pristine Electrobun v1.18.1.
- Biome checks and `git diff --check` passed for the modified source.
- Final Linux doctor: 35 passed, 5 optional warnings, 1 required failure. The
  sole failure is the documented 4.3 GiB free-space/rebuild floor; optional
  warnings cover development headers, containers, and unreadable firewall
  state rather than the packaged runtime.
- Earlier completed gates remain recorded in Git history: accessibility,
  remote Cloud/PGlite routes, safe fetch, affected lint/typecheck/build,
  portable inference builder, real model ASR, and Vulkan TTS.

These tiers do not convert Xvfb, same-host, or focused tests into physical,
live-provider, second-device, or production proof.

## Laptop Git preservation snapshot

The no-fetch, no-mutation laptop scan found 425 Git markers and 421 canonical
repositories. Of those, 178 need individual attention: 102 dirty repositories,
136 branches without upstreams, 14 cached-ahead branches, and 25 cached-behind
branches, with overlapping categories. Cached divergence may be stale. The
scan did not fetch, commit, clean, push, or open PRs; an `iqlabs` timeout and
root-owned tails/chroot paths remain explicit coverage gaps.

## Remaining release gates

1. Physical GNOME/Wayland: pill placement, tray, shortcut, notifications,
   scales/monitors, suspend/resume, reboot persistence, and visible UX review.
2. Physical media/provider: microphone, speaker, camera, and live voice chain.
3. Second machine: Mac/VPS SSH enrollment, WAN reconnect, changed-host-key
   confirmation, restart recovery, and revocation with real identities.
4. Real persistence services: Linux Secret Service plus deployed Cloud/PGlite
   migrations and relay, rather than same-host injected boundaries.
5. Installer lifecycle: owner-approved clean install, upgrade, uninstall, and
   reinstall. No `sudo` mutation was performed.
6. RPM: install/enable an approved RPM build environment, then build and inspect
   the exact artifact.
7. Rebuild capacity: approve removal of specific generated outputs/caches or
   provide another build filesystem until at least 8 GiB is free.
8. Publication: review the exact local branch, push it, and open a new draft PR
   only after explicit approval. Signing, release publication, merge, deploy,
   and production mutation remain separately gated.

## Recovery

```bash
cd /home/nubs/Documents/Codex/2026-08-22/eliza-linux-devices-runtimes
git status --short --branch
git log --oneline --decorate origin/develop..HEAD
node packages/scripts/patch-electrobun-linux-cef-profile.mjs --require
node packages/app-core/scripts/linux-distribution-contract.mjs \
  --build-dir=packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev \
  --claim=production-direct
```
