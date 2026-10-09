# @elizaos/capacitor-bun-runtime

iOS Bun engine build and verification tools for the native runtime bridge.

Requires the iOS-capable Bun source tree. Device/store slices must remain no-JIT and cannot expose process spawning, dynamic code loading, or package installation.

This directory is part of `plugins/plugin-native-bun-runtime`.

Build from the repository root:

```bash
bun run --cwd plugins/plugin-native-bun-runtime build
```

Test from the repository root:

```bash
bun run --cwd plugins/plugin-native-bun-runtime test
```
