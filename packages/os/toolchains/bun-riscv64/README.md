# Bun riscv64-linux-musl cross-build pipeline

Produces the `bun-linux-riscv64-musl.zip` artifact consumed by the Android agent staging step (`stage-android-agent.ts`) when `ELIZA_BUN_RISCV64_URL` points at a hosted copy.

This directory is part of `packages/os`.

Build from the repository root:

```bash
bun run --cwd packages/os build
```

Test from the repository root:

```bash
bun run --cwd packages/os test
```
