# ExecuTorch RISC-V / e1 NPU backend

ExecuTorch is the PyTorch-mobile-on-device runtime. As of the
ExecuTorch backend roster (Apple, Qualcomm, Arm, MediaTek, Vulkan, XNNPACK,
Cortex-M / CMSIS-NN as of v1.2.0), there is no open RISC-V NPU path. This
document specifies how the e1 NPU becomes the next backend, lowering PyTorch
ExportedPrograms through the [`elizanpu` IREE dialect](iree-eliza-npu.md).

## Pin

Tracked in [`compiler/executorch-eliza/executorch-pin.json`](../../compiler/executorch-eliza/executorch-pin.json):

- Tag: `v1.2.0` (released 2026-04-01).
- Commit: `0b0e2c5cdd67c8b4396a46ea1d1aa72ffb0128d7`.
- Previous: `5eb84927cb9380f2a56d1f39f28d799dd7573254` (main, 2026-Q1).
- Last audited: 2026-05-20.

v1.2.0 wins worth flagging:

- **Cortex-M + CMSIS-NN** is the closest upstream analog to our elizanpu
  delegate and is the reference we mirror for partitioner / preprocessor
  shape.
- **CSE export pass** runs at AOT, shrinking the graph before partitioning.
- **ARM Ethos-U SDK 26.02 + Vela 5.0.0** raises the embedded-NPU bar that
  our backend has to match for tape-out evidence.
- **Vulkan int8 quantized** gives a second open backend covering our int8
  op set — useful as a CPU-fallback cross-check during bring-up.
- **LoRA / MultimethodLoraConfig** unblocks multi-method `.pte` export for
  the adapter-swap inference path.
- **MPS backend is deprecated upstream** in v1.2.0. We do not depend on it
  (no `torch.backends.mps` / `MPSBackend` callsites in the chip package).
- Watching: PR #19617 (RISC-V CI matrix) and PR #18863 (Nordic AXON NPU
  draft — closest external analog to elizanpu, useful precedent for the
  delegate register + partition flow).

## Pipeline

```
torch.export.export(model) -> ExportedProgram
  -> ElizaPartitioner.partition_nodes(...)
       (NPU-resident subgraph + CPU fallback nodes)
  -> ElizaPreprocessor.preprocess(...)
       (elizanpu MLIR module per NPU partition)
  -> iree-compile --iree-hal-target-backends=elizanpu
       (per-partition .vmfb)
  -> ExecuTorch program builder
       (wraps .vmfb + CPU fallback nodes into a single .pte)
```

The partitioner whitelist mirrors the elizanpu op surface:

| aten op | Precisions | elizanpu lowering |
| --- | --- | --- |
| `aten.mm.default` | int8, int4_packed, int4_sparse_2_4 | tile -> `elizanpu.gemm_s8` (with rescale) |
| `aten.matmul.default` | int8, int4_packed, int4_sparse_2_4 | tile -> `elizanpu.gemm_s8` (with rescale) |
| `aten.bmm.default` | int8 | batch tile -> repeated `elizanpu.gemm_s8` |
| `aten.linear.default` | int8, int4_packed | canonicalize to mm + tile |
| `aten.relu.default` | int8 | `elizanpu.vrelu` on packed quartets |
| `aten.conv2d.default` | int8 | im2col + tile -> `elizanpu.gemm_s8` |

Anything not on the whitelist is left for CPU fallback. There is no silent
ignore: the partitioner records each unsupported op explicitly so the
final `.pte` is a fail-closed bound on what runs on the NPU.

## Build flow

1. `scripts/build_llvm_riscv.sh` — produces `build/llvm-stage2`.
2. `scripts/build_iree_eliza_npu.sh` — produces `build/iree/install/bin/iree-compile`.
3. `python -m compiler.executorch_eliza.tools.export <model.py>` — runs
   `torch.export.export`, partitions, preprocesses, invokes `iree-compile`,
   wraps into `.pte`. Tool script is BLOCKED until IREE is built.

## Status

- Op support whitelist: committed (`compiler/executorch-eliza/backend/eliza_op_support.py`).
- Partitioner: committed; 3 unit tests pass in repo CI.
- Preprocessor skeleton: committed; emits elizanpu MLIR placeholder.
- ExecuTorch pin: **v1.2.0** (2026-04-01), audited 2026-05-20.
- End-to-end PTE generation: **BLOCKED** until LLVM + IREE built inside
  the Linux container. The v1.2.0 bump closes the upstream feature gap
  (Cortex-M / CMSIS-NN as a template, CSE pass, Ethos-U Vela 5.0.0) but
  does not change the IREE elizanpu HAL target dependency.

## Evidence gate

[`docs/evidence/compiler/executorch-evidence.yaml`](../evidence/compiler/executorch-evidence.yaml)
lists the unblock requirements.
