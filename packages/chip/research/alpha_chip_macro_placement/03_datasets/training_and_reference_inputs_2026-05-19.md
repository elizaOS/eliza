# Training and Reference Inputs - 2026-05-19

These sources are candidates for AlphaChip-style pretraining, curriculum
construction, baselines, or auxiliary surrogate models. Do not commit external
datasets or benchmark payloads until license and redistribution terms are clear.

## Immediate candidates

- TILOS MacroPlacement:
  <https://github.com/TILOS-AI-Institute/MacroPlacement>. Best near-term source
  for macro-placement training and evaluation data. It includes Ariane,
  MemPool, NVDLA, BlackParrot, synthesized netlists, DEF/SDC collateral,
  OpenROAD/Cadence flows, and CT/simulated-annealing baselines.
- Google Circuit Training examples:
  <https://github.com/google-research/circuit_training>. Provides protobuf
  format, Ariane example flow, coordinate descent, pretraining hooks, and
  DREAMPlace integration.
- E1 soft-macro curriculum:
  local benchmarks under `/tmp/e1-alphachip/e1_softmacro_*`. Current useful
  sequence is 4x4, 5x5, 8x8, then full 16x16 grouping from the E1 detailed
  route DEF.

## Auxiliary ML datasets

- CircuitNet 1.0/2.0/3.0:
  <https://github.com/circuitnet/CircuitNet> and <https://circuitnet.github.io/>.
  Large ML-for-EDA dataset with LEF/DEF, sanitized netlists, graph data,
  congestion, DRC, IR, timing, and net-delay labels. CircuitNet 3.0 with N45
  PDK was announced on 2026-05-17. Best use is auxiliary surrogate scoring.
- Intel FloorSet: <https://github.com/IntelLabs/FloorSet>. About 2M synthetic
  constrained floorplan samples, PyTorch tensors, 21-120 blocks, and SoC-like
  constraints. Requires roughly 35 GB storage.
- SLICE dataset index: <https://slice-ml-eda.github.io/docs/datasets.html>.
  Useful catalog for timing, parasitic, IR, Verilog, and other ML-for-EDA
  datasets.

## Classic benchmark inputs

- MLCAD 2023 FPGA Macro Placement Contest:
  <https://github.com/TILOS-AI-Institute/MLCAD-2023-FPGA-Macro-Placement-Contest>.
  FPGA macro-placement benchmark suite with enhanced Bookshelf format.
- ISPD/ICCAD placement benchmarks:
  <https://ispd.cc/contests/15/web/downloads.html> and
  <https://www.iccad-contest.org/2015/problem_D/default.html>. Useful for
  routability-driven placement comparisons; redistribution terms are often
  unclear.
- MCNC/GSRC floorplanning benchmarks:
  <https://s2.smu.edu/~manikas/Benchmarks/MCNC_Benchmark_Netlists.html>. Tiny
  legacy YAL netlists useful for parser smoke tests and toy curriculum only.

## Chip and architecture references

- CVA6/Ariane: <https://github.com/openhwgroup/cva6>. Closest open RISC-V CPU
  reference; Ariane macro data appears in MacroPlacement.
- BlackParrot: <https://github.com/black-parrot/black-parrot>. Linux-capable
  multicore RISC-V reference with MacroPlacement coverage.
- MemPool: <https://github.com/pulp-platform/mempool>. Manycore RISC-V shared
  L1 design with tapeout references.
- NVDLA: <https://github.com/nvdla/hw>. Open DNN accelerator RTL/specs useful
  for NPU block-structure and memory-topology references; review license terms.
- ESP: <https://www.esp.cs.columbia.edu/>. Heterogeneous SoC platform with
  tile-based NoC, RISC-V processors, accelerator integration, and NVDLA paths.
- Ibex/OpenTitan: <https://lowrisc.org/ibex/>. High-quality control-plane and
  security SoC references.

## Recommended curriculum

1. Ariane133 or Ariane136 from MacroPlacement.
2. MemPool tile or group.
3. NVDLA or BlackParrot subsets.
4. E1 4x4 soft macros.
5. E1 5x5 soft macros.
6. E1 8x8 soft macros.
7. E1 full 16x16 soft macros.

Compare every stage against OpenROAD Hier-RTLMP, DREAMPlace/AutoDMP where
available, CT coordinate descent, and the OpenROAD/OpenLane baseline.
