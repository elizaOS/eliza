# RISC-V 64 cross-build smoke harness

Two scripts wire up a one-shot **build → QEMU smoke → JSON report**
pipeline for every riscv64 native artifact the repo ships:

| script                                 | role                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| `scripts/build-riscv64-artifacts.sh`   | drive every cross-build that produces a riscv64 ELF               |
| `scripts/check-riscv64-artifacts.sh`   | exercise each produced artifact under `qemu-riscv64-static`       |

Both wrappers are exposed at the repo root as bun scripts:

```bash
ELIZA_RISCV64_SMOKE=1 bun run build:riscv64-artifacts
ELIZA_RISCV64_SMOKE=1 bun run check:riscv64-artifacts
```

With `ELIZA_RISCV64_SMOKE` unset they are intentional no-ops — that
keeps the default CI lane cheap, and the smoke is gated to riscv64-
specific branches / workflow_dispatch runs.

The smoke harness writes a machine-readable report to
`build/reports/riscv64_artifacts.json`. Top-level shape:

```json
{
  "generated_at": "2026-…",
  "summary": {"pass": 53, "fail": 0, "skip": 0},
  "final_status": "PASS",
  "artifacts": [
    {"path": "…/libqjl.a", "kind": "static-archive", "status": "PASS", "detail": "…", "duration_ms": 0},
    {"path": "…/qjl_int8_smoke", "kind": "executable", "status": "PASS", "detail": "qemu exit=0", "duration_ms": 412},
    …
  ]
}
```

## What's exercised

- **Native plugins** (`packages/native/plugins/<pkg>/build/riscv64/`)
  for `qjl-cpu`, `polarquant-cpu`, `turboquant-cpu`, `silero-vad-cpp`,
  `voice-classifier-cpp`, `wakeword-cpp`, `yolo-cpp`, `face-cpp`,
  `doctr-cpp`. Each plugin contributes one `.a`, an optional `.so`,
  and a handful of GoogleTest-driven smoke executables.

- **`libllama` + `libggml` family + `libeliza-llama-shim.so`** —
  MTP llama.cpp cross-build via
  `packages/app-core/scripts/aosp/compile-libllama.mjs --target
  linux-riscv64-cpu` and `--target android-riscv64-cpu`.

- **`libsigsys-handler.so`** for riscv64 — the Bun seccomp shim,
  built by `packages/app-core/scripts/aosp/compile-shim.mjs --abi
  riscv64` into `~/.cache/eliza-android-agent/seccomp-shim/riscv64/`.

## Operator recipe (Debian/Ubuntu)

```bash
# 1. Toolchain.
sudo apt-get update
sudo apt-get install -y \
    qemu-user-static binfmt-support \
    cmake build-essential \
    file binutils
# Zig 0.14+ — pick the release for your host arch.
curl -fsSL https://ziglang.org/download/0.14.0/zig-linux-x86_64-0.14.0.tar.xz \
    | sudo tar -C /opt -xJ
sudo ln -sf /opt/zig-linux-x86_64-0.14.0/zig /usr/local/bin/zig
zig version       # → 0.14.0

# 2. Optional: Android NDK r27+ (only needed for android-riscv64-cpu).
#    Skip this if you're only validating the Linux riscv64 lane.
curl -fsSL https://dl.google.com/android/repository/android-ndk-r27c-linux.zip -o ndk.zip
unzip -q ndk.zip -d /opt
export ANDROID_NDK_HOME=/opt/android-ndk-r27c

# 3. Smoke.
cd /path/to/eliza
ELIZA_RISCV64_SMOKE=1 bun run build:riscv64-artifacts
ELIZA_RISCV64_SMOKE=1 bun run check:riscv64-artifacts
jq '.summary, .final_status' build/reports/riscv64_artifacts.json
```

## QEMU-only run (skip the build phase)

If sister-agent worktrees have already cross-compiled the artifacts and
the on-disk paths are still present, you can run the smoke harness
alone:

```bash
ELIZA_RISCV64_SMOKE=1 bun run check:riscv64-artifacts
```

Missing artifacts are reported as `SKIP` records with a reason, not
`FAIL` — so the harness is safe to re-run incrementally as each
upstream build comes online.

## ELF-tag-only mode (no QEMU)

For tier-1 smoke that only validates *every artifact is the right ELF
arch* (cheap, ~seconds, no QEMU required):

```bash
ELIZA_RISCV64_SMOKE=1 bash scripts/check-riscv64-artifacts.sh --no-qemu
```

This mode confirms `ELF 64-bit LSB ... UCB RISC-V ... double-float ABI`
on every shared library + executable and inspects `.a` archive members,
but does not run any executable.

## Exit codes

| code | meaning                                          |
| ---- | ------------------------------------------------ |
| 0    | every artifact PASSed or SKIPped with reason     |
| 1    | at least one artifact FAILed                     |
| 2    | invalid CLI args / missing toolchain (build-only)|

## CI integration

`.github/workflows/riscv64-smoke.yml` runs the full build + smoke on:

- `workflow_dispatch` (manual trigger).
- Any branch with the `riscv64` label applied to its PR.

The smoke is **not** a required check on `develop` PRs. It is opt-in
because (a) the build takes ~30-60 min on a typical CI runner and
(b) the upstream `oven-sh/bun#6266` blocker for the Bun riscv64
binary is independent of this work.

## Why two scripts (not one)

Splitting build from check has three concrete benefits:

1. **Cache awareness.** If sister-agent worktrees pre-built artifacts
   into the canonical paths (`packages/native/plugins/*/build/riscv64/`,
   `build/riscv64-stage/riscv64/`, etc.), the build phase no-ops and
   the smoke phase exercises what's already on disk. No double work.
2. **CI cost.** A workflow can run *just* the smoke on a runner that
   has the artifacts pre-staged, e.g. via an artifact upload from a
   prior build job.
3. **Local dev.** When iterating on a single plugin's RVV kernels you
   only need `bash scripts/check-riscv64-artifacts.sh`; the build
   driver doesn't get in the way.
