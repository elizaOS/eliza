# Bun RISC-V cross-build

Run `packages/os/toolchains/bun-riscv64/run-build.sh --jobs 4` from the repository
root. The Docker builder compiles the pinned Rust Bun and C-loop WebKit into
`dist/bun-linux-riscv64-musl.zip`, then runs its QEMU smoke checks.

Source, toolchain and patch hashes live in `bun-version.json`. Run
`node packages/os/toolchains/bun-riscv64/validate.ts` to verify patch integrity
and application against the pinned sources before building. Patch validation
alone does not qualify a runtime artifact. The Android agent stager consumes
hosted artifacts through `ELIZA_BUN_RISCV64_URL`.
