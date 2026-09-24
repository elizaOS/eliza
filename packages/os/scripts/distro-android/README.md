# scripts/distro-android — Brand-aware AOSP/Cuttlefish toolchain

This directory contains the toolchain for building a brand-customised Android AOSP image — Cuttlefish (virtual phone) for CI validation, and real device targets (Pixel codenames) for installs.

This directory is part of `packages/os`.

Build from the repository root:

```bash
bun run --cwd packages/os build
```

Test from the repository root:

```bash
bun run --cwd packages/os test
```
