# Linux parity and Devices & Runtimes status

Last updated: 2026-08-22 UTC

## Outcome

The independently actionable local engineering work is complete for this candidate. Linux now has the shared macOS-style compact bottom launcher pill and chat surface, native Electrobun packaging, secure Devices & Runtimes flows, portable local inference, and real `.deb` and AppImage artifacts. The frozen payload passes the `production-direct` distribution contract.

Release qualification is not complete. Physical GNOME/Wayland and hardware QA, a second Mac/VPS remote-runtime pass, system-wide installer lifecycle tests, RPM/Flatpak builds, review, signing, publication, and deployment remain owner/environment/authority gates.

- Worktree: `/home/nubs/Documents/Codex/2026-08-22/eliza-linux-devices-runtimes`
- Local branch: `codex/linux-devices-runtimes-20260822`
- Implementation head before this status-only update: `69e482379`
- Merged base: `origin/develop` at `99188ccd5`
- Original PR: [#24414](https://github.com/elizaOS/eliza/pull/24414), merged as `acf111c4a`
- Publication state: this follow-up work is committed locally but has not been pushed. The merged PR cannot be updated; a clean follow-up branch and new draft PR require explicit action-time approval.

## Delivered

- Reproducible Linux bootstrap with pinned Bun 1.3.14 and Node 24.15.0, checksum verification, frozen installs, and a capability doctor.
- Native-only Electrobun packaging with strict RPC listener, permissions, CEF-absence, unsafe-switch, inventory, and glibc gates.
- A macOS-style bottom launcher pill expanding the shared `ChatOverlay`, plus tray, hotkey, notification, and relaunch behavior.
- Devices & Runtimes UI with durable selection, health/status, conversations, chat, SSH enrollment, keyring credential references, host-key binding, restart intent, and rehydration.
- Secure five-minute code-only remote activation, source/host throttles, device-bound encrypted envelopes, replay/expiry/fencing protection, exact-once cancellation, reconnect/reconciliation, revocation, and bounded paged cleanup.
- Reproducible Debian Bookworm portable inference builder and provenance for Vulkan ASR and OmniVoice TTS.
- Browser-safe translations, shared-package build serialization, and upstream integration fixes found during the final full gates.
- Hardened direct installers: root-owned Debian archives, normalized modes, safe POSIX quoting, deterministic Electrobun launcher selection, AppImage-local launch resolution, and validated AppStream metadata.

## Frozen native payload

- Path: `packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev`
- Size/inventory: 2,254,815,232 allocated bytes; 151,491 entries.
- Renderer: `native` only; no packaged `libcef.so`; no unsafe CEF switches.
- ABI: 62 ELF files; maximum required `GLIBC_2.38`, equal to the supported ceiling. Portable inference libraries require at most `GLIBC_2.34`.
- Permissions: zero group/world-writable or setuid/setgid files; zero symlinks.
- Embedded Bun: 1.3.13, controlled by Electrobun. Repository build/test tooling is pinned to Bun 1.3.14.

Selected SHA-256 identities:

```text
9cce6bcdc1bc550b6533454a8470870cc321773890c0d1bd03d10d5f441bd9cd  bin/launcher
dc7c0cd922fce45f39e8f9e0eb40eb25f1df0b806cc9890b208292c3398ae9e9  Resources/main.js
b70cd0033a183264425c018440b7580efa31c64eb27be836ccdaa6e4590c6371  Resources/app/bun/index.js
83124cd55009729d65c00f44cf7a542b142091515b24caaf94b04f0e09e3dbd6  Resources/app/renderer/index.html
40704c6f0fad4ac8215f9ce8dbcbafd4918533d0b3d39f68cdc0a92a4f858988  Resources/build.json
1900fe614895951e06014e477b1bec3bccea14529092fb927b630a315985e21c  libelizainference.so
9559d5076c49bfca73612981cea10885a2ea251aebbf814064427b9254024068  PORTABLE_FUSED_PROVENANCE.json
```

## Real distributables

### Debian

- Artifact: `packages/app-core/platforms/electrobun/artifacts/elizaos-app_2.0.3-beta.7_amd64.deb`
- Size: 354,736,744 bytes (339 MiB).
- SHA-256: `699bf6a5ff89fedcef49e8ec7e2e7ef38a9d3dc50e0ac6904550b8db0c1b00b9`.
- Every control and payload archive member is owned by numeric `0/0`.
- Wrapper/desktop/icon modes are `0755`/`0644`/`0644`.
- `/usr/bin/eliza` executes `/opt/eliza/bin/launcher`, not sibling tools such as `bspatch`.
- Extracted payload passes the full `production-direct` contract and matches the frozen hashes above.

### AppImage

- Artifact: `packages/app-core/platforms/electrobun/artifacts/Eliza-2.0.3-beta.7-linux-x64.AppImage`
- Size: 429,573,312 bytes (410 MiB).
- SHA-256: `b15d3c6ee750dd85b16f0d58b93df31d4184f999932f802d3cb4d4e25473bd22`.
- Executable mode `0755`; AppRun, desktop files, icon, and AppStream metadata have normalized modes.
- `AppRun` directly resolves the mounted `opt/eliza/bin/launcher`; it does not depend on a host `/opt/eliza` installation.
- AppStream validation succeeds with no warning or error. Its only pedantic note is optional release-history metadata.
- Extracted payload passes the full `production-direct` contract and matches the frozen hashes above.

## Verification

- Exact packaged desktop acceptance: 10 passed, 4 intentional platform/hardware skips, 0 failed in 3.8 minutes. The real walkthrough recorded 188 frames over 24.76 seconds with zero capture failures.
- Electrobun suite after upstream merge: 87 files, 679 passed, 15 skipped, 0 failed; typecheck passed.
- Linux packaging tests: 4 files, 69 passed; focused permissions tests 3 passed; final direct packager test 13 passed.
- UI focused suites: 11 files, 80 passed; UI/shared typechecks passed.
- Chromium accessibility E2E: 35 assertions passed with zero page errors, including the exact 12-control visible focus order, SSH focus order, narrow/wide layouts, 200% text, forced colors, and reduced motion.
- Cloud remote routes/PGlite: 57 passed; production Wrangler dry run passed with no deployment.
- Safe-fetch tests: 24 passed; Cloud API typecheck passed.
- Full affected lint: 143 tasks passed with warnings only.
- Full affected typecheck: 231 tasks passed.
- Full affected build: 132 tasks passed.
- Core build: 59 packages passed after cross-process shared-package locking.
- Focused remote coding runner: 52 passed; agent typecheck passed.
- Portable inference builder: 11 passed. Exact output real ASR passed (39 words, about three sentences). Exact output Vulkan TTS passed (62,400 samples, 3.9 seconds, RMS 0.094453, exit 0).
- No launcher, Playwright, Xvfb, or loopback-listener processes remained after packaged acceptance.

An earlier mixed root `bun test` invocation produced DOM/PGlite harness failures because it bypassed the packages' configured environments. Canonical package suites were rerun and passed; the mixed invocation is not treated as product evidence.

## Remaining release gates

1. Physical GNOME/Wayland verification: placement, tray behavior, global shortcut, notifications, suspend/resume, reboot persistence, and visible interaction on the owner's desktop.
2. Physical media/provider verification: microphone, speaker, camera, and live voice-provider chain.
3. Second-machine verification: Mac or VPS SSH pairing, changed host-key confirmation, WAN reconnect, revocation, and restart recovery.
4. Installer lifecycle: owner-approved system-wide Debian clean install, upgrade, uninstall, and reinstall. No `sudo` mutation was performed.
5. RPM and Flatpak: `rpmbuild` and `flatpak-builder` are absent; only GNOME Platform 50 is installed while the Flatpak recipe targets GNOME 49. Installing tooling/runtimes is owner-controlled.
6. Publication: prepare a clean follow-up branch from current `develop`, review its exact diff, push it, and open a new draft PR only after explicit `push now` approval. Signing, release publication, merge, deploy, and production mutation remain separately approval-gated.

## Recovery

```bash
cd /home/nubs/Documents/Codex/2026-08-22/eliza-linux-devices-runtimes
git status --short --branch
git log --oneline --decorate origin/develop..HEAD
node packages/app-core/scripts/linux-distribution-contract.mjs \
  --build-dir=packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev \
  --claim=production-direct
```
