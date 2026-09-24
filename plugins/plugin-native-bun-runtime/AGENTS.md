# @elizaos/capacitor-bun-runtime

Capacitor plugin that bridges the React UI to an embedded Bun-shape JS runtime on iOS and Android, letting an Eliza agent run locally on a mobile device.

Preserve the native bridge ABI and explicit runtime-mode selection. Device/store builds require the no-JIT engine; never silently fall back when the requested engine is missing.

Build, test, and setup: [README.md](README.md).
