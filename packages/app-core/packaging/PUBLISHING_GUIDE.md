# Publishing

The repository has one package-release authority:
`.github/workflows/release.yaml`. It is manually dispatched with an explicit
version and channel, validates the exact `develop` commit, builds the candidate
once, publishes it, and verifies the registry result before finalization.

Desktop, iOS, Android, Homebrew, Snap, Flatpak, and store distribution are not
child GitHub workflows. Operators build and verify those artifacts with the
commands in `packages/app` and `packages/app-core`, then upload them through the
appropriate store or release channel.

For the current end-to-end process and command inventory, see
[`../../docs/build-and-release.md`](../../docs/build-and-release.md).
