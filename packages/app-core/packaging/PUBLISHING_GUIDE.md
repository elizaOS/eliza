# Publishing

The repository has one npm package-release authority:
`.github/workflows/release.yaml`. It is manually dispatched with an explicit
version and channel, validates the exact `develop` commit, builds the candidate
once, publishes it, and verifies the registry result before finalization.

Electrobun desktop and Snap have independent, platform-specific workflows at
`.github/workflows/release-electrobun.yml` and
`.github/workflows/snap-publish.yml`; neither publishes the npm cohort. Other
mobile, desktop, and store artifacts are built and verified with the commands
in `packages/app` and `packages/app-core`, then uploaded through the appropriate
store or release channel.

Before distributing desktop artifacts, review the
[desktop regression inventory](../test/release-heavy-inventory.md) and complete
the [desktop release checklist](../test/release-regression-checklist.md) on the
target platform.

For the current end-to-end process and command inventory, see
[`../../docs/build-and-release.md`](../../docs/build-and-release.md).
