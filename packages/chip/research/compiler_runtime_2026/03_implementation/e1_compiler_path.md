# From smoke harness to real backend: ranked E1 compiler path

This document maps the research in this packet to concrete next steps for
the E1 compiler stack. Each step ties to a specific docs/spec-db file and a
gap visible in today's
`packages/chip/compiler/runtime/e1_npu_lowering.py`. Confidence is High,
Medium, or Low based on whether the design choice is well-established in
the public landscape and whether the supporting RTL primitive already
exists in `packages/chip/rtl/npu/e1_npu.sv`.

This is a planning document, not a status claim. None of these steps are
implemented; nothing here certifies E1 compiler capability.

## High confidence steps

### H1. Canonicalize entry IR on StableHLO

- **Why:** StableHLO is the converging entry IR for JAX, PyTorch (via
  `torch.export` + odml-torch / AI Edge Torch), and LiteRT. The current
  smoke schemas (`eliza.e1_npu_matmul_smoke.v1`, etc.) are ad-hoc and
  cannot absorb real models.
- **Gap (file/line):** `compiler/runtime/e1_npu_lowering.py:8-15` defines
  ad-hoc per-op schemas; `SUPPORTED_MATMUL_OPS` already lists
  `stablehlo.dot_general` but the implementation accepts a dict shape, not
  a StableHLO module.
- **Anchor:** `docs/spec-db/npu-2028-target.yaml` software targets call out
  StableHLO and MLIR.
- **Step:** Replace the smoke schemas with a thin StableHLO subset
  validator (using `stablehlo` Python bindings or a small hand-written
  parser). Keep the existing tile-bound checks but apply them against
  StableHLO ops.

### H2. Add an ExecuTorch delegate skeleton

- **Why:** ExecuTorch is the official PyTorch on-device runtime and the
  Samsung Exynos 2600 source anchor in `npu-2028-target.yaml` explicitly
  lists "ExecuTorch deployment support" as an observed claim. Every 2026
  mobile NPU ships an ExecuTorch backend.
- **Gap:** No backend exists today; `compiler/runtime/` has only Python
  lowering smoke.
- **Anchor:** `docs/spec-db/npu-2028-target.yaml` (ExecuTorch as a
  source-anchor expectation) and `docs/benchmarks/capabilities/` (the
  software evidence manifest).
- **Step:** Add a Python ExecuTorch `Partitioner` + `preprocess` skeleton
  that consumes an `EdgeProgram`, partitions matmul/conv/attention
  subgraphs to the existing `e1_npu_lowering.py` paths, and emits a
  placeholder blob. The runtime stub can be a Python `BackendInterface` for
  now.

### H3. Add a LiteRT (TFLite) delegate skeleton

- **Why:** Same logic as H2 but for the LiteRT consumer space. LiteRT
  already ingests StableHLO, so the internal compiler can be shared with
  H1.
- **Gap:** No delegate exists.
- **Anchor:** `docs/spec-db/npu-2028-target.yaml` (TFLite delegate target).
- **Step:** Stub a C++ delegate header + Python build harness that
  declares an op-set and calls into the same StableHLO-canonicalised
  internal compiler used by H2.

### H4. Introduce a descriptor-ring command-buffer abstraction

- **Why:** The current runtime fires one MMIO opcode at a time. Every
  serious NPU runtime above the driver uses a command buffer / dispatch
  list / descriptor ring; IREE's Stream dialect is the cleanest public
  example.
- **Gap:** `compiler/runtime/e1_npu_runtime.py` exposes one
  `submit(opcode, ...)` style call.
- **Anchor:** `docs/arch/npu-microarch.md` already describes a descriptor
  ring; today's Python runtime does not use it.
- **Step:** Define a `CommandBuffer` type in
  `compiler/runtime/e1_npu_runtime.py` that batches descriptors, submits
  them as a unit, and waits on `irq_npu` / `CTRL_STATUS.done` once for the
  whole batch.

### H5. Add a partitioner that respects the opcode set

- **Why:** Every framework integration (ExecuTorch, LiteRT, ONNX Runtime)
  requires a partitioner that decides which subgraphs the device handles.
- **Gap:** `e1_npu_lowering.py` currently rejects unknown shapes; it does
  not negotiate with a framework about which subgraphs to lower.
- **Anchor:** `docs/spec-db/npu-2028-target.yaml`
  `cpu_fallback_percent_max: 1` and `unsupported_operator_percent_max: 1`
  targets. A partitioner is the only way to measure these.
- **Step:** Add a `Partitioner` class in `compiler/runtime/` that walks a
  StableHLO module and returns a list of `(op, supported)` decisions, with
  the supported set driven by the current opcode + tile-bound table.

## Medium confidence steps

### M1. Add INT4 weight-only matmul lowering (W4A16 path)

- **Why:** GPTQ/AWQ INT4 weight-only is the dominant LLM serving precision
  in 2026. Today `GEMM_S4` requires INT4 activations as well, which is the
  harder W4A4 case.
- **Gap:** No W4A16 lowering path. See
  `02_analysis/quantization_toolchains.md` section 2.
- **Anchor:** `docs/arch/npu.md` (GEMM_S4 opcode definition) and
  `docs/spec-db/npu-2028-target.yaml`
  (`sparse_int4_sustained_tops_min: 200`).
- **Step:** Lower W4A16 by either (a) dequantizing INT4 weights to INT8 in
  the scratchpad pre-`GEMM_S8`, or (b) adding a new opcode
  `GEMM_S4_S8_MIXED` to RTL. Option (a) is compiler-only; option (b)
  requires RTL changes.

### M2. Lower softmax and layernorm as host-CPU fallback ops (explicit)

- **Why:** Real transformer inference needs softmax and layernorm. E1 has
  no FP datapath beyond Q8.8, so these must run on host CPU until a
  vector/SFU is added.
- **Gap:** `e1_npu_lowering.py` currently has no softmax / layernorm path;
  the `transformer_block` smoke schema does not include them.
- **Anchor:** `docs/spec-db/npu-2028-target.yaml`
  `cpu_fallback_percent_max: 1`. Honest accounting requires labelling
  these ops as CPU-bound.
- **Step:** Add explicit `CpuFallbackOp` results in the lowering output so
  the partitioner counts these against the CPU-fallback budget instead of
  pretending the NPU executes them.

### M3. Add Flash-Decoding-style decode kernel scheduling

- **Why:** On-device LLM decode is GEMV-shaped (`M = 1`) and the
  Flash-Decoding pattern (split-K reduction) is the standard 2026
  approach. See `02_analysis/attention_lowering.md` section 2.
- **Gap:** `attention_qk` / `attention_av` smoke schemas do not distinguish
  prefill from decode.
- **Anchor:** `docs/arch/npu.md` (attention smoke paths) and
  `docs/benchmarks/capabilities/` (LLM-class benchmark expectations).
- **Step:** Split `attention_qk` / `attention_av` lowering into two
  schemas (`prefill` and `decode`) with different tile-shape selection.
  Decode emits multiple split-K dispatches plus a host-side reduction.

### M4. Add paged KV-cache block-table support

- **Why:** vLLM-style paged attention is the universal long-context LLM
  serving pattern.
- **Gap:** Compiler treats KV as contiguous tensors.
- **Anchor:** `docs/spec-db/npu-2028-target.yaml`
  `command_queue_depth_min: 1024` and
  `concurrent_contexts_min: 8` imply a serving-class runtime that must
  support paged memory.
- **Step:** Add a `KvBlockTable` IR primitive that the compiler can lower
  to a series of descriptor-ring DMA reads. Until DMA-gather hardware
  exists, lower as one descriptor per block (slow but correct).

### M5. Add MetaSchedule-style tile-shape selection (heuristic first)

- **Why:** Today's tile bounds (`MAX_TILE_M = 3`, `MAX_TILE_N = 3`,
  `MAX_TILE_K = 7`) come from the RTL scratchpad footprint, not from any
  workload-aware search. Real backends use MetaSchedule / Mind Mappings or
  hand-tuned heuristics.
- **Gap:** Hard-coded tile bounds in
  `compiler/runtime/e1_npu_lowering.py:57-59`.
- **Anchor:** `docs/spec-db/npu-2028-target.yaml`
  `local_sram_mib_min: 64`, `local_sram_bandwidth_tbps_min: 20`.
- **Step:** Replace constant tile bounds with a function of the
  scratchpad and the operator shape; ship a simple heuristic first (e.g.
  pick the largest tile that fits in scratchpad while keeping K-multiple
  alignment), and only later consider MetaSchedule-style search.

### M6. Add an ONNX Runtime EP skeleton

- **Why:** Enterprise / Windows-on-ARM workflows ship ONNX. The EP
  interface mirrors the partitioner work in H5.
- **Gap:** No ORT EP exists.
- **Anchor:** `docs/spec-db/npu-2028-target.yaml` ONNX coverage assumption.
- **Step:** Add an ORT EP skeleton in `compiler/runtime/` that reuses the
  same partitioner + StableHLO canonicalization used by H1/H2/H3.

## Low confidence / human-decision steps

### L1. Choose a single internal MLIR pipeline (IREE vs TVM vs custom)

- **Why:** Once H1-H5 land, the compiler internals need to evolve beyond
  Python. The choice between IREE (HAL driver + Stream), TVM Unity
  (Relax + BYOC), and a custom MLIR pipeline is a strategic call.
- **Gap:** Today there is no MLIR pipeline; the choice is wide open.
- **Anchor:** `docs/spec-db/npu-2028-target.yaml` mentions both IREE and
  TVM as acceptable.
- **Decision input:** IREE's Stream dialect maps best onto E1's
  descriptor ring; TVM's MetaSchedule is the best tile-search story; a
  custom pipeline avoids both dependencies but doubles the maintenance
  burden.

### L2. Adopt OCP Microscaling (MX-FP6 / MX-FP4 / MX-INT8) precision

- **Why:** Block-scaled microformats are where 2026-2028 NPUs are
  converging.
- **Gap:** E1 has no block-scale RTL primitive.
- **Anchor:** `docs/spec-db/npu-2028-target.yaml` `fp8_peak_tflops_min: 80`
  and INT4 sustained targets.
- **Decision input:** Adopting MX requires both RTL (block-scale operand
  fetch + accumulator) and compiler (block-layout codegen). Cannot be
  software-only.

### L3. Adopt FP16 / BF16 vector unit for softmax and layernorm

- **Why:** As long as softmax / layernorm run on host CPU, the
  `cpu_fallback_percent_max: 1` target in
  `docs/spec-db/npu-2028-target.yaml` is unreachable for any real
  transformer workload.
- **Gap:** E1 has no FP16/BF16 datapath.
- **Decision input:** Either add an SFU/vector unit, or accept a higher
  CPU-fallback budget and rewrite the spec. Both are valid choices; the
  research packet flags it for explicit decision.

### L4. Adopt FlashAttention-3 style asynchronous pipelining

- **Why:** FA-3 producer/consumer pipelining is the latest attention
  state-of-the-art on Hopper.
- **Gap:** E1 has no async / multi-warp model.
- **Decision input:** FA-3 patterns require multiple in-flight dispatches
  and a real memory hierarchy with overlapped DMA + compute. For a
  single-ring NPU, FA-2 is the practical target; FA-3 is post-microarch
  expansion.

## Cross-reference table

| Step | File anchor                                                                 | Current gap                                                |
| ---- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| H1   | `compiler/runtime/e1_npu_lowering.py:8-15`                                  | Ad-hoc schemas instead of StableHLO                        |
| H2   | `docs/benchmarks/capabilities/`                                             | No ExecuTorch delegate                                     |
| H3   | `docs/spec-db/npu-2028-target.yaml` software targets                        | No TFLite/LiteRT delegate                                  |
| H4   | `compiler/runtime/e1_npu_runtime.py`, `docs/arch/npu-microarch.md`          | No command buffer abstraction                              |
| H5   | `docs/spec-db/npu-2028-target.yaml` fallback percent targets                | No partitioner                                             |
| M1   | `docs/arch/npu.md` `GEMM_S4`                                                | No W4A16 lowering                                          |
| M2   | `docs/spec-db/npu-2028-target.yaml` `cpu_fallback_percent_max`              | Softmax/layernorm not explicit CPU fallbacks               |
| M3   | `compiler/runtime/e1_npu_lowering.py` attention smoke schemas               | No prefill/decode split                                    |
| M4   | `docs/spec-db/npu-2028-target.yaml` concurrent_contexts / queue_depth       | No paged KV abstraction                                    |
| M5   | `compiler/runtime/e1_npu_lowering.py:57-59`                                 | Hard-coded tile bounds                                     |
| M6   | `docs/spec-db/npu-2028-target.yaml` ONNX expectation                        | No ORT EP                                                  |
| L1   | `docs/spec-db/npu-2028-target.yaml` (IREE/TVM both acceptable)              | Internal MLIR pipeline choice open                         |
| L2   | `docs/spec-db/npu-2028-target.yaml` FP8/INT4 targets                        | No block-scale RTL or compiler support                     |
| L3   | `docs/spec-db/npu-2028-target.yaml` `cpu_fallback_percent_max`              | No FP16/BF16 SFU                                           |
| L4   | `docs/arch/npu-microarch.md`                                                | Single ring, no async dispatch                             |

## Sequencing note

Steps H1-H5 form a coherent first wave that does not require any RTL
changes: a new entry IR, two delegate skeletons (ExecuTorch + LiteRT), a
command-buffer abstraction, and a partitioner. M-series steps then build
on that wave to cover real LLM workloads. L-series steps are strategic
decisions that require RTL/microarch input alongside compiler work.
