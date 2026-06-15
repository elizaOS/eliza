# E1 Chip — Closeable-On-This-Machine Work Inventory

**Date**: 2026-05-22
**Method**: 8 parallel read-only research agents swept the entire chip codebase end-to-end (RTL, compiler/runtime, verification, PD/EDA, SW/BSP/firmware, benchmarks/scripts/contracts, mechanical/board, docs/security/evidence).
**Scope**: ONLY work doable on this machine with the local toolchain (Verilator, Yosys, sby/z3/bitwuzla, OpenROAD/OpenLane on open PDKs, QEMU, RV cross-toolchain, CadQuery/OCP, KiCad CLI, Python). EXCLUDES anything needing foundry PDK agreements, fabricated silicon, real PCB fab, supplier returns, commercial EDA (Ansys/Synopsys), or a full AOSP checkout.
**Claim boundary**: Research/plan artifact. Nothing here promotes a silicon/release claim past existing fail-closed gates.

This supersedes the cleanup sections (§3–§5) of the older `E1_SOTA_TAPEOUT_DOSSIER.md`, which predates the Ascalon removal, RoT landing, Linux-on-CVA6 boot, MLPerf harness, and multi-PDK framework.

---

## Tier 0 — Highest-ROI quick wins (S, zero-risk, do-now)

| # | Item | Anchor | Why now |
|---|---|---|---|
| 0.1 | Replace `run_benchmarks.py` inline parsers with imports from `benchmarks/parsers/` | `benchmarks/run_benchmarks.py:1277-1509` | -230 LoC dup; canonical parsers tested; sole consumer; zero risk |
| 0.2 | Run the 9 local benchmarks to produce local/simulator evidence | `benchmarks/parsers/*`, `benchmarks/sim/run_*.py` | CoreMark/STREAM/lmbench/fio (host) + NPU-scale/thermal/IOMMU-QoS/context-queue sims all runnable now; this does not produce phone-class L5/L6 release evidence |
| 0.3 | Wire 3 orphaned sim harnesses into the benchmark pipeline | `benchmarks/sim/run_npu_timeloop.py`, `run_memory_iommu_qos_sim.py`, `run_npu_context_queue_sim.py` | exist but `run_benchmarks.py` never calls them |
| 0.4 | Dispatch StableHLO `TransformerBlock`/`ModernDecoderBlock` through module lowering | `compiler/runtime/e1_npu_stablehlo.py`, `compiler/runtime/e1_npu_lowering.py` | Done: parser/planner/materializer and module dispatch now cover both fused block lowerers |
| 0.5 | Wire sparse 2:4 opcode dispatch (`golden_sdot4_s4_2_4` exists, never called) | `e1_npu_runtime.py:1601`, `e1_npu_lowering.py:1587-1656` | completes the sparse path |
| 0.6 | Wire `dma_long_transfer` cocotb test into the Makefile (written, not run) | `verify/cocotb/dma/test_dma_long_transfer.py` | + un-skip `npu_queue_stress` tests |
| 0.7 | 5 missing CAD parts (declared in params, not emitted by `build_parts`) | `mechanical/.../e1_phone_params.yaml` (soc_thermal_spreader, mid_frame_stiffener, antenna_feeds, front_proximity_als, display_ground_foam); `scripts/generate_e1_phone_cad.py:1610` | ~60-80 LoC; closes the camera-back high-severity flags |
| 0.8 | Add 6 missing NPU lowering smoke tests | `compiler/runtime/test_e1_npu_runtime.py` (rope/rmsnorm/silu/gelu/depthwise/grouped-conv) | copy existing matmul test |
| 0.9 | Relabel mislabeled evidence + sim-shadow rename | `docs/evidence/android/renode_e1_soc_smoke.log` (PASS→BLOCKED), `e1_npu.sv` PERF_THERMAL_THROTTLE→`_sim_shadow` + HAL docstring | honesty fixes |
| 0.10 | `yaml.safe_load`(242)/`json.load`(51) → `chip_utils.load_*` across check scripts | `scripts/check_*.py` | central error handling; mechanical |

---

## Tier 1 — Medium closeable features (M)

**RTL** (all elaboratable + cocotb/formal-verifiable locally):
- AXI-Lite debug↔CPU MMIO 2-master crossbar (current `rtl/top/e1_soc_top.sv` has `e1_axil_to_mmio` plus `e1_mmio_arb2`; keep cocotb/formal coverage current).
- RVV integer ALU subset wiring — `rtl/cpu/rvv/rvv_unit_stub.sv` returns zeros while `rvv_alu_subset.sv` (12 ops) is never consulted; add dispatch mux.
- DRAM QoS scheduling — `rtl/memory/dram_ctrl/e1_dram_ctrl.sv:60-102` accepts AxQOS but never parses it; add priority queues.
- JTAG TAP / RVdebug DMI — `rtl/dft/e1_jtag_tap.sv` minimal; add IR decode + DTM/DMI for OpenOCD.
- TileLink-C bridge per-TX-ID tracking + Release path (`rtl/cache/coherence/tl_c_to_chi_bridge.sv`).
- 2-core cluster coherence exercise (bring 2 cores live out of lite-tieoff; MESI test).
- APLIC edge-triggered source validation (`rtl/interrupts/e1_aplic.sv`).
- IOMMU device-context/PASID fault validation (`rtl/iommu/e1_riscv_iommu.sv`).

**Verification**:
- **riscv-arch-test + riscv-dv lane against CVA6** — manifest is `pinned_not_run`; CVA6 builds now, so clone + run is unblocked (`verify/riscv-arch-tests/manifest.json`). HIGH leverage.
- Un-skip CPU `test_csr_trap`/`test_mmu_sv39` (CVA6-gated, now satisfiable).
- Deepen DMA/AXI-Lite/reset-CDC formal depths; add display formal properties.
- IOMMU fault-injection cocotb; promote AI-EDA assertion candidates.

**Compiler**:
- Unify ExecuTorch + LiteRT delegates (shared dispatcher).
- Descriptor-ring region splitting (`LegalizeDescriptorRing.cpp` verify-only → split).
- TypedDict/pydantic for graph payloads (159× `dict[str,Any]`).

**PD/EDA** (open PDKs only):
- netgen LVS on the completed 4KB SRAM macro; finish 16KB (running) + launch 64KB OpenRAM.
- GF180 + IHP-SG13G2 full-chip closures (configs ready, PDKs deployed).
- ASAP7 leaf-shape PPA projections; constraints SDC dedup + corner expansion.
- antenna/STA waiver disposition on sky130 (real run reports exist).
- CircuitNet GNN surrogate (replace mean-baseline); logic-synthesis policy expansion (equivalence-gated).

**SW/BSP**:
- Buildroot rv64gc qemu-virt smoke (closest-to-landing; verify `external/buildroot-rv64/output/images/` built).
- AOSP device-tree/sepolicy/VINTF artifact validation (no checkout needed).
- CVA6 cycle-accurate Linux boot speedup (smaller initramfs / +max-cycles / checkpoint) to actually reach userland.

**Contracts/docs**:
- Single `docs/spec-db/e1-memmap.yaml` + generator → `e1_memmap_pkg.sv` + DTS fragment (memory map duplicated in 7 places).
- `scripts/spec_db_models.py` pydantic models for spec-db; NPU runtime contract table-driven.
- PERF_CYCLES scope clarification in the NPU contract.
- Dossier staleness pass (Ascalon-removed, cluster topology, landed RoT/Linux/MLPerf/PDK items).
- BLOCKED-convention unification (JSON over stdout) in the aggregator.
- Audit + remove genuinely-unreferenced check scripts (~93 not in Makefile — verify each).

---

## Tier 2 — Larger but local (L)

- RTL DRY H6/H9: settle `AXI_ID_W` to 8 (remove the width-converter shim); extract the AXI4 master-tieoff. (H1-H4 `e1_clint`/`e1_behavioral_dram`/`e1_soc_pkg`/`e1_mmio_decode` extraction is ALREADY DONE by a prior swarm.)
- Pythia ML prefetcher minimal Q-table impl + bind a prefetcher into L1D/L2.
- StableHLO canonicalization pipeline (op fusion: MLP, softmax, layernorm).
- linalg→elizanpu MLIR lowering bridge (4 ops) — note the Python smoke path doesn't need it yet.
- Spike/Sail differential-testing lane (checkouts → harness).
- YAML→KiCad symbol converter for the 11 captured public pinouts; netclass/diff-pair capture; board↔CAD + BOM↔envelope cross-probes; kibot outputs (needs kibot install).
- U-Boot RV64 build + OpenSBI→U-Boot boot-chain evidence.
- Makefile pattern rules (~40 cocotb + ~80 check one-liners).

---

## In-progress by running swarms (DO NOT duplicate)
- **OpenLane** `e1_chip_top` sky130 full signoff (ws2; bootrom string fix landed; held EDA lock).
- **16KB SRAM** OpenRAM macro build (running).
- **Chipyard Verilator** Linux smoke (cycle-accurate boot, running).
- **Cuttlefish `cvd`** Android riscv64 boot (running → AOSP/android gates).
- **CAD/mechanical** regen swarm (185 dirty files).

---

## Genuinely external — NOT doable on this machine (fail-closed by design)
- Foundry PDK agreements + advanced-node closure (TSMC N2P/A14, Samsung SF2P, Intel 14A); foundry IO cells/padframe ESD.
- Commercial signoff (Ansys Voltus/RedHawk/PrimePower IR/EM; SI/PI with package model).
- Fabricated silicon: MLPerf power (Joulescope/Monsoon), secure-boot key ceremony, DICE on-device attestation, real EVT/lab measurements (mass/IP/drop/RF/thermal).
- Real PCB fabrication, supplier B-rep/pinout returns, mold-flow signoff, first-article inspection, factory test.
- AlphaChip `plc_wrapper_main` / DREAMPlace tarballs (closed-source, HTTP 403).
- Full AOSP source build (~600GB) + signed Android partition images.
- LPDDR5X/6 analog PHY (closed IP).
- OpenTitan full IP-set integration (XL; vendoring + audit) — RoT skeleton + lifecycle/OTP landed; full crypto-block wiring is large.
