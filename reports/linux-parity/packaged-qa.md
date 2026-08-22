# Linux packaged/runtime QA — original artifact

**Captured:** 2026-08-22 UTC

**Host:** Debian forky/sid, x86_64, glibc 2.43, GNOME/Wayland host; packaged automation used a dedicated Xvfb X11 display and software rendering.

**Verdict:** **not production/demo ready.** The original artifact launches and exercises real native-shell behavior, but it has release-blocking network/sandbox/package-permission findings and its broad packaged suite is red. Browser fixture proof is green but does not close those native gaps.

This report is deliberately scoped to the artifact built before the subsequent Electrobun listener hardening. It makes no claim about later source edits or rebuilt artifacts.

## Artifact identity

- Checkout base: `c97833f1c53332af08d53bbf0cc029ec05d1bb42`; QA branch had the local Linux doctor commit `33c006dee` but no implementation change was included in this artifact.
- Build path: `packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev`
- Build timestamp from `Resources/app/eliza-dist/build-info.json`: `2026-08-22T07:37:13.598Z`
- Build-info version/channel: `2.0.4` / `stable`
- Electrobun version metadata: `2.0.0-beta.0`, hash `dev`, channel `dev`, identifier `ai.elizaos.app`
- Electrobun build manifest: default renderer `cef`, CEF `147.0.10+gd58e84d+chromium-147.0.7727.118`, embedded Bun `1.3.13`
- Size/inventory: 2.6 GiB, 127,817 files; `Resources/app` 2.0 GiB, embedded `eliza-dist` 1.9 GiB, renderer 33 MiB, `bin` 639 MiB.
- No `.deb`, `.rpm`, `.AppImage`, `.tar.zst`, or other installable Linux release archive exists under the Electrobun package. This is an in-place build directory, not install/reinstall proof.

Selected SHA-256 identities:

```text
9cce6bcdc1bc550b6533454a8470870cc321773890c0d1bd03d10d5f441bd9cd  bin/launcher
dc7c0cd922fce45f39e8f9e0eb40eb25f1df0b806cc9890b208292c3398ae9e9  Resources/main.js
8795ecf60d4c6b5dc7f64ed3a53d2ab5164100ad3a8056baab29c2d34835ece5  Resources/app/bun/index.js
a47a4fb7323f5040875358ab2e225cbc4b7914f36ba9e18b941ccf36d54bcca0  Resources/app/renderer/index.html
b40e35df512ed9570fbdb47c3c9a45745528b85b8bc135d51dff5adb81135359  Resources/build.json
35d16842e7a58e27ceaaf4cde8e5c8a33b1b62a688bf2ecec6cce83d6821c12f  Resources/version.json
```

The inconsistent `stable 2.0.4` embedded-runtime metadata versus `dev 2.0.0-beta.0` Electrobun metadata and repo-pinned Bun 1.3.14 versus embedded Bun 1.3.13 are provenance/reproducibility defects to resolve before a release claim.

## Hardened rebuild delta

After the original-artifact audit, the parent lane patched both the shared and lazy-downloaded Electrobun Linux sources to bind RPC to loopback and hardened the desktop build to fail closed on wildcard listener source or group/other-writable output. It rebuilt the package at the same path. I then ran the same exact launcher with a separate Playwright output directory:

```bash
export PATH="$PWD/.cache/linux-dev-toolchain/bun-1.3.14-x64/bin:$PWD/.cache/linux-dev-toolchain/node-24.15.0-x64/bin:$PATH"
export ELIZA_TEST_PACKAGED_AUTO_BUILD=0
export ELIZA_TEST_PACKAGED_LAUNCHER_PATH="$PWD/packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev/bin/launcher"
bun run --cwd packages/app test:desktop:packaged \
  test/electrobun-packaged/desktop-launch-render.e2e.spec.ts \
  --output=test-results/rebuild-listener
```

Result: **1/1 passed in 13.1 seconds.** While the rebuilt app was live, its main packaged Bun PID listened on `127.0.0.1:5174` and **`127.0.0.1:50000`**; no wildcard listener was present. The rebuilt bundle contains the corresponding `hostname: "127.0.0.1"` settings. After the test, no packaged launcher, Bun/CEF helper, `xvfb-run`, test Xvfb, or observed packaged listener remained. Rebuild screenshot: `packages/app/test-results/rebuild-listener/desktop-launch-render.e2e--9d3bf-ers-a-non-blank-UI-headless/desktop-launch-render.png`.

The rebuild also changed all packaged file and directory modes to remove group/other write access: `find "$bundle" -type f -perm /0022` and the equivalent directory check both returned **0**. Representative `ldd` recheck still found **0 missing libraries**. `bin/launcher`, `bin/chrome-sandbox`, and bundled esbuild are now 0755; `Resources/main.js` and the bundled Bun entry are 0644.

Rebuilt selected SHA-256 identities:

```text
9cce6bcdc1bc550b6533454a8470870cc321773890c0d1bd03d10d5f441bd9cd  bin/launcher
dc7c0cd922fce45f39e8f9e0eb40eb25f1df0b806cc9890b208292c3398ae9e9  Resources/main.js
52ff317cc86823a11d96ba531999801335ba4b6cd0022d663a1c8e235fdf3d90  Resources/app/bun/index.js
01ac04d6a796add7a449c40d5d48b182bf65c070686a4bcb087812bc84420567  Resources/app/renderer/index.html
b40e35df512ed9570fbdb47c3c9a45745528b85b8bc135d51dff5adb81135359  Resources/build.json
35d16842e7a58e27ceaaf4cde8e5c8a33b1b62a688bf2ecec6cce83d6821c12f  Resources/version.json
```

The rebuild closes the wildcard-listener and writable-payload blockers for this generated directory. It does **not** close the CEF sandbox blocker: live rebuilt helpers still carried `--no-sandbox`, and the GPU helper carried `--disable-gpu-sandbox`; `chrome-sandbox` remains ordinary 0755. The broad 14-test packaged suite was not re-run after the rebuild, so the original broad failures remain the current broad-suite evidence. The embedded `build-info.json` also retained its original `2026-08-22T07:37:13.598Z` timestamp despite the rebuilt bundle files being written around 08:14 UTC, so artifact provenance remains misleading.

## Release blockers and failure classification

| Severity | Finding | Classification | Evidence |
|---|---|---|---|
| Blocker → fixed in rebuild | Main process exposed the Electrobun RPC WebSocket on wildcard `*:50000`; other observed app/test listeners were loopback-only (`127.0.0.1:31340`, `:31342`, `:31985`, `:5174`). | Product/dependency defect in the original artifact. No remote command execution was proven, but the unauthenticated wildcard socket and 500 MiB message/backpressure limits created a remote attack/DoS surface and violated the loopback-only requirement. The hardened rebuild bound `:50000` to `127.0.0.1` in a live process. | Original live `ss -ltnp` tied all five listeners to the packaged Bun PID. Electrobun 1.18.1 `Socket.ts` omitted `hostname`; the rebuild adds loopback binding and a build gate. |
| Blocker | CEF helpers ran with `--no-sandbox`, renderer with `--no-sandbox`, GPU with `--disable-gpu-sandbox`; bundled `bin/chrome-sandbox` is mode 0775, not a configured setuid sandbox. | Product/dependency/package defect. Unresolved in this artifact. | Live process command lines and `stat -c '%a %A %n' bin/chrome-sandbox`. |
| Blocker → fixed in rebuild | Many executable/source payload files in `Resources/app/eliza-dist/node_modules` were mode 0777. | Packaging defect in the original artifact. The hardened rebuild produced zero group/other-writable files and directories. | Original `find "$bundle" -type f -perm -0002`; rebuild `find ... -perm /0022` file and directory counts both zero. No setuid/setgid file was present. |
| High | Broad packaged desktop suite: 4 passed, 5 failed, 3 skipped, 2 not run. | Mixed; details below. | Exact command and artifacts below. |
| High | Minimal launch-render test passed on an almost entirely black 1240×860 frame with only the bottom white handle painted. | Test assertion weakness / insufficient visual proof; possible product startup/render sequencing issue. It must not be reported as a complete rendered-home pass. | `packages/app/test-results/desktop-launch-render.e2e--9d3bf-ers-a-non-blank-UI-headless/desktop-launch-render.png` (4,158 bytes). |
| High | Real launcher screenshots show the product UI, but a `Set up Eliza` / `Talk to me` permission-priming modal overlays and dims the launcher/home surfaces. | Product UX sequencing risk plus stale packaged-test setup. The modal is intentional source behavior, but the packaged harness does not seed/dismiss it, so existing chat/onboarding tests cannot reach their intended surfaces. | `desktop-launcher-launcher.png` and `desktop-launcher-home.png` paths below; source mounts `PermissionPrimingOverlay` after first-run. |
| Medium | Runtime logged `Request handler failed: Cannot read properties of null (reading 'sweepExpired')`. | Product defect in degraded account-pool initialization/request handling; not the direct cause of the five assertions but an unhealthy runtime path. | Broad-run console after agent/API startup; `accounts-routes.ts` invokes `pool.sweepExpired?.()` even when the pool itself is null. |
| Medium | Packaged localStorage did not persist the seeded first-run/active-server state across relaunch; harness re-seeded it in-session. | Product persistence or graceful-shutdown defect masked by test fallback. | Two broad-run warnings: `localStorage was NOT persisted across relaunch ... — re-seeding state for this session.` |
| Medium | `libNativeWrapper.so` requires GLIBC_2.38 plus host WebKitGTK 4.1/GTK 3/Ayatana libraries. | Portability boundary, not a failure on this forky host. This artifact is not proof for Debian stable or other Linux distributions. | `readelf --version-info`; representative `ldd` scan. |

The original artifact contains one absolute checkout path literal in bundled `Resources/app/bun/index.js`, in the bundled `@napi-rs/keyring` loader's `__filename`. The adjacent native module nevertheless loaded read-only with the embedded Bun via `require()` and exposed the expected exports. Relocation of the full directory was not attempted because the disk had only 7–9 GiB free and another 2.6 GiB copy would have endangered the shared worktree.

## Packaged suite

Command (pinned runner, no auto-rebuild, exact launcher):

```bash
export PATH="$PWD/.cache/linux-dev-toolchain/bun-1.3.14-x64/bin:$PWD/.cache/linux-dev-toolchain/node-24.15.0-x64/bin:$PATH"
export ELIZA_TEST_PACKAGED_AUTO_BUILD=0
export ELIZA_TEST_PACKAGED_LAUNCHER_PATH="$PWD/packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev/bin/launcher"
bun run --cwd packages/app test:desktop:packaged
```

Final original-artifact run: **4 passed, 5 failed, 3 skipped, 2 did not run; 5.8 minutes; exit 1.** An earlier independent run produced the same counts in 7.0 minutes.

Passed:

- Real packaged launcher reached the native bridge and captured a physical Xvfb screenshot.
- Launcher store/rail transition and accessibility probe.
- Native notification bridge for background/urgent notifications.
- Media/provider/plugin state assertions across a relaunch after the harness re-seeded non-persisted startup storage.

Failed and classified:

1. `desktop-chat-walkthrough`: `home pill not found`. **Likely stale harness/selector caused by the permission-priming modal and shell sequencing**, not proof the chat engine itself is broken. The generated MP4 contains 21 identical near-black frames with the bottom handle, so the intended real-time chat walkthrough was not demonstrated.
2. `desktop-first-run` onboarding: tutorial skip choice never appeared. **Likely stale packaged-test setup plus product sequencing risk**; the post-login permissions surface displaced/covered the flow the spec intended to drive.
3. `desktop-first-run` pairing: pairing screen never appeared. **Likely stale packaged-test setup plus product sequencing risk**. No pairing redeem success was demonstrated in the package.
4. `electrobun-bottom-bar`: bounds were `{ y: 0, height: 56 }` while the spec requires `y > height`. **Likely Xvfb/no-window-manager geometry expectation**, not a confirmed GNOME product defect. It still blocks this automated Linux gate; physical GNOME bottom anchoring remains unverified.
5. `packaged shortcut bridge`: expected seeded `Alt+Shift+Super+F11`, received the production default `CommandOrControl+Shift+C`. **Stale test sequencing/expectation**: the renderer registers the current default before the post-relaunch test seed can affect it. `CommandOrControl+K` and `CommandOrControl+Shift+Space` also registered.

Intentional skips / not run:

- Live voice self-test skipped by design; it requires `ELIZA_VOICE_DESKTOP_SELFTEST=1`, a real API base, capture session ID, and distinct real microphone/speaker device IDs.
- Linux correctly skips application-menu reset and macOS vibrancy assertions.
- Later serial notification/relaunch tests did not run after the shortcut failure. They are not passes.

Durable artifacts (all relative to repo root):

- Real UI launcher screenshots:
  - `packages/app/test-results/desktop-launcher-smoke.e2e-1e992-ata-page-AX-probe-non-blank/desktop-launcher-launcher.png`
  - `packages/app/test-results/desktop-launcher-smoke.e2e-1e992-ata-page-AX-probe-non-blank/desktop-launcher-home.png`
- Minimal near-black launch frame:
  - `packages/app/test-results/desktop-launch-render.e2e--9d3bf-ers-a-non-blank-UI-headless/desktop-launch-render.png`
- Persistence screenshots:
  - `packages/app/test-results/electrobun-packaged-regres-56127-lugin-state-across-relaunch/persistence-before-relaunch.png`
  - `packages/app/test-results/electrobun-packaged-regres-56127-lugin-state-across-relaunch/persistence-settings-after-relaunch.png`
  - `packages/app/test-results/electrobun-packaged-regres-56127-lugin-state-across-relaunch/persistence-plugins-after-relaunch.png`
- Chat failure video/trace/context:
  - `packages/app/test-results/desktop-chat-walkthrough.e-0ac5b-ugh-records-a-real-time-MP4/desktop-chat-walkthrough.mp4`
  - same directory: `trace.zip`, `error-context.md`, `walkthrough-frames/`
- First-run traces/contexts:
  - `packages/app/test-results/desktop-first-run.e2e-pack-ef42d-ding-and-persists-first-run/`
  - `packages/app/test-results/desktop-first-run.e2e-pack-cd469--a-code-and-reaches-auth-me/`
- Bottom-bar trace/context:
  - `packages/app/test-results/electrobun-bottom-bar.e2e--ab6fc-ey-toggle-and-tray-launcher/`
- Shortcut trace/context:
  - `packages/app/test-results/electrobun-packaged-regres-d1e41-dge-summons-the-main-window/`

The Playwright lane does not persist complete app stdout/stderr on success. The exact assertion contexts and retained traces above are the durable failure logs; process/runtime lines quoted here came from the captured console stream.

After the suite exited, no packaged launcher, packaged Bun/CEF helper, `xvfb-run`, or test Xvfb process remained, and the observed packaged ports were clear. This is positive graceful test cleanup evidence, not proof of user-session suspend/reboot behavior.

## Browser/UI fixture smoke

Command:

```bash
export PATH="$PWD/.cache/linux-dev-toolchain/bun-1.3.14-x64/bin:$PWD/.cache/linux-dev-toolchain/node-24.15.0-x64/bin:$PATH"
export ELIZA_NODE_PATH="$PWD/.cache/linux-dev-toolchain/node-24.15.0-x64/bin/node"
export ELIZA_UI_SMOKE_DISABLE_VIDEO=1
bun run --cwd packages/app test:e2e test/ui-smoke/runtime-configurability.spec.ts --project=chromium
```

Result: **2/2 passed in 3.3 minutes**. It demonstrated the deterministic production-renderer fixture exposing Cloud, Local, and Remote choices; Local advanced to its provider choices; and the first-run surface survived browser back/forward churn. This is browser/fixture evidence only: routes were mocked, no native package/SSH/real remote host/provider/device was used.

## Binary/runtime inspection

- `file`: launcher is static x86-64 ELF; embedded Bun and native libraries are x86-64 dynamic ELFs.
- Representative `ldd` targets: embedded Bun, `libNativeWrapper.so`, CEF `libcef.so`, `libwebgpu_dawn.so`, and GNU keyring `.node`; **no missing dependency** on this host.
- `libNativeWrapper.so` uses `$ORIGIN:$ORIGIN/cef`; CEF uses `$ORIGIN`; the five bundle symlinks are relative and non-broken.
- Native GNU keyring module loaded read-only with embedded Bun and exposed `AsyncEntry`, `Entry`, and related exports. No credential was read or written.
- Filename-only sensitive-file inventory found only examples/source modules such as `.env.example`; no real `.env`, private-key filename, setuid, or setgid payload was found. File contents containing possible credentials were intentionally not searched or printed.

## Evidence boundaries and remaining work

Proven on this host:

- The in-place packaged launcher starts under Xvfb, creates native window/tray bridge state, makes loopback API requests, renders at least the launcher/home UI, captures physical pixels, bridges notifications, and cleans up test processes.
- Representative artifact dynamic dependencies resolve on this Debian forky machine.
- Deterministic Chromium runtime-choice UI behavior passes.

Not proven:

- Install/upgrade/uninstall/reinstall from a Linux release artifact.
- Sandboxed renderer operation, loopback-only IPC, or safe multiuser filesystem permissions.
- Physical GNOME/Wayland placement, tray, shortcuts, suspend/resume, reboot persistence, update flow, camera/microphone/speaker selection, Bluetooth, SSH host-key enrollment, second-device/WAN operation, real provider response, or live voice.
- Exactly-once remote command execution, disconnect/reconnect, ambiguous-crash handling, revoke/expiry, multi-controller contention, or cleanup after partial failure.

Required before production/demo sign-off:

1. Retain the now-verified loopback listener and writable-mode build gates in every packaging path; re-run the broad packaged suite against the hardened artifact.
2. Establish a supported CEF sandbox strategy on Linux. The rebuilt artifact still launches every observed CEF child with sandbox-disabling flags.
3. Produce an installable, version-consistent release artifact and test clean install/reinstall on every claimed distribution; document the GLIBC/system-library floor.
4. Update packaged tests to intentionally handle the permission-priming modal, current hotkey lifecycle, and headless bottom-bar geometry; strengthen launch screenshot quality so a black frame plus handle cannot pass.
5. Fix the null `sweepExpired` request path and determine why WebView localStorage did not persist before graceful relaunch.
6. Run the real hardware/provider/device/WAN/SSH/voice matrix separately; do not promote the browser or Xvfb results into those evidence tiers.
