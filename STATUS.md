# Linux parity and Devices & Runtimes status

Last updated: 2026-08-22 UTC

## Safety and source identity

- Isolated worktree: `/home/nubs/Documents/Codex/2026-08-22/eliza-linux-devices-runtimes`
- Branch: `feat/linux-devices-runtimes-20260822`
- Exact base: `origin/develop` at `c97833f1c53332af08d53bbf0cc029ec05d1bb42`
- Commit author: `NubsCarson <nubs@nubs.site>`
- Publication state: local only. Nothing from this lane has been pushed, merged, deployed, or applied to production/cloud infrastructure.
- Preserved shared checkout: `/home/nubs/Documents/Codex/2026-08-14/eliza-voice-implementation-2/work/eliza`. It was inspected but never reset, cleaned, or used for edits.
- Current filesystem constraint: the root filesystem reports 100% used with about 7.4 GiB available. The in-place packaged candidate is about 2.8 GiB, so a second full Flatpak/package copy is deliberately blocked pending safe disk headroom.

## Recoverable milestones

| Commit | Local tag | Contents |
| --- | --- | --- |
| `33c006dee` | `linux-parity-bootstrap-20260822` | Pinned Linux bootstrap and strict doctor workflow |
| `2b5351975` | `remote-control-core-20260822` | Device-bound encrypted command protocol, replay/fencing, and cleanup core |
| `be092e7c6` | — | Original packaged Linux QA evidence and failure classification |
| `6b916e8fa` | `linux-desktop-hardening-20260822` | Loopback Electrobun RPC binding and packaged permission gates |
| `730734ea0` | `account-pool-startup-hardening-20260822` | Retryable account-service startup behavior instead of a null dereference |

Additional Cloud relay, Devices UI/SSH, and Linux distribution milestones are still in isolated local integration and must be recorded here after their focused verification and commits finish.

## Host audit

| Area | Observed state |
| --- | --- |
| OS/session | Debian forky/sid, x86-64, kernel 7.1.8, GNOME Wayland host |
| GPU | Intel Arc 130V/140V through the `xe` driver; Vulkan local-inference execution verified |
| Memory | About 30 GiB RAM and 31 GiB swap |
| Audio | PipeWire active; only a loopback capture/playback path was available during unattended QA despite SOF hardware being present |
| Camera | Camera devices enumerated, including IPU7/Iriun paths; physical capture was not exercised unattended |
| Containers | Docker installed but inactive during audit |
| Toolchain | Repository-pinned Bun 1.3.14 and Node 24.15.0 under ignored `.cache/linux-dev-toolchain` |
| Native build | Real CPU + Vulkan fused local-inference library built and symbol/dependency checked |

Run the reproducible checks from this worktree:

```bash
./scripts/bootstrap-linux-dev.sh
bun run linux:doctor
```

The bootstrap uses verified SHA-256 identities for the pinned Bun and Node archives, performs a frozen install, and leaves the toolchain in an ignored cache. The strict doctor passed 30 checks. It reports non-blocking host warnings for unavailable libsecret/PipeWire development packages and inactive Docker rather than claiming those capabilities were exercised.

## Support matrix

| Surface | Current Linux status | Evidence boundary |
| --- | --- | --- |
| Browser/web UI | Supported; production renderer build and deterministic Chromium runtime-choice smoke passed | Browser/fixture proof, not a native or remote-device proof |
| Local API/runtime | Supported on loopback; startup, health/auth boundary, SIGINT shutdown, and orphan-listener cleanup exercised | Real Linux process proof with an isolated state directory |
| App-core/shared renderer | Supported; focused build/lint/test gates passed before remote integration | Source and build proof |
| Electrobun desktop | In-place x64 package builds and launches; RPC now binds loopback and output modes are hardened | Packaged Xvfb proof; physical GNOME/Wayland inspection remains required |
| Cloud packages | Secure relay implementation is in focused local verification | No deployed/staging/production claim |
| Voice/local inference | Real Vulkan ASR and TTS FFI calls passed against local model assets | Runtime inference proof, not physical mic/speaker or live-provider E2E |
| Devices & Runtimes | Protocol core complete; relay/UI/SSH integration still being finalized | Source/unit proof until integrated command-loop QA passes |
| Linux installer | Existing Flatpak side-load path identified; distribution gates are being hardened | No install/reinstall proof because a second multi-GiB artifact is unsafe with current disk headroom |
| Apple-only behavior | AppKit, Keychain, Apple signing/notarization, and iOS runtime behavior remain platform-specific | Explicit platform gate; no Linux parity claim |

## Verified commands and results

### Repository and desktop gates

- Frozen dependency installation: passed.
- Development prepare suite: 98/98 passed.
- Linux doctor unit suite: 6/6 passed.
- Electrobun unit suite: 77 files, 583 passed and 15 intentionally skipped.
- Electrobun lint: 215 files checked.
- Renderer production build: passed.
- Full Linux desktop stage/package: passed.
- Hardened packaged launch-render smoke: 1/1 passed in 13.1 seconds.
- Hardened live listeners: `127.0.0.1:50000` and `127.0.0.1:5174`; no wildcard packaged listener.
- Hardened output permissions: zero group/other-writable files and zero group/other-writable directories.
- Representative packaged `ldd` scan: zero missing libraries.
- Account-route startup regression: 14/14 focused tests passed.
- Known unrelated typecheck baseline: `packages/agent/src/api/server.ts:2556` has an optional `Signal` union error already owned by upstream PR #24320.

### Artifact identity

- In-place artifact: `packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev`
- Current measured size: about 2.8 GiB.
- Fused inference library: `dist/local-inference/lib/libelizainference.so`
- Fused library SHA-256: `b64d289f41dd132b196c79237e55e0a6bb601b9b462164823080b957ed5a1a68`
- Pinned llama.cpp submodule: `6543d9078051a9bb194c2ef5c2995f003c5158de`

### Real Linux runtime proof

- Isolated local API lifecycle used port `31877`, bound only to `127.0.0.1`, reported the accurate awaiting-onboarding health state, enforced local auth, stopped on SIGINT, and left no listener or child process.
- Vulkan ASR smoke produced 39 words and three sentence endings in 71,379 ms.
- Direct OmniVoice FFI synthesis produced 60,480 samples at RMS 0.088705 in 74,605 ms.
- No physical microphone/speaker or live provider-chain claim is made: the unattended host exposed only loopback audio endpoints at test time.

## Packaged QA evidence

The detailed original and hardened-artifact observations are in `reports/linux-parity/packaged-qa.md`.

Durable screenshots include:

- `packages/app/test-results/rebuild-listener/desktop-launch-render.e2e--9d3bf-ers-a-non-blank-UI-headless/desktop-launch-render.png`
- `packages/app/test-results/desktop-launcher-smoke.e2e-1e992-ata-page-AX-probe-non-blank/desktop-launcher-launcher.png`
- `packages/app/test-results/desktop-launcher-smoke.e2e-1e992-ata-page-AX-probe-non-blank/desktop-launcher-home.png`

The original broad packaged run discovered 14 tests: 4 passed, 5 failed, 3 skipped, and 2 did not run. The hardened rebuild has not yet rerun that entire suite. Failures were classified rather than hidden:

- The account-pool `sweepExpired` null crash is fixed by `730734ea0` and returns an actionable retryable 503 until app-core installs its host bridge.
- Permission-priming UI displaced stale walkthrough/onboarding selectors.
- Xvfb without a window manager reported bottom-bar `y = 0`; physical GNOME placement remains unverified.
- The shortcut test expected a post-launch seed while the app correctly registered the production default earlier in startup.
- CEF localStorage did not survive the harness relaunch. Source requests a named `persist:` partition, but the packaged binary created only its global/default CEF profile; the named profile was not materialized. This remains a dependency/profile gate, not a test assertion to weaken.
- The minimum launch-render assertion can pass a near-black frame with only the handle visible and must be strengthened before it becomes visual acceptance evidence.

## Current release blockers and human-owned gates

1. Electrobun 1.18.1 hardcodes `no_sandbox`, `--no-sandbox`, and `--disable-gpu-sandbox` in its Linux CEF implementation. The bundled `chrome-sandbox` is ordinary mode 0755. Loopback and payload permissions are fixed, but renderer sandboxing is not.
2. The final source integration, full renderer/desktop rebuild, exact-once relay simulations, broad packaged rerun, and final status/PR handoff remain in progress.
3. A full Flatpak build/install/reinstall needs safe disk headroom beyond the current 7.4 GiB. It must not hardlink a staging tree if any build step could mutate the source artifact.
4. Physical GNOME/Wayland window/tray/shortcut inspection, real microphone and distinct speaker selection, camera capture, suspend/reboot persistence, and Wi-Fi transition require the owner at the laptop.
5. Cross-device proof across both Macs, physical phone, user-controlled VPS, and changed SSH host keys requires those devices/identities and explicit secret or fingerprint confirmation. No Mac/VPS private key may be copied to a phone or Cloud service.
6. Hosted CI/security, isolated staging, publication, and production deployment are separate approval gates. Nothing in focused local tests is a production sign-off.

## Recovery and continuation

```bash
cd /home/nubs/Documents/Codex/2026-08-22/eliza-linux-devices-runtimes
git status --short
git log --oneline --decorate origin/develop..HEAD
git tag --list '*20260822' --sort=creatordate
bun run linux:doctor
```

Before deleting or rebuilding any large artifact, recheck `df -h .`, identify the exact generated target, and preserve this worktree plus every dirty/shared checkout. Resume from the latest coherent local tag; do not reset or clean the preserved checkout.
