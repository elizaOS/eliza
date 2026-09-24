# WebKit riscv64 patches

This directory holds the WebKit-side patches that have to land on top of `oven-sh/WebKit @ ${WEBKIT_COMMIT}` (see `../bun-version.json:webkit.fork_commit`) to produce a buildable JavaScriptCore for `riscv64-unknown-linux-musl` with LLInt + Baseline JIT enabled.

This directory is part of `packages/os`.

Build from the repository root:

```bash
bun run --cwd packages/os build
```

Test from the repository root:

```bash
bun run --cwd packages/os test
```
