# @elizaos/plugin-native-filesystem

Mobile-safe filesystem bridge for the elizaOS runtime.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-filesystem build  # build
bun run --cwd plugins/plugin-native-filesystem test   # tests
```

Android/AOSP Bun service E2E (after the app's `android-native-agent.ts` lane stages the runtime):

```bash
node packages/app/scripts/android-native-filesystem.ts --serial emulator-5554 --runtime-dir test-results/android-native-agent/stage/app/src/main/assets/agent/x86_64
```

This uses the production service on a stock x86_64 emulator and verifies Unicode
and binary persistence across processes, listing, overwrite, missing files, and
path/symlink rejection. Full results go to `test-results/android-native-filesystem/`.
It runs under the shell UID; Capacitor and installed-app sandbox behavior need
separate tests. Device E2E runs this after the embedded-agent lifecycle lane.
