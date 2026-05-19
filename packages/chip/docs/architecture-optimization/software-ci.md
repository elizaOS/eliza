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
- AOSP branch SHA pinned: `compiler/aosp/manifest.xml` (BLOCKED until
  Google's RVA23 Tier 1 branch is stable).
- Container base digest pinned: `Dockerfile UBUNTU_DIGEST`.
- Host is macOS arm64 (per `docs/toolchain/riscv64-cross-host.md`); the
  canonical compiler environment is the Linux container built from this
  repo's `Dockerfile`.
