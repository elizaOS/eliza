# MLPerf and mobile AI benchmarks for Eliza E1

Cross-reference: `docs/spec-db/npu-2028-target.yaml#software_targets.evidence`
explicitly names `MLPerf_Mobile_or_equivalent_closed_loop`,
`tflite_benchmark_model_with_accelerator_name`, `unsupported_operator_report`,
`CPU_fallback_report`, `power_trace`, and `thermal_trace`. This document maps
those requirements onto the current state of the public benchmarks.

## State of MLPerf as of 2026-05-19

| Track | Source | Latest public round | E1 applicability |
|---|---|---|---|
| MLPerf Inference Datacenter / Edge | [mlperf_inference] | v5.0 (Spring 2025) and v5.1 (Fall 2025) | Datacenter Llama 2 70B / Llama 3.1 405B etc. is out of scope. Edge SingleStream and Offline ResNet-50 / BERT / RetinaNet / 3D-UNet / GPT-J are reference workloads only. |
| MLPerf Inference Mobile (app) | [mlperf_mobile_app_open] | v4 round (2024-2025) | The closed-loop entry the E1 target depends on. Apk requires NNAPI / TFLite delegate or vendor SDK. |
| MLPerf Tiny | [mlperf_tiny] | v1.2 (2024), v1.3 cycle (2025) | Maps onto the `always_on_micro_npu_power_mw_max: 20` line. |
| MLPerf Client | [mlperf_client] | v0.6 (2025) — Llama-2-7B INT4, Phi-3.5-mini | Provides the rule-set precedent for LLM token-per-second under a controlled thermal budget. |
| MLPerf Power | [mlperf_power] | Active | Defines the only published reference for closed-loop power-of-inference, including the mobile rail integration approach. |

### MLPerf Mobile v4 workload mix

Per [mlperf_mobile_v4_spec], the v4 reference suite consists of:

- `mobile_imagenet` — MobileNetEdgeTPU, INT8.
- `mobile_object_detection` — MobileDet / SSD-MobileNet, INT8.
- `mobile_image_segmentation` — DeepLabv3, FP32 / INT8.
- `mobile_language_understanding` — MobileBERT, INT8.
- `mobile_super_resolution` — EDSR.
- `mobile_image_generation` — Stable Diffusion XS, FP16.

Each workload has a fixed accuracy threshold relative to the reference model.
Submissions must report SingleStream latency (Quality of Service: 90th
percentile latency cap), Offline throughput, energy per inference (Mobile
Power group), and a sustained "sustained QPS" run that exposes thermal
throttling.

### Accuracy targets (MLPerf Mobile)

The accuracy thresholds in the v4 rules document range from 1% relative error
for image classification to 99% reference-equivalent for segmentation IoU and
NLP F1. E1 NPU operator coverage must therefore be tight enough that INT8 /
INT4 quantization does not push any workload below threshold. The numeric
tolerance comes from `tools/loadgen` plus the per-workload accuracy script in
the `mlperf_mobile_app_open` repo, not from a free-form number in this file.

## Submission rules and reporting fields

The MLCommons submission template requires the following fields per result;
the E1 reporting schema in `docs/benchmarks/report-schema.yaml` should be a
strict superset:

- System hardware: SoC name, NPU name, NPU IP version, accelerator name as
  exposed to NNAPI, DRAM type and speed, storage type, peak NPU TOPS at
  declared precision.
- Software stack: app/runtime version, NNAPI version, NNAPI delegate version,
  vendor SDK version if used.
- Thermal state: pre-warmed or cold start, ambient, cooling configuration.
- Energy method: instrument (Monsoon HVPM / LVPM, Joulescope JS220), shunt
  rails, sampling frequency, integration window.
- Run protocol: number of warm-up runs, number of measured runs, accuracy
  validation log.

The schema in this repo already requires `claim_level`, `provenance`, and a
calibration tuple (`clock_source`, `power_meter`). The remaining gap for
MLPerf Mobile parity is the NPU-side delegate metadata (NNAPI version,
accelerator name) which lives behind the unblocked
`benchmarks/capabilities/e1_npu_nnapi.proof.json` gate.

## AI-Benchmark v6, Geekbench AI, Procyon AI

| Benchmark | Strengths | Weaknesses for E1 evidence | Recommended use |
|---|---|---|---|
| AI-Benchmark v6 [ai_benchmark_eth] | ~60 sub-tests; covers operators MLPerf Mobile does not (super-resolution, U-Net, GAN, transformer mixes); INT8 and FP16 lanes. | Submission rules are weaker than MLPerf; results not adjudicated by a third party. | Internal regression at L4_SILICON_ANDROID; never as the only public claim. |
| Geekbench AI [geekbench_ai] | Cross-platform NNAPI / Core ML / OpenVINO / DirectML; consumer recognition. | Proprietary; opaque workload weighting; no rule of fixed precision. | L6_COMPLETE_PHONE positioning only. |
| UL Procyon AI [procyon_ai] | DirectML / OpenVINO / WinML pipelines on Windows. | Windows-only; not relevant to an Android-first SoC. | Out of scope. |
| PassMark AI [passmark_ai] | Coverage of desktop/laptop NPUs. | Marketing-leaning composite scores. | Out of scope. |

## CPU and system benchmarks already in scope

Per `docs/benchmarks/benchmark-matrix.md`:

- CPU: CoreMark [coremark], SPEC CPU 2017 [spec_cpu_2017], Geekbench 6
  [geekbench_6].
- Memory: STREAM [stream], lmbench `bw_mem` / `lat_mem_rd` [lmbench].
- Storage: fio [fio].

The matrix as written is sound. Two upgrades worth flagging:

1. **CoreMark-PRO** [coremark_pro] should be added at L2_FPGA once an SMP
   Linux build is available. CoreMark 1.0 saturates a modern OoO core and
   gives little information about multi-core scaling.
2. **DeepBench** [deepbench] is the right operator-level GEMM/conv harness
   for Verilator + cocotb NPU regression; SCALE-Sim's cycle count alone is
   not equivalent to a per-operator latency curve.

## Power and thermal evidence (cross-link)

See `power_thermal_methodologies.md`. The headline is: MLPerf Power
[mlperf_power] is the only public closed-loop power method that is accepted
by MLCommons. Monsoon HVPM / LVPM [monsoon_hvpm] [monsoon_lvpm] or Joulescope
JS220 [joulescope_js220] plus Perfetto [perfetto] is the practical lab rig.
The Android Energy / Battery APIs [android_energy_api] are useful for
attribution but never as the only number.

## What E1 cannot claim today

Per `docs/benchmarks/claim-ladder.md`, MLPerf Mobile, Geekbench AI, and
AI-Benchmark all require L4_SILICON_ANDROID at minimum. The current chip
package is L0_RTL_UNIT. The only honest pre-silicon evidence the harness
can produce is:

- Functional-correctness MLPerf Mobile workloads through the runtime shim,
  with `unsupported_op_count` and `cpu_fallback_percent` populated by the
  TFLite delegate path.
- Operator-level DeepBench / SCALE-Sim derived target-cycle estimates.

Both stay at L1_RTL_FULL_SOC / L2_ARCH_SIM until a real Android boot
exists, and `tflite_e1_npu` stays `blocked` until
`benchmarks/capabilities/e1_npu_nnapi.proof.json` is populated by a real
NNAPI run.
