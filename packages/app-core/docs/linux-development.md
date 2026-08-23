# Linux development and desktop parity

This guide is the reproducible Linux entry point for the elizaOS monorepo. It
covers the browser application, local agent runtime, voice prerequisites, and
the Electrobun desktop package. The separately maintained bootable Linux/AOSP
distribution lives in `elizaOS/os`; this repository owns the application and
runtime layers that run on an ordinary Linux host.

## Bootstrap and doctor

From a fresh checkout, run one command:

```bash
bash scripts/bootstrap-linux-dev.sh
```

The bootstrap detects Linux x64 or arm64, downloads the repository's exact Bun
1.3.14 and Node 24.15.0 archives into the ignored
`.cache/linux-dev-toolchain/` directory, verifies pinned SHA-256 digests,
installs the locked workspace with `bun install --frozen-lockfile`, and runs the
strict Linux doctor. It does not invoke `sudo`, install system packages, read
credential values, or change global tool versions.

Useful follow-ups:

```bash
bash scripts/bootstrap-linux-dev.sh --doctor-only
bun run linux:doctor -- --json
bash scripts/bootstrap-linux-dev.sh --skip-install
```

The bootstrap's repository-local PATH exists only for that command. Running
`bun run linux:doctor` directly is still useful when intentionally auditing the
ambient shell, but it will fail the pin checks if that shell resolves a
different Bun or Node version. The doctor records only non-secret host facts:
distro, kernel, architecture, desktop/session, memory and swap, GPU summary,
filesystem capacity, package manager, container-engine reachability, readable
firewall state, toolchain pin comparison, and the authenticated GitHub account
name. It never prints token values or scopes and never escalates privileges.

The doctor reports exact remediation commands for missing system packages. A
warning is a capability that is not required for the base build (for example,
Docker or development headers for optional native integrations); a failure
blocks a supported Linux build or its required test harness.

## Evidence-backed Linux baseline

The current native desktop evidence is **Linux x86_64 only**. The candidate was
built and exercised on an x86_64 Debian forky/sid GNOME host; automated native
pixels used Xvfb/X11, while owner-visible GNOME/Wayland inspection remains a
separate physical gate. The pinned Electrobun native wrapper requires at least
`GLIBC_2.38`. Direct packages also require compatible GTK 3, WebKitGTK 4.1,
JavaScriptCoreGTK 4.1, Soup 3, Ayatana AppIndicator, and the other libraries
reported by `ldd bin/libNativeWrapper.so`. Local Vulkan inference additionally
requires a working Vulkan loader/driver.

This is a compatibility floor, not a blanket distribution claim. A distro is
release-supported only after a clean dependency-resolving install, packaged
launch, upgrade/uninstall lifecycle, and physical desktop pass on that distro.
The Debian Bookworm root used to build portable inference proves the inference
ABI floor; it does not prove that the GLIBC 2.38 Electrobun wrapper runs on
Bookworm's older glibc.

The bootstrap contains arm64 toolchain pins and the source has arm64 build
paths, but no arm64 desktop artifact or packaged launch has been verified.
Treat arm64 as source-declared and **unverified**, not release-supported, until
an arm64 host completes the same artifact, ABI, dependency, launch, and
physical-desktop evidence tiers.

## Supported surfaces

| Surface | Linux support | Proof boundary |
|---|---|---|
| Browser application | Supported | Production Vite build plus browser smoke/e2e |
| Local agent/API runtime | Supported | Source build, typecheck, runtime health, and real request flow |
| Electrobun desktop, x86_64 | Candidate verified on the host and ABI baseline above | Packaged artifact, Xvfb launch, dependency/lifecycle test, then physical desktop evidence |
| Electrobun desktop, arm64 | Source-declared; unverified | Real arm64 artifact, ABI/dependency audit, packaged launch, and physical desktop evidence |
| Browser and desktop voice capture/playback | Supported when devices and provider/runtime are configured | Real microphone, ASR, agent turn, TTS, and observed output evidence |
| Local inference | Optional native capability | A package built with `--build-fused-lib` and a real model request |
| Advanced SSH runtime | SSH client/server prerequisites are supported | Host-key-pinned tunnel and remote-runtime integration evidence |
| Bootable elizaOS Linux/AOSP image | Separate repository | Image build and physical/virtual device evidence in `elizaOS/os` |

A successful build is not live-provider or physical-device proof. Synthetic
voice tests, Xvfb desktop launches, browser tests, real audio hardware, and
remote-host tests are recorded as separate evidence tiers.

## Build and run

Prepare all workspace packages, then build the browser renderer:

```bash
bun run dev:prepare
bun run --cwd packages/app build
```

Build a full local-runtime Electrobun package:

```bash
bun run --cwd packages/app-core/platforms/electrobun build
```

The Linux development artifact is written below
`packages/app-core/platforms/electrobun/build/dev-linux-<arch>/Eliza-dev/`.
The build intentionally requires at least 8 GiB of free space before staging
the embedded runtime. Plain development builds omit the fused local-inference
library; request and verify that capability explicitly:

```bash
bun run --cwd packages/app-core/platforms/electrobun build -- --build-fused-lib
```

Run the local web/runtime stack with:

```bash
bun run dev
```

Run the packaged desktop launch proof after building:

```bash
bunx playwright test \
  --config packages/app/playwright.electrobun.packaged.config.ts \
  packages/app/test/electrobun-packaged/desktop-launch-render.e2e.spec.ts
```

The packaged harness uses a dedicated Xvfb display by default on Linux, keeps
the app's stdout/stderr, and asserts a current revision stamp plus non-blank
renderer output. Use the current interactive display only when the test or
capture explicitly requires it.

## Voice evidence

Unit and synthetic media tests validate codec, worklet, cancellation, and UI
behavior, but do not prove the live chain. The packaged live voice gate requires
all of the following:

- a real app-core API base;
- distinct microphone and speaker device identifiers;
- a capture session identifier that binds external hardware evidence;
- ASR, one agent SSE turn, local TTS, playback, and observed output;
- the current packaged revision and renderer build stamp.

Run the repository's voice matrix or the focused packaged self-test only after
those prerequisites are configured. Do not replace a missing microphone,
provider, local model, or output observation with a mocked success claim.

## Host and network boundaries

- Desktop API/UI ports are dynamically allocated by the app-core platform
  scripts; do not hardcode a shared development port.
- Remote API listeners should remain loopback-only unless an authenticated,
  explicitly scoped transport exposes them.
- SSH host keys must be pinned and changed fingerprints must fail closed.
- Runtime credentials and private keys belong in a native keyring/Secret
  Service, never renderer storage or command arguments.
- Docker is needed for local Cloud/container lanes, not for the base browser or
  Electrobun build. An inactive Docker daemon is therefore a doctor warning.
- `pipewire` and `wireplumber` must be active for real desktop audio evidence;
  `/dev/snd` or `/dev/video*` presence alone is only device-discovery evidence.

## Troubleshooting

If the doctor reports a different Bun or Node version, rerun the bootstrap; do
not weaken the repository pin. If Electrobun fails to load a native library,
run `ldd` on `bin/libNativeWrapper.so` inside the package and install the exact
missing Debian package. If packaging stops for free space, remove only known
generated build/cache outputs after inspecting their paths; never clean or
reset a dirty checkout to make room.
