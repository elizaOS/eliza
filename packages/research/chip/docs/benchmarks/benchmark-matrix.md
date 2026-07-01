# Benchmark Matrix

The project uses benchmarks as gates, not decoration. A result is valid only when
the report names the hardware or simulator, revision, clocks, memory model,
software build, benchmark version, run count, thermal state, and power method.

## Claim Levels

| Level | Platform | Valid claim |
|---|---|---|
| L0 | RTL unit simulation | The block satisfies this testbench or formal property. |
| L1 | Verilator full RTL | The SoC executes this workload with this target-cycle count. |
| L2 | gem5 / architecture simulator | This model projects IPC, MPKI, cache, interconnect, and memory behavior. |
| L3 | FireSim / FPGA | Linux and drivers run for long workloads; timing is useful but not phone-class. |
| L4 | Physical dev board | Android/Linux behavior is comparable at the software stack level. |
| L5 | Prototype silicon | Frequency, voltage, power, thermal, DRAM, and IO claims become real. |
| L6 | Complete phone | Product comparisons against Snapdragon, Dimensity, Tensor, Exynos, or Apple are allowed. |

## Required Gates

| Area | Pre-silicon gate | FPGA / board gate | Phone-class gate |
|---|---|---|---|
| CPU | ISA tests, CoreMark smoke, selected SPEC-like kernels, counters | Linux boot, CoreMark, STREAM, lmbench | SPEC CPU 2017, Geekbench 6, sustained thermal loop |
| Memory | cache/interconnect tests, target-cycle STREAM model | STREAM, lmbench `bw_mem`, `lat_mem_rd` | contended CPU/GPU/NPU/display bandwidth |
| NPU | operator tests, quantization checks, accuracy delta | TFLite benchmark through runtime shim | MLPerf Mobile, NNAPI CTS/VTS, energy per inference |
| GPU | no performance claim unless GPU model exists | framebuffer path, dEQP subset if GPU exists | Vulkan CTS, GLES CTS, GFXBench, 3DMark, sustained FPS |
| Storage | controller/DMA tests only | fio, SQLite | app install, cold launch, media scan, fio, SQLite |
| Android | boot image assembly, HAL stubs compile | AOSP shell/home-screen target | CTS, VTS, CTS Verifier, Treble/VNDK tests |
| Power | switching/activity estimates only | board rail measurement | external power, rail shunts, Perfetto, thermal decay curves |

## First v0 Benchmark Set

The first useful benchmark run is deliberately modest:

```text
make ci-fast
make qemu-check
make renode-check
make aosp-bsp-check
```

Then add board/simulator scripts for:

```text
coremark
stream
lmbench bw_mem
lmbench lat_mem_rd
fio sequential/random profiles
tflite benchmark_model with CPU and e1 NPU shim
selected CTS/VTS host-side smoke tests
```

## Reporting Rules

- Never compare simulator wall-clock time against phone benchmark scores.
- Do compare target cycles, IPC, MPKI, branch misses, memory transactions, and modeled frequency.
- Never report NPU TOPS alone. Report latency, accuracy, fallback rate, memory bandwidth, and joules per inference.
- Separate GPU conformance from GPU performance.
- Separate AOSP boot from Android compatibility.
- Treat web benchmark scores as planning anchors until measured on controlled local reference devices.

## CPU/AP Evidence Boundary

The selected single-hart Rocket path may only produce L3 bring-up evidence after
generated artifacts, Linux boot, ISA/cache/MMU transcript, and benchmark
transcript gates pass. It is not enough for a 2028 phone-class AP comparison.
Phone-class CPU/AP benchmarking also needs sustained runs, controlled clocks,
memory configuration, thermal state, power method, raw artifact hashes, and an
explicit claim level in the report.

Primary references:

- SPEC CPU 2017: https://www.spec.org/osg/cpu2017/
- CoreMark: https://www.eembc.org/coremark/
- MLPerf Mobile: https://github.com/mlcommons/mobile_app_open
- Android CTS: https://source.android.com/docs/compatibility/cts
- Android VTS: https://source.android.com/docs/core/tests/vts
- Vulkan CTS: https://docs.vulkan.org/guide/latest/vulkan_cts.html
- Perfetto: https://perfetto.dev/docs/
