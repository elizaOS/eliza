# elizaOS OS

This repository owns elizaOS operating-system distributions. It is the
canonical home for the AOSP fork, the Debian-based live distribution,
installers, platform image tooling, and OS release automation.

## Repository layout

```text
android/          AOSP vendor tree, products, policy, and system UI
linux/            Debian workstation images and package builds
setup/            AOSP flashing application
usb-installer/    Cross-platform USB imaging application
toolchains/       OS compiler and runtime build inputs
scripts/          Build, validation, and release orchestration
```

The framework, Android/iOS applications, native bridges, native plugins, and
local inference remain in [`elizaOS/eliza`](https://github.com/elizaOS/eliza).
Published application artifacts and `@elizaos/*` packages are the dependency
boundary consumed by OS image builds.

## Development

```bash
bun install
bun run build
bun run typecheck
bun run test
bun run verify:linux
```

Platform image builds require their native toolchains. See
`android/README.md` and `linux/README.md` for the AOSP,
Cuttlefish, Docker, QEMU, and live-build requirements. Set
`ELIZAOS_ELIZA_ROOT` to an `elizaOS/eliza` checkout when an image build consumes
application or native-plugin sources.
