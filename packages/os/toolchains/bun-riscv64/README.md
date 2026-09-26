# Bun RISC-V cross-build

From the repository root, use the Docker host wrapper:

```bash
packages/os/toolchains/bun-riscv64/run-build.sh --jobs 4
```

Pins are in `bun-version.json`; output is `dist/bun-linux-riscv64-musl.zip` with
checksums and a build transcript. The default uses C-loop. `--baseline-jit` and
`--rust-core` select experimental paths; use `--help` for wrapper options.
The Android agent stager consumes a hosted artifact through `ELIZA_BUN_RISCV64_URL`.
