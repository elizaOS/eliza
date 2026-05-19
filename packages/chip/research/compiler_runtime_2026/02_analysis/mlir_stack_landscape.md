# MLIR / StableHLO / IREE / TVM / PyTorch compile landscape (2026-05-19)

This is a research-only summary of public stacks that could feed a production
E1 NPU compiler backend. It does not certify E1 implementation status; the
E1 software stack today is a Python smoke harness in
`packages/chip/compiler/runtime/e1_npu_lowering.py`.

## 1. MLIR upstream — the IR substrate

MLIR (`llvm-project/mlir`) is the shared substrate for every serious 2026 ML
compiler that is not strictly framework-internal. The dialects most relevant
to a tensor-NPU backend are:

- **`linalg`** — structured ops (matmul, conv, generic) on tensors and
  memrefs. Tile-and-fuse, vectorization, bufferization, and most lowering
  pipelines start here. This is the dialect E1 should canonicalize to before
  emitting tile-level dispatches.
- **`tensor` / `memref` / `bufferization`** — the value/buffer split used to
  separate allocation from computation. Critical for scratchpad-bound NPUs
  because bufferization controls where temporaries land.
- **`vector`** — vector dialect for SIMD lowering. For an NPU descriptor ring
  this matters mainly as a CPU-fallback lowering target.
- **`transform`** — the schedule-as-IR dialect that lets a backend express
  tile sizes, fusion, vectorization, and lowering decisions in MLIR itself,
  instead of buried in C++ passes. This is the modern replacement for ad-hoc
  pass pipelines.
- **`gpu` / `async`** — abstract device kernel + asynchronous launch models;
  useful as inspiration for a future E1 dispatch dialect.
- **`mesh`** — distributed tensor abstraction for sharding; long-term
  relevant if E1 ever scales to multiple cores.
- **`sparse_tensor`** — structured sparsity. Direct fit for the E1
  `SDOT4_S4_2_4` 2:4-sparse primitive once that goes beyond scalar.

CIRCT (`llvm/circt`) carries this design into hardware (FIRRTL, HW, Comb,
Calyx, Pipeline). It is not on the inference critical path but is the natural
home if E1 ever wants to co-generate descriptor-ring microcode and RTL.

## 2. StableHLO and OpenXLA — the framework boundary

StableHLO is the versioned, portable op set produced by JAX (`jax.export`),
PyTorch/XLA, and the TFLite/LiteRT converter. It is now the most realistic
"single front door" for an NPU backend that wants to absorb workloads from
multiple frameworks without writing a frontend per framework.

Key facts:

- StableHLO has a normative spec
  (`github.com/openxla/stablehlo/blob/main/docs/spec.md`) with quantized
  types, dynamic shapes, and a versioned bytecode compatibility window. A
  backend can declare "I support StableHLO v1.x" and have a stable contract.
- The OpenXLA XLA compiler itself (`github.com/openxla/xla`) is now
  MLIR-based on the GPU side, so a downstream NPU compiler can either consume
  HLO or share MLIR passes.
- PJRT (`xla/pjrt`) is the device-plugin C ABI used by JAX. A custom PJRT
  plugin is the cleanest way to bind a new device to JAX without modifying
  JAX itself.
- `jax.export` packages StableHLO bytecode + an ABI for `jit`'d functions,
  giving a stable AOT input artifact for a backend.

For an E1 backend, StableHLO is the right "entry IR" choice: it is what
LiteRT, JAX, and PyTorch (via `torch.export` + StableHLO) all already
produce.

## 3. IREE — the canonical MLIR end-to-end stack

IREE (`github.com/iree-org/iree`) is the most complete public example of an
MLIR-based end-to-end compiler + runtime. Its pipeline is the cleanest blueprint
for an NPU backend:

1. **Frontends** ingest StableHLO, TOSA, or Torch (via Torch-MLIR / Turbine).
2. **Flow** dialect partitions the program into dispatch regions.
3. **Stream** dialect schedules dispatches as a command-buffer / timeline.
4. **HAL** dialect lowers to device commands (`hal.executable`,
   `hal.command_buffer`).
5. **Targets** include CPU (LLVM), CUDA, ROCm, Vulkan, Metal, WebGPU,
   embedded ELF, and an extension model for custom HAL drivers.

A custom HAL driver is the textbook path for an NPU vendor to land in IREE.
The PyTorch frontend is now `iree-turbine`, which uses `torch.export` /
`torch.compile` + Torch-MLIR to emit Linalg-on-tensors.

For E1 the Stream dialect is the natural level at which to attach a driver:
each `stream.cmd.dispatch` lines up well with a descriptor-ring entry, and
`stream.timepoint` matches the `irq_npu` / `CTRL_STATUS.done` event model
documented in `docs/arch/npu.md`.

## 4. TVM Unity — Relax + MetaSchedule + BYOC

Apache TVM Unity (Relax IR + TIR + MetaSchedule + BYOC) is the other mature
end-to-end stack and the historical home of NPU vendor codegen. Highlights:

- **Relax** (Relay v2) supports dynamic shapes and tensor-program composition;
  MLSys 2024 paper "Relax: Composable Abstractions" is the design reference.
- **MetaSchedule** is a probabilistic autoscheduler that searches tiling /
  fusion / vectorization choices, useful when an NPU has many tile-shape
  options.
- **BYOC** (Bring-Your-Own-Codegen) is the mechanism most NPU vendors used
  pre-MLIR. It is still the lowest-effort path for emitting vendor-specific
  call-outs from Relax graphs.
- **MLC-LLM** (`github.com/mlc-ai/mlc-llm`) is the canonical example: it uses
  TVM Unity + Relax + MetaSchedule to deploy quantized LLMs to mobile GPUs,
  NPUs, and WebGPU with INT4 weights, paged KV cache, and grouped-query
  attention.

TVM is a viable alternative entry point to IREE for E1 if Relax dynamic
shapes or MetaSchedule's tile-search are needed and IREE's stream-dispatch
model is the wrong fit. The tradeoff is more vendor-specific C++ in BYOC vs.
IREE's pure-MLIR pipeline.

## 5. PyTorch 2.x compile stack and ExecuTorch

The PyTorch 2.x compile stack matters because PyTorch models dominate
real-world workloads, even when deployment happens through StableHLO or
TFLite. Pieces relevant to E1:

- **`torch.compile`** uses TorchDynamo to capture FX graphs, runs
  AOTAutograd, and lowers via TorchInductor. Custom backends are registered
  with `torch._dynamo.register_backend`.
- **AOTInductor** emits AOT-compiled shared libraries (.so) instead of JIT
  cache entries; useful for serving and edge deployment.
- **`torch.export`** is the canonical AOT capture that emits an `ExportedProgram`,
  which is then either lowered to AOTInductor, ExecuTorch (.pte), or
  StableHLO.
- **ExecuTorch** (`github.com/pytorch/executorch`) is the official on-device
  runtime. It uses a partitioner + delegate model: a backend exposes a
  `Partitioner` and a `preprocess` method that converts an exported
  subgraph into a backend-specific blob. The runtime loads `.pte` files and
  dispatches to delegates. Existing delegates: XNNPACK, CoreML, MPS, QNN,
  MediaTek NeuroPilot, Vulkan, KleidiAI.
- **Torch-MLIR** (`github.com/llvm/torch-mlir`) converts FX or
  ExportedProgram to Linalg-on-tensors / StableHLO / TOSA. This is the path
  every MLIR-based compiler uses to consume PyTorch models.

For E1, the realistic mobile-PyTorch ingestion path is
PyTorch → `torch.export` → ExecuTorch delegate, with the delegate's
`preprocess` invoking the E1 compiler. The compiler itself can still be
StableHLO-based internally via Torch-MLIR.

## 6. Gaps for an E1-class NPU backend

Looking at the today state of `compiler/runtime/e1_npu_lowering.py` against
this landscape, the gaps that any production path will need to close:

1. **No real IR.** Today the compiler consumes ad-hoc JSON records keyed by
   schemas like `eliza.e1_npu_matmul_smoke.v1`. A real backend must consume
   StableHLO (via PJRT/JAX), TFLite/LiteRT, or ExecuTorch-exported FX, and
   share an MLIR pipeline with at least one canonical dialect (linalg or
   Relax).
2. **No dispatch model.** The runtime fires one MMIO opcode at a time. A
   production stack needs an explicit command-buffer / descriptor-ring
   schedule (IREE Stream or a TVM-runtime equivalent) so that the host
   submits batched work and waits on completion events instead of polling
   single ops.
3. **No tile search.** The current backend has hard-coded tile bounds
   (`MAX_TILE_M = 3`, `MAX_TILE_N = 3`, `MAX_TILE_K = 7`). A real backend
   needs at least heuristic tile selection driven by the actual scratchpad
   size and the operator's static shapes; MetaSchedule and Mind Mappings
   are the prior art.
4. **No autograd / training awareness.** Inference-only is fine, but the
   backend should explicitly declare that and refuse training graphs at the
   frontend instead of silently producing wrong code.
5. **No partitioner.** All non-NPU ops currently fall back outside the
   compiler. ExecuTorch / IREE / TVM all expect a partitioner that decides
   what to send to the device. Today there is no such partitioner.
6. **No quantization pipeline.** The opcodes assume INT8 / INT4 / INT2 / FP8
   inputs already exist in the right format. The compiler must accept a
   quantized StableHLO / QDQ ONNX / TFLite-quantized model and produce the
   correct scratchpad layout. See `quantization_toolchains.md`.

The mid-2026 conventional choice for a new NPU is: StableHLO (or
LinAlg-on-tensors) as the canonical entry IR, an MLIR pass pipeline that
reuses linalg/tensor/bufferization/transform dialects, a Stream-dialect-like
schedule, and at minimum an ExecuTorch delegate + LiteRT delegate for mobile
deployment. That is the picture this packet feeds into.
