# LLVM trunk pin for the e1 RISC-V toolchain

This document is the source of truth for which LLVM commit, build flags, and
patches the e1 chip toolchain consumes. The corresponding machine-readable pin
lives in [`compiler/llvm-build/llvm-pin.json`](../../compiler/llvm-build/llvm-pin.json)
and is consumed by `scripts/build_llvm_riscv.sh`.

## Why LLVM trunk

- RVA23 mandatory extensions (`V`, `Zicboz`, `Zicbom`, `Zicfilp`, `Zicfiss`,
  `Zihintntl`, `Ztso`, `Zacas`, `Zfh`, `Zvfh`, `Zvbb`) landed progressively
  across LLVM 19-23. Trunk is the only branch that contains every RVA23
  feature plus the active cost-model and predicate-vectorization work.
- RVV 1.0 autovec quality is improving release over release. Igalia tracked a
  ~9% geomean uplift across 16 kernels in 18 months; this is upstream-trunk
  velocity, not backport velocity.
- AArch64-shared VLA scaffolding lands first in trunk. RVV inherits because
  the IR layer is the same.
- ThinLTO, BasicBlockSections + Propeller infrastructure, Machine Function
  Splitter, and the BOLT post-link pipeline all evolve in trunk.

## Pin refresh policy

- Trunk SHA is refreshed quarterly from a tested green commit on `main`.
- The selected SHA is recorded in `compiler/llvm-build/llvm-pin.json` under
  `upstream.commit_sha` and printed by `build_llvm_riscv.sh` into
  `build/reports/compiler/llvm-build-sha.txt`.
- The minimum acceptable release floor is `llvm-21`. Any older release SHA is
  rejected by `scripts/check_compiler_versions.py`.

## Build environment (canonical)

- Linux x86_64 (or aarch64) container built from `packages/chip/Dockerfile`.
- The macOS arm64 host CAN build clang itself, but it cannot link against
  glibc-targeted RISC-V userspace. The cross-compiled RVA23 sample target
  used as evidence requires `gcc-riscv64-linux-gnu` sysroot, available only
  inside the Linux container. The host build is therefore non-canonical and
  fails closed in `build_llvm_riscv.sh` with `BLOCKED llvm.environment_check`.

## Build recipe (two-stage)

`scripts/build_llvm_riscv.sh` performs:

1. **Stage 1 host bootstrap.** Build clang + lld with the system compiler, no
   PGO. Produces `build/llvm-stage1/bin/clang`. Used solely to bootstrap a
   self-host stage 2.
2. **Stage 2 self-host with cross targets.** Build clang + lld + clang-tools-extra
   plus runtimes (compiler-rt, libcxx, libcxxabi, libunwind) targeting both
   the host and `riscv64-unknown-linux-gnu`. ThinLTO is enabled at the LLVM
   build level. Produces `build/llvm-stage2/bin/clang`, the toolchain that
   the rest of the e1-chip flow consumes.

A future `stage 3` may apply AutoFDO+Propeller+BOLT to the LLVM build itself,
landing 10-15% compile-time wins (per published Google data); this is not yet
in the pinned recipe.

## RVA23 patches

The pin file's `rva23_patches.active` is empty by intent: the current trunk
SHA already contains every RVA23 mandatory extension. Any future deviation
must:

1. Add the patch file under `compiler/llvm-build/patches/<NNN>-<topic>.patch`.
2. List it in `rva23_patches.active` with `upstream_review_url` and `rationale`.
3. Update this section with the patch summary and the gate that consumes it.

## Default target flags

The toolchain emits the following baseline for every Android RVA23 build:

```sh
clang \
  --target=riscv64-unknown-linux-gnu \
  -march=rva23u64 -mcpu=eliza-e1 -mtune=eliza-e1 \
  -O3 -flto=thin -fvectorize \
  -fbasic-block-sections=labels \
  -fcf-protection=full \
  -fstack-clash-protection \
  -fstack-protector-strong \
  -fsanitize=shadow-call-stack
```

Profile attachment for AutoFDO+Propeller+BOLT is documented in
[`autofdo-propeller-bolt.md`](autofdo-propeller-bolt.md).

## Status

- **BLOCKED until canonical build executed in container.** The pin file's
  `upstream.commit_sha` is the placeholder `TODO_PIN_LLVM_SHA_FROM_CONTAINER_BUILD`.
  No release-grade compiler evidence will be accepted until
  `scripts/build_llvm_riscv.sh` runs to completion in the Linux container and
  the resolved SHA is written into the pin file.
- The recipe is checked-in regardless so the build is reproducible from a
  single repo SHA + the container digest.

## Refresh procedure

1. From inside the container: `cd external/llvm-project && git fetch origin main`.
2. Pick a green commit (`llvm/llvm-test-suite` nightly + Phabricator status).
3. Update `compiler/llvm-build/llvm-pin.json` `upstream.commit_sha`.
4. Run `scripts/build_llvm_riscv.sh` end-to-end inside the container.
5. Commit the new SHA, updated `build/reports/compiler/llvm-version.txt`, and
   `docs/evidence/compiler/llvm-build-evidence.yaml`.
6. Cross-check with `make rva23-compliance` to confirm the toolchain emits the
   RVA23 baseline.

## Cross-references

- Build script: `scripts/build_llvm_riscv.sh`.
- Pin file: `compiler/llvm-build/llvm-pin.json`.
- Evidence gate: `docs/evidence/compiler/llvm-build-evidence.yaml`.
- Compliance check: `scripts/check_rva23_compliance.py`.
- PGO/Propeller/BOLT: `docs/toolchain/autofdo-propeller-bolt.md`.
- Reproducibility policy: `docs/toolchain/reproducibility.md`.
