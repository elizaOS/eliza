# Software Stack, Performance, CI, and Reproducibility Work Order

## firmware boot

Firmware boot claims require OpenSBI/U-Boot or equivalent source, build logs,
device-tree handoff, boot transcript, and failure-mode evidence.

## Android BSP

Android BSP claims require external AOSP tree logs, vendorimage output,
checkvintf, SELinux neverallow/build logs, CTS/VTS intake, and virtual-device
or target smoke transcripts.

## benchmark

Benchmark claims require real tool execution, calibrated metadata, model
artifacts, power/thermal context, parsed metrics, unsupported op count, and CPU
fallback percentage. Dry-run reports stay blocked.

## CI gates

CI gates must preserve fail-closed behavior: missing tools, missing external
trees, and missing hardware evidence produce blocked status instead of inferred
pass status.

## compiler tuning

Compiler claims require the stack defined in
[`docs/toolchain/llvm-trunk-pin.md`](../toolchain/llvm-trunk-pin.md) and
[`docs/toolchain/autofdo-propeller-bolt.md`](../toolchain/autofdo-propeller-bolt.md).
The full stack is:

```
LLVM trunk (pinned SHA, RVA23U64 baseline)
  + RVV 1.0 intrinsics + ThinLTO
  + AutoFDO (-fprofile-sample-use=...)
  + Propeller (lld --symbol-ordering-file=... --no-keep-text-section-prefix)
  + BOLT (llvm-bolt --reorder-blocks=ext-tsp --reorder-functions=hfsort+
                    --split-functions --split-all-cold)
  + Machine Function Splitter (-fsplit-machine-functions, in-tree)
  + CFI defaults: -fcf-protection=full (Zicfilp / Zicfiss)
                  -fstack-clash-protection
                  -fstack-protector-strong
                  -fsanitize=shadow-call-stack
```

Spectre/SLS mitigations under Linux 6.19+ cost 5-10% in tight loops on
RISC-V; the 12-18% raw uplift narrows to a 5-10% net win for security-on
builds. Plan for the cost; do not disable the mitigations.

### Evidence gates (fail-closed)

- [`docs/evidence/compiler/llvm-build-evidence.yaml`](../evidence/compiler/llvm-build-evidence.yaml)
- [`docs/evidence/compiler/iree-backend-evidence.yaml`](../evidence/compiler/iree-backend-evidence.yaml)
- [`docs/evidence/compiler/executorch-evidence.yaml`](../evidence/compiler/executorch-evidence.yaml)
- [`docs/evidence/compiler/autofdo-evidence.yaml`](../evidence/compiler/autofdo-evidence.yaml)
- [`docs/evidence/compiler/baseline-profile-evidence.yaml`](../evidence/compiler/baseline-profile-evidence.yaml)
- [`docs/evidence/compiler/quantization-evidence.yaml`](../evidence/compiler/quantization-evidence.yaml)
- [`docs/evidence/compiler/rva23-compliance.yaml`](../evidence/compiler/rva23-compliance.yaml)
- [`docs/evidence/compiler/aosp-branch-pin.yaml`](../evidence/compiler/aosp-branch-pin.yaml)

### NPU compiler path

The MLIR/IREE `elizanpu` dialect at
[`compiler/iree-eliza-npu/`](../../compiler/iree-eliza-npu/) is the only
production NPU codegen path. The Python "lowering smoke" at
[`compiler/runtime/e1_npu_lowering.py`](../../compiler/runtime/e1_npu_lowering.py)
is the test oracle, not the codegen path.

ExecuTorch is the PyTorch entry; LiteRT / TFLite is the second entry via
NNAPI / AIDL HAL. Both lower through the elizanpu IREE backend.

### Quantization

Five formats target the elizanpu dialect, calibration toolkit at
[`compiler/quantization/`](../../compiler/quantization/) (PTQ INT8, AWQ INT4,
GPTQ INT4 fallback, FP8 E4M3, 2:4 structured sparse INT4, INT2 BitNet).

### Reproducibility

- LLVM SHA pinned: `compiler/llvm-build/llvm-pin.json`.
- IREE SHA pinned: `compiler/iree-eliza-npu/iree-pin.json`.
- ExecuTorch SHA pinned: `compiler/executorch-eliza/executorch-pin.json`.
- AOSP branch SHA pinned: `compiler/aosp/manifest.xml` (BLOCKED until
  Google's RVA23 Tier 1 branch is stable).
- Container base digest pinned: `Dockerfile UBUNTU_DIGEST`.
- LLVM build sub-image: `compiler/llvm-build/Dockerfile` (derives from the
  main container, adds lld + ccache + lit + libxml2/libzstd dev headers).
- Host is macOS arm64 (per `docs/toolchain/riscv64-cross-host.md`); the
  canonical compiler environment is the Linux container built from this
  repo's `Dockerfile`.

### Cross-domain hookup table

The compiler stack pins must agree with every downstream consumer. This
table is the single registry: any new consumer of a pinned SHA goes here
and must reference the same value as the source-of-truth file. When a
SHA is refreshed, every row must be updated in lockstep in the same
commit.

| Pin                       | Source of truth                                    | Current value (as of 2026-05-19)                                   | Downstream consumers                                                                                                                                                                                       |
|---------------------------|----------------------------------------------------|--------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| LLVM trunk                | `compiler/llvm-build/llvm-pin.json`                | `de3ee84346d6dcf77ac20fe5c8acc95594886cbc`                         | `benchmarks/cpu/spec/manifest.json::compiler_target.compiler_pin_commit_sha`, `benchmarks/cpu/coremark/manifest.json::build_target.primary_compiler.pin_commit_sha`, `docs/evidence/compiler/llvm-build-evidence.yaml::pinned_sha`, `scripts/build_llvm_riscv.sh` (40-char hex validator) |
| IREE                      | `compiler/iree-eliza-npu/iree-pin.json`            | `d9a3dd15a552cdded3bda4fcfa65f1341d2b5f92`                         | `docs/evidence/compiler/iree-backend-evidence.yaml::pinned_sha`, `scripts/build_iree_eliza_npu.sh` (40-char hex validator), `compiler/iree-eliza-npu/CMakeLists.txt` (target backend selection)                                                                            |
| ExecuTorch                | `compiler/executorch-eliza/executorch-pin.json`    | `5eb84927cb9380f2a56d1f39f28d799dd7573254`                         | `docs/evidence/compiler/executorch-evidence.yaml::pinned_sha`, `compiler/executorch-eliza/backend/__init__.py`                                                                                            |
| AOSP RISC-V platform      | `compiler/aosp/manifest.xml`                       | `BLOCKED_AOSP_RISCV_BRANCH_SHA_PENDING_UPSTREAM_TIER1`             | `docs/evidence/compiler/aosp-branch-pin.yaml`, `scripts/check_rva23_compliance.py::rva23.aosp_branch_pin`                                                                                                  |
| NPU C ABI hash            | `compiler/iree-eliza-npu/runtime/eliza_npu_runtime.h` | `sha256:75fef5a82295a5584dae44cb9d6ac145d2d2d6c90f1c3765fc70c2452ed5c6a5` (recomputed by `scripts/check_compiler_versions.py`) | `compiler/runtime/e1_npu_runtime.py` (Python oracle), `rtl/npu/e1_npu.sv` (AXI-Lite decode), `compiler/iree-eliza-npu/tests/test_runtime_mmio_parity.py` (drift sentinel) |

Cross-domain integration tests:

- `compiler/iree-eliza-npu/tests/test_descriptor_parity.py` — 1280-case parity
  test (16 opcodes × 4 offsets × 4 byte counts × 2 owner flags, with bounds
  skip) covering the descriptor word-0 packing between Python oracle and C
  runtime.
- `compiler/iree-eliza-npu/tests/test_runtime_mmio_parity.py` — 136 cases
  covering register addresses, opcode values, DESC_STATUS bits, DESC_FLAG
  bits, and constants across Python / C header / SystemVerilog RTL decode.
- `compiler/quantization/tests/test_awq_int4_mlp_e2e.py` — 5 cases wiring
  the AWQ INT4 calibrator to a 2-layer MLP that fits the bounded `GEMM_S4`
  prototype window (M,N <= 3, K <= 7, 64-byte scratchpad).
- `compiler/autofdo-harness/coremark_roundtrip.sh` — AutoFDO end-to-end
  capture + reapply on CoreMark, BLOCKED until the LLVM stage-2 toolchain
  is built. Produces `build/reports/compiler/coremark-autofdo/coremark-autofdo-delta.json`.
- `benchmarks/compiler/autovec/kernels.{c,json}` — 30 RVV autovec kernels;
  `scripts/run_rvv_autovec_suite.py --stock-clang=/usr/bin/clang` writes
  `build/reports/compiler/autovec-trunk-vs-stock.{json,md}` with geomean
  delta between the trunk pin and the apt-installed clang.

### NPU MMIO contract: source of truth chain

The e1 NPU MMIO contract has three encodings that must agree:

1. `compiler/runtime/e1_npu_runtime.py::E1NpuRuntime` — Python oracle. The
   class constants are the canonical byte addresses (`OP_A` = 0x10020000,
   `RESULT_HI` = 0x10020018, ...) and the canonical bit layouts
   (`DESC_FLAG_VALID_OWNER` = 1<<31, `DESC_STATUS_WRITEBACK_UNSUPPORTED`
   = 1<<7, ...).
2. `compiler/iree-eliza-npu/runtime/eliza_npu_runtime.h` — C ABI. Every
   register offset declared as `ELIZA_NPU_REG_*` and every opcode declared
   as `ELIZA_NPU_OP_*` is matched against the Python oracle by
   `test_runtime_mmio_parity.py`.
3. `rtl/npu/e1_npu.sv` — AXI-Lite address decode. The SV case statements
   use word indices (`6'h00` through `6'h2C`). Each Python byte address
   maps to the SV word index `byte_offset // 4`. The parity test
   enforces this with a regex check.

A drift between any pair fails CI immediately at the parity test layer,
before any LLVM build or IREE lowering is even attempted. This is the
cheapest possible "contract drift detector" — no compilation required.
