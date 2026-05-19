# ExecuTorch RISC-V / e1 NPU backend

ExecuTorch is the PyTorch-mobile path. This backend partitions a
PyTorch 2 exported graph between CPU fallback (XNNPACK / native) and the
e1 NPU descriptor-ring runtime, lowering NPU-resident subgraphs through
the [`elizanpu` IREE dialect](../iree-eliza-npu/).

The ExecuTorch reference list at https://docs.pytorch.org/executorch/ lists
backends for Apple, Qualcomm, Arm, MediaTek, Vulkan, and XNNPACK. The
elizanpu backend is the 13th — the open RISC-V NPU path.

## Layout

```
compiler/executorch-eliza/
  executorch-pin.json          ExecuTorch SHA + build config pin
  backend/
    __init__.py                Public API: ElizaBackend (subclass of
                               BackendDetails)
    ElizaPartitioner.py        Partitioner: walks ExportedProgram graph and
                               selects NPU-resident nodes by op signature and
                               precision support; emits an annotated graph
                               for IREE lowering.
    ElizaPreprocessor.py       Preprocessor: lowers partitioned subgraphs
                               through StableHLO -> elizanpu dialect using
                               the IREE Python bindings.
    eliza_op_support.py        Op support whitelist mirroring the elizanpu
                               op table.
  tests/
    test_partition.py          Partitioner unit test on a 2-layer MLP.
    test_backend_smoke.py      End-to-end smoke (BLOCKED until IREE built).
```

## Status

- Python partitioner + op-support list: committed.
- Preprocessor: skeleton; full lowering blocked on IREE backend build.
- End-to-end smoke: BLOCKED until LLVM + IREE built inside the canonical
  Linux container.

## Evidence gate

[`docs/evidence/compiler/executorch-evidence.yaml`](../../docs/evidence/compiler/executorch-evidence.yaml)
defines the artifacts that unblock a release-grade ExecuTorch claim.
