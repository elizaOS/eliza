# @elizaos/setup

Electrobun desktop app for flashing elizaOS AOSP builds onto Pixel devices via ADB and fastboot.

Discovery authenticates signed v2 releases through the shared Android executor
and retains the original manifest bytes plus every installation and recovery file.
Linux installation delegates device transitions, writes and authenticated runtime
checks to that executor. Install the release's digest-pinned `adb` and `fastboot`
in one directory, and configure the backend's `ELIZAOS_ANDROID_HEALTH_TOKEN_FILE`
with the private file containing the installed agent's bearer credential. Unlock
the bootloader through the separate guide and reconnect stock Android first.
Each attempt retains its journal and log under `~/.elizaos/flasher/installations`;
success requires a matching runtime-verification receipt. The complete desktop
flow still requires physical-device qualification. Legacy manifests cannot
authorize installation.

Downloaded installation and recovery files stay in private per-attempt directories
under `~/.elizaos/flasher/downloads`. Verified files never replace existing entries.

Install workspace dependencies with `bun install` at the repository root.

Build from the repository root:

```bash
bun run --cwd packages/os/setup build
```

Test from the repository root:

```bash
bun run --cwd packages/os/setup test
```
