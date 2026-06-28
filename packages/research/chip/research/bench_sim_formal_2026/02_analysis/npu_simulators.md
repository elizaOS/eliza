# NPU / accelerator simulators applied to the E1 tile NPU

Target microarchitecture per `docs/spec-db/npu-2028-target.yaml`:

- Topology `tiled_matrix_vector_npu`, 8-16 tiles.
- INT8 MAC units per tile >= 4096, local SRAM per tile >= 4 MiB.
- Engines: systolic_matrix, vector_activation, scalar_control, dma_copy,
  layout_transform, sparsity_decode.
- Dataflows: weight_stationary, output_stationary, streaming_attention_decode,
  im2col_free_convolution.

Current RTL classification is `L0_RTL_UNIT` with explicit gaps including
`no_systolic_array`, `no_sparse_INT4_GEMM`, `no_INT2_tensor_path`,
`no_FP8_tensor_path`. The simulator stack below is the right substrate to
explore those gaps *before* committing more RTL.

## Tier 1: cycle / analytical perf models

### SCALE-Sim v2 [scale_sim_v2]

- Cycle-accurate systolic-array model parameterized by array dims, dataflow
  (`os` / `ws` / `is`), SRAM sizes, and DRAM bandwidth.
- Already wired into `benchmarks/sim/run_npu_scale_sim.py` via
  `compiler/runtime/e1_npu_scale_model.py`.
- Best fit for the per-tile cycle count of GEMM, conv2d (via im2col), and
  attention QK / AV phases.
- Limitation: does not natively model sparsity decode, INT2/INT4 packing
  benefit, or streaming attention.

### Timeloop + Accelergy [timeloop_accelergy]

- The community standard for hierarchical mapping search over an
  accelerator memory and compute hierarchy, with energy attribution from
  Accelergy and area/energy primitives from CACTI.
- Use case for E1: search for the best tile-loop nest over
  `weight_stationary` / `output_stationary` for INT8 and INT4 GEMM at the
  L1_local_SRAM -> L2_shared_SRAM -> DRAM hierarchy implied by the 2028
  target numbers.
- Outputs map directly into the operator-level cycle and energy fields the
  benchmark schema needs at L2_ARCH_SIM.

### MAESTRO [maestro] + GAMMA [gamma]

- Analytical fast model + genetic-algorithm mapper.
- Useful as a fast preflight before launching a Timeloop search; both share
  authors with [eyexam] and the Eyeriss-derived dataflow taxonomy.

### Mind Mappings [mind_mappings], dMazeRunner [dmazerunner], Interstellar [interstellar]

- All three are mapper-search frameworks; relevance is informing the
  compiler back end (`compiler/`) rather than the RTL.
- Mind Mappings provides a differentiable surrogate model that can be
  trained from Timeloop runs, a useful trick if the compiler scheduler is
  exposed to runtime search.

## Tier 2: flexible-dataflow simulators

### STONNE [stonne]

- Cycle-level simulator with configurable interconnect, distribution, and
  reduction networks; supports MAERI-style flexible-dataflow accelerators.
- For E1, STONNE is the right vehicle for `sparsity_decode` and
  `streaming_attention_decode` what-ifs because it models the data
  distribution network explicitly.

### Eyexam (Eyeriss simulator) [eyexam]

- Reference simulator for row-stationary dataflow; useful as a comparator
  but does not match the 4096-MAC-per-tile target geometry without
  scaling.

## Tier 3: compute-in-memory

### NeuroSim / DNN+NeuroSim [neurosim]

- Device-level CIM simulator (analog crossbar through digital periphery).
- npu-2028-target.yaml cites Dimensity 9500 ("CIM-based Super Efficient
  NPU") as a SOTA anchor. If a future E1 sublane explores CIM tiles,
  NeuroSim is the right early-stage cost model. For the current
  digital-MAC tile path, NeuroSim is reference only.

## Tier 4: distributed / multi-chip

### ASTRA-sim 2.0 [astra_sim]

- Distributed training/inference simulator from Meta / Intel / GT.
- Not applicable to the single-package E1 phone AP target. Reference only;
  worth tracking if a multi-die phone-AP variant enters the E1 requirement set.

## Operator-level workload generators

- **DeepBench** [deepbench]: kernel-level GEMM / conv / RNN benchmark; the
  right operator-level corpus for E1 NPU regression that does not depend
  on Android.
- **MLPerf Mobile reference models** [mobilebert] [mobilenet_edgetpu]
  [stable_diffusion_xs]: ground truth for full-network checks once the
  compiler back end can lower them.

## Mapping E1 numeric targets to simulator outputs

| Target field (npu-2028-target.yaml) | Simulator that produces it | Caveat |
|---|---|---|
| `dense_int8_peak_tops_min: 160` | SCALE-Sim v2 + tile geometry; sanity-checked by Timeloop. | Peak is a structural number, not a workload result. |
| `dense_int8_sustained_tops_min: 80` | SCALE-Sim v2 with workload + thermal cap from gem5 or analytical model. | Must include `sustained_npu_power_w_max: 4.5` envelope. |
| `sparse_int4_*` | STONNE with sparsity-decode network model. | Requires choice of sparsity codec. |
| `int2_bitnet_peak_tops_min: 900` | Custom packed MAC model; not natively supported by SCALE-Sim. | BitNet-style INT2 requires a separate MAC primitive model. |
| `fp8_peak_tflops_min: 80` | SCALE-Sim v2 with FP8 MAC primitive; pair with Accelergy FP8 energy. | FP8 (E4M3) is in scope of `e1_npu.sv` per current `implemented_now` list. |
| `local_sram_mib_min: 64` | Timeloop hierarchy. | Sets the L1 capacity in the mapper. |
| `external_memory_bandwidth_gbps_min: 180` | DRAM controller model in gem5 + Timeloop DRAM tier. | Pair with `STREAM` evidence on the CPU side. |
| `cpu_fallback_percent_max: 1` | TFLite delegate trace through `tflite_benchmark_model`. | Lives in the runtime evidence, not the cycle simulator. |
| `unsupported_operator_percent_max: 1` | Same as above. | Same caveat. |

## Recommended NPU simulator stack for Workstream A

1. Keep SCALE-Sim v2 as the operator-cycle baseline.
2. Add Timeloop + Accelergy as the mapping + energy explorer. The output
   feeds a new L2_ARCH_SIM report row through the existing benchmark
   schema, with `provenance: simulator` and a calibration block that
   names the SCALE-Sim and Timeloop versions.
3. Add STONNE only when sparsity decode / streaming attention is on the
   critical path for the next RTL spin.
4. Treat MAESTRO/GAMMA/Mind Mappings/dMazeRunner/Interstellar as
   compiler-side references; not benchmark-evidence producers.
5. Do not introduce NeuroSim or ASTRA-sim into the evidence chain until a
   CIM or multi-die requirement is formally in scope.

Every report produced by these simulators must obey the rule from
`docs/benchmarks/benchmark-matrix.md`: never report NPU TOPS alone.
Report latency, accuracy delta, fallback rate, memory bandwidth, and
joules per inference (modeled).
