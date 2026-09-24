# Bun riscv64 patches

This directory holds the Bun-side patches that have to land on top of `oven-sh/bun @ ${BUN_TAG}` (see `../bun-version.json:bun.tag`) so the build system accepts `riscv64-linux-musl` as a target.

This directory is part of `packages/os`.

Build from the repository root:

```bash
bun run --cwd packages/os build
```

Test from the repository root:

```bash
bun run --cwd packages/os test
```
