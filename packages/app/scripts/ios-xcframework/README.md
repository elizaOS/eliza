# iOS LlamaCpp.xcframework — runbook

This directory contains the iOS xcframework packager that the mobile build pipeline uses to glue per-target static archives produced by `packages/app/scripts/build-llama-cpp-mtp.mjs` into a well-formed `LlamaCpp.xcframework` consumed by the patched `llama-cpp-capacitor@0.1.5` Cocoapod.

This directory is part of `packages/app`.

Build from the repository root:

```bash
bun run --cwd packages/app build
```

Test from the repository root:

```bash
bun run --cwd packages/app test
```
