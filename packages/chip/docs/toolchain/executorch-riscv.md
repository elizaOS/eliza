# ExecuTorch RISC-V / e1 NPU backend

ExecuTorch is the PyTorch-mobile-on-device runtime. As of the
ExecuTorch backend roster (Apple, Qualcomm, Arm, MediaTek, Vulkan, XNNPACK),
there is no open RISC-V NPU path. This document specifies how the e1 NPU
becomes the 13th backend, lowering PyTorch ExportedPrograms through the
[`elizanpu` IREE dialect](iree-eliza-npu.md).

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
- End-to-end PTE generation: **BLOCKED** until LLVM + IREE built inside
  the Linux container.

## Evidence gate

[`docs/evidence/compiler/executorch-evidence.yaml`](../evidence/compiler/executorch-evidence.yaml)
lists the unblock requirements.
