# Compiler & On-Device Runtime Research Packet (E1 NPU)

**Captured:** 2026-05-19
**Scope:** Research-only inventory and analysis of public compiler stacks, mobile
runtimes, quantization toolchains, and tensor-IR dialects that could feed a
production compiler backend for the E1 NPU. This packet covers fifteen surfaces:
MLIR/CIRCT, StableHLO/OpenXLA, IREE, TVM/Relax, PyTorch 2.x compile + ExecuTorch,
TFLite/LiteRT, ONNX Runtime, Triton/GPU JIT, Android AICore/NNAPI successor,
quantization toolchains (AIMET/Brevitas/GPTQ/AWQ/SpinQuant/etc.), tensor/graph
IRs (LinAlg, Stream, Transform, Halide, BUDA), throughput-oriented runtimes
(vLLM/SGLang/MAX/llama.cpp/MLX), compiler papers, attention-lowering practice,
and mobile NN abstractions (Core ML, QNN, NeuroPilot, ExecuTorch backends).

**Claim boundary:** Every item below is a public artifact (arXiv paper, vendor
documentation page, open-source repository, conference paper, RFC, or release
blog). Nothing in this packet certifies that E1's compiler stack implements any
of these techniques. E1 claims require local RTL, simulator, software, PD, and
evidence gates per `docs/benchmarks/capabilities/README.md`. Anchors to E1
artifacts in `03_implementation/e1_compiler_path.md` are gap-and-step
descriptions, not implementation claims.

## Contents

- `01_sources/source_inventory.yaml` — fifty-plus public sources across the
  fifteen target surfaces, mirroring the schema used by
  `research/ai_accelerator_sota/01_sources/source_inventory.yaml`.
- `02_analysis/mlir_stack_landscape.md` — MLIR/StableHLO/IREE/TVM/PyTorch
  compile landscape as of mid-2026, including current production users and
  open NPU-relevant gaps.
- `02_analysis/mobile_runtime_landscape.md` — TFLite-to-LiteRT, NNAPI
  deprecation and AICore/AI Edge migration path, ExecuTorch backends, ONNX
  Runtime Mobile/Web, MLX, MediaPipe.
- `02_analysis/quantization_toolchains.md` — INT8/INT4/INT2/FP8/FP4 software
  toolchains, their operator assumptions, and which precisions land in E1's
  current opcode set vs. which are software-only.
- `02_analysis/attention_lowering.md` — how attention is lowered in 2026
  stacks (FlashAttention-3, paged attention, KV cache layouts, RoPE fusion,
  GEMV decode kernels) and what E1's `attention_qk`/`attention_av` smoke
  paths would need to absorb.
- `03_implementation/e1_compiler_path.md` — ranked High/Med/Low steps to take
  `compiler/runtime/e1_npu_lowering.py` from a Python smoke harness toward a
  real StableHLO/TFLite/ExecuTorch NPU backend, each tied to a docs/spec-db
  file and a current gap.

## Source policy

Primary sources are arXiv, MLSys/ASPLOS/PLDI/OSDI/ATC/ICLR/NeurIPS papers,
vendor documentation, and project repositories. Every YAML entry carries
`url`, `title`, `year`, and `relevance`; repositories also carry
`last_release_or_commit_year`. Items prefixed `repo_` are GitHub or
equivalent source forges. Items prefixed `paper_` are venue or arXiv papers.
Items prefixed `vendor_` are vendor documentation pages. Items prefixed
`spec_` are RFCs or schema specifications.

## How to use this packet

Read `02_analysis/mlir_stack_landscape.md` first for the upstream IR picture,
then `mobile_runtime_landscape.md` for the deployment surface E1 will live in.
Use `attention_lowering.md` when extending
`compiler/runtime/e1_npu_lowering.py`'s attention smoke paths. Use
`quantization_toolchains.md` when extending the INT4/INT2/FP8 opcode coverage
documented in `docs/arch/npu.md`. Use `03_implementation/e1_compiler_path.md`
to slot incremental compiler work into the `docs/spec-db/npu-2028-target.yaml`
software targets.
