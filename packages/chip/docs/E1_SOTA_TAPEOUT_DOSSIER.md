# Eliza E1 — Design → Tapeout SOTA Dossier

**Date**: 2026-05-20
**Branch**: `develop` @ `bd21824ee4`
**Authors**: Synthesised from nine parallel review agents (see Section 13)
**Claim boundary**: Research-and-plan artifact. None of the items below promote any silicon, RTL, BSP, or PD claim beyond what the existing in-tree `forbidden_claims_until_*` gates already permit.

This dossier consolidates the output of nine parallel subagent reviews into a single end-to-end plan covering (1) what the E1 chip is today, (2) every concrete cleanup the codebase needs (DRY, types, validation), (3) every SOTA optimisation we can ship from now through tapeout, with paragraph-length rationale linking the research and the code, and (4) a priority-ordered execution plan. The companion `research/downloads/` folder (~840 MB, 735 PDFs, gitignored) is the local mirror of the primary sources cited throughout.

---

## 0. Headline assessment

The chip is a **pre-tapeout, evidence-gated scaffold** with three distinctive strengths and three structural weaknesses.

**Strengths**

1. **Fail-closed evidence discipline is the best part of the project.** Every spec-DB YAML carries `schema:`, `as_of:`, `claim_boundary:`, and `forbidden_claims_until_complete`. Every claim has a matching `scripts/check_*.py`. The `tapeout-readiness` aggregator reports 40 PASS / 0 FAIL / 8 BLOCKED as of 2026-05-20; **no claim has been silently promoted**.
2. **PD methodology is the most mature surface.** PSM static IR-drop enabled, PDN topology explicit, util-regression gate locked at ≤1.05 after the 771.788% incident, tool digests recorded, AlphaChip integrated alongside OpenROAD and DREAMPlace through a common `.plc` interchange validated by post-route PPA — the right answer to the arXiv 2302.11014 "False Dawn" critique. 9/9 PD gates PASS.
3. **The research surface is unusually deep.** 818 primary sources across 10 area packets, every shortlist item mapped to spec-DB rows, every High-confidence row claimed "landed" cross-checks against actual code anchors. 735 of those sources are now mirrored locally under `research/downloads/`.

**Structural weaknesses**

1. **No single source of truth for chip nameplate stats.** The repo carries **six different "core count" answers** in the same product, and the NPU dense-INT8 TOPS target appears as 160 in spec-DB but 44 in the rail plan. No gate currently catches the drift. Detail in Section 6.
2. **The NPU is not the chip its specs describe.** `rtl/npu/e1_npu.sv` is a 1083-line single-ALU MMIO peripheral with a 64-byte scratchpad, 3×3×7 micro-GEMM, and 5-orders-of-magnitude gap to the 160-TOPS dense-INT8 / 512-TOPS sparse-INT4 / 900-TOPS INT2 BitNet targets. The 4-bit opcode field is **100% allocated**, so any of the planned MX, group-INT4, sparse-tile, or FlashAttention opcodes will force a renumbering. Two perf counters lie (PERF_CYCLES/PERF_MACS only fire inside GEMM; PERF_THERMAL_THROTTLE is a host-writable shadow latch). Detail in Section 7.
3. **The "production" coherent fabric exists in name only.** `rtl/cache/coherence/tl_c_to_chi_bridge.sv` is named TileLink-C → CHI but is a flat AXI4 line-burst FSM with no real TL-C channel discipline (no probe, no release, no Branch/Trunk/Tip permissions). The interrupt controller is a 4-source PLIC-shaped slave (not a real PLIC). Zicbom/Zicbop/Zicboz are required by `cpu-2028-target.yaml` but have **zero RTL hits** in the tree. Multi-master MESI is structurally present but never exercised because the cluster is in lite-tieoff mode. Detail in Section 8.

The dossier below converts those three weaknesses into a sequenced plan, then layers every SOTA optimisation we can ship on top.

---

## 1. Repository state snapshot

| Surface | State | Path | Notes |
|---|---|---|---|
| RTL — top integration | 2 parallel 2.5k-LoC tops | `rtl/top/e1_soc_top.sv`, `rtl/top/e1_soc_integrated.sv` | Duplicate CLINT/DRAM/MMIO scaffolding verbatim |
| RTL — NPU | 1 file, scalar ALU | `rtl/npu/e1_npu.sv:1-1083` | 16/16 opcode slots used; 5-orders-of-mag gap to targets |
| RTL — CPU cluster | CVA6 v5.3.0 in slot-0, big/mid cores in lite-tieoff | `rtl/cpu/cluster/e1_cluster_top.sv`, `rtl/cpu/e1_cva6_wrapper.sv` | Only one hart live |
| RTL — BPU | R7 closure landed | `rtl/cpu/bpu/*.sv` | MPKI gap from 17-27× to 1.4-4.4× vs behavioural model |
| RTL — coherence | TL-C in name only | `rtl/cache/coherence/tl_c_to_chi_bridge.sv` | No probe/release/permission distinction |
| RTL — interconnect | AXI4 production, AXI-Lite legacy still present | `rtl/interconnect/axi4/e1_axi4_interconnect.sv` (701 LoC) | MMR/W1C exists but MMIO slave is `future_work` |
| RTL — debug | 4-bit MMIO bridge, no RVdebug | `rtl/debug/e1_dbg_mmio_bridge.sv` | `JTAG_TDO = 1'b0` at `rtl/top/e1_chip_top.sv:47` |
| RTL — security | one lifecycle file; rest spec-only | `rtl/security/e1_lifecycle.sv` | OpenTitan IP set is spec-only |
| Compiler/runtime | ~22 000 LoC Python + 600-LoC C++ MLIR skeleton | `compiler/runtime/`, `compiler/iree-eliza-npu/`, `compiler/executorch-eliza/` | Two parallel ExecuTorch backends; IREE `ConvertLinalgToElizaNpu` returns `failure()` |
| Verification | 65 cocotb tests, 9 SBY blocks, 4 SVA packs | `verify/cocotb/`, `verify/formal/`, `verify/properties/` | Only 3 k-induction proofs; rest BMC depth 4-24 |
| PD / EDA | Sky130A end-to-end; 4 advanced-node lanes blocked | `pd/openlane/`, `pd/openroad/`, `pd/signoff/` | 40/0/8 tapeout-readiness aggregator |
| Software / BSP | OpenSBI pinned, U-Boot/Linux/AOSP scaffolds | `sw/opensbi/`, `sw/u-boot/`, `sw/linux/`, `sw/aosp-device/` | Address-map split-brain (UART 0x10000000 vs 0x10001000) |
| Firmware | identity boot ROM + Ibex AON PMC | `fw/bootrom/`, `fw/pmc/`, `fw/opensbi-payloads/` | No executable boot ROM, no boot SRAM |
| Benchmarks | CoreMark/STREAM/lmbench/fio + NPU sim flow | `benchmarks/` | `run_benchmarks.py` (2,097 LoC) reimplements parsers inline (triple duplication) |
| Scripts | 135 `check_*.py`, 1,447-line Makefile | `scripts/`, `Makefile` | 51× re-implemented `yaml.safe_load`; shared `chip_utils.py` used by only 20/135 |
| Research | 813 sources, 12 area packets | `research/` | 735 mirrored locally in `research/downloads/` |

---

## 2. End-to-end pipeline state (design → tapeout)

The mental model below treats the design as nine sequenced stages. Each stage's row records the current status, the binding gate, and the next concrete unblock.

| Stage | Status | Binding gate | Next unblock |
|---|---|---|---|
| 1. Architecture spec / contracts | Mature but drifting | No `chip-topology.yaml` single source of truth | §6.1 — author `docs/spec-db/chip-topology.yaml` |
| 2. RTL — leaf blocks (NPU, BPU, DMA, display, cache prefetchers) | Mostly landed at smoke quality | NPU opcode-space full; prefetchers not bound to L1D/L2 | §7.A, §8.D |
| 3. RTL — integration (cluster, fabric, IOMMU, debug, PMC) | Partial; cluster in lite-tieoff | TileLink-C bridge is AXI4-burst FSM; no RVdebug; PLIC is 4-source shim | §8.A.4, §8.A.5 |
| 4. Verification — cocotb, formal, coverage | 65 tests, 3 k-induction proofs | BPU/cache/AXI4/CPU/integration/power have no cover-points; z3 disagreement silently absorbed | §9.B, §9.D |
| 5. Software — boot ROM, OpenSBI, U-Boot, Linux | Pinned + scaffolds | Address-map split-brain; no executable boot ROM; CLINT missing in RTL | §10.B |
| 6. Software — Android RV BSP | AOSP skeleton + HAL smoke | Cuttlefish RV64 BLOCKED on virtio-gpu | §10.C |
| 7. Physical design — open PDK (Sky130A) | Routes; 2 reports waived | Antenna + STA reports against fail-regex | §11.A |
| 8. Physical design — production PDK | Procurement-blocked | TSMC N2P/A14, Samsung SF2P, Intel 14A all need foundry agreements | §11.D |
| 9. Tapeout — package + board + bringup | Concept + planning YAMLs | Padframe pads are scaffold; KiCad mainboard unrouted; package is planning QFN64 | §11.E |

The "stage with the lowest activation energy and highest leverage" right now is **Stage 1**: author `docs/spec-db/chip-topology.yaml` + cross-file consistency gate. It unblocks honest claims everywhere downstream (datasheet, BSP headers, claim tables) and costs ~1 day.

---

## 3. Master cleanup checklist (DRY / consolidation / dead-code)

Grouped by surface. Every item has `file:line` anchors. Confidence rating: **H** = mechanical migration, no risk; **M** = needs design judgement; **L** = depends on a decision the user must make.

### 3.1 Top-level RTL

| # | Item | Anchor | Conf | Action |
|---|---|---|---|---|
| H1 | Duplicate `DRAM_WORDS` localparam | `rtl/top/e1_soc_top.sv:49-53`, `rtl/top/e1_soc_integrated.sv:195-199` | H | Extract to `rtl/top/e1_soc_pkg.sv` |
| H2 | Duplicate CLINT register block (msip/mtime/mtimecmp + decode) | `rtl/top/e1_soc_top.sv:118-184`, `rtl/top/e1_soc_integrated.sv:268-340` | H | Extract `rtl/peripherals/e1_clint.sv` and instantiate from both tops |
| H3 | Duplicate MMIO decode (`bootrom_sel`, `dma_sel`, …) | `rtl/top/e1_soc_top.sv:141-150`, `rtl/top/e1_soc_integrated.sv:290-306` | H | Extract `rtl/peripherals/e1_mmio_decode.sv` |
| H4 | Duplicate behavioural DRAM | `rtl/top/e1_soc_top.sv:117-`, `rtl/top/e1_soc_integrated.sv:267-` | H | Extract `rtl/memory/e1_behavioral_dram.sv` |
| H5 | Hard literal `NUM_CPU_CORES=8` in SoC top | `rtl/top/e1_soc_integrated.sv:149` | H | Replace with `e1_topology_pkg::NUM_CORES` (see §6) |
| H6 | `AXI_ID_W=4` in SoC top vs `=8` in cluster (forces adapter shim) | `rtl/top/e1_soc_integrated.sv:173` vs `rtl/cpu/cluster/e1_cluster_top.sv:58` | M | Pick one (8 per `docs/arch/interconnect.md`) and remove the adapter |
| H7 | Dead JTAG pad tie-off | `rtl/top/e1_chip_top.sv:47` (`JTAG_TDO = 1'b0`) | M | Either remove JTAG pins from the pad ring or wire a real DM-TAP (see §7.D Debug) |
| H8 | `e1_pd_smoke_top.sv` (47 LoC) likely dead | `rtl/top/e1_pd_smoke_top.sv` | M | Verify usage in `pd/openlane/`; delete if unreferenced |
| H9 | Duplicate AXI4 safe-idle tieoff blocks | `rtl/cpu/cluster/e1_cluster_top.sv:182-263`, `rtl/cpu/e1_cva6_wrapper.sv:357-394`, `rtl/top/e1_soc_integrated.sv:566-700` | H | Extract `rtl/interconnect/axi4/e1_axi4_master_tieoff.sv` |

### 3.2 NPU + compiler

| # | Item | Anchor | Conf | Action |
|---|---|---|---|---|
| H10 | `HelloNpuRuntime = E1NpuRuntime` dead alias | `compiler/runtime/e1_npu_runtime.py:1650` | H | Delete |
| H11 | `golden_gemm_s4` is one-line alias for `golden_gemm_s8` (hides INT4 lane decode) | `compiler/runtime/e1_npu_runtime.py:1580-1581` | M | Drop the alias; require encode/decode at the ABI boundary |
| H12 | IREE `ConvertLinalgToElizaNpu.cpp` body is `return failure();` | `compiler/iree-eliza-npu/lib/Transforms/ConvertLinalgToElizaNpu.cpp:41-50` | M | Either land a minimal `linalg.matmul → elizanpu.gemm_s8` pattern or unregister the pass |
| H13 | `EmitDescriptorTablePass` + `AssignScratchPass` are no-ops | `compiler/iree-eliza-npu/lib/Transforms/EmitDescriptorTable.cpp:25-30`, `.../AssignScratch.cpp:28-37` | H | Collapse to one stub or delete |
| H14 | **Two parallel ExecuTorch backends** | `compiler/runtime/e1_executorch_delegate.py` (392 LoC, dataclass) vs `compiler/executorch-eliza/backend/` (242 LoC, GraphNode) | L | Pick one. Recommendation: keep `compiler/runtime/e1_executorch_delegate.py`; delete `compiler/executorch-eliza/backend/` after confirming nothing imports it |
| H15 | 30+ near-duplicate `Lowered*Result` dataclasses, all with `cpu_fallback: bool = False` | `compiler/runtime/e1_npu_lowering.py:198-2160` | M | Base class + per-op subclasses; or drop the per-result dataclass for `LoweringEvidence(payload: dict)` |
| H16 | `cpu_fallback: bool` always `False` in every lowering | `compiler/runtime/e1_npu_lowering.py` (≥10 occurrences) | H | Delete the field |
| H17 | 5 quantization calibrators with identical `to_json` + `math.ldexp(1.0,-24)` + scale ceilings | `compiler/quantization/{awq_int4,gptq_int4,fp8_e4m3_calibration,int2_bitnet,ptq_int8,sparse_2_4}.py` | H | Extract base + shared `MIN_SCALE`; saves ~150 LoC |
| H18 | Module-level free function mirrors of delegate methods (triple-declared) | `compiler/runtime/e1_executorch_delegate.py:142-375`, `e1_litert_delegate.py:159-340` | H | Keep methods, expose `make_e1_*_delegate()` factory |
| H19 | Tile constants live in 11 places (RTL, Py, C, MLIR, JSON, partitioner, …) | search `kScratchBytes`, `MAX_ENTRIES`, `DESC_RING_ENTRIES`, `SCRATCH_BYTES`, `M=3 N=3 K=7` | M | Generate from `e1-npu-runtime-contract.json` |

### 3.3 CPU / memory / interconnect

| # | Item | Anchor | Conf | Action |
|---|---|---|---|---|
| H20 | Memory map duplicated across 7+ places | `docs/arch/memory-map.md`, `docs/arch/interconnect.md`, `docs/arch/memory-subsystem.md`, `docs/spec-db/axi4-interconnect-mmio.yaml`, `rtl/interconnect/e1_axi_lite_interconnect.sv:174`, `rtl/interconnect/axi4/e1_axi4_interconnect.sv:49-50`, `rtl/top/e1_soc_integrated.sv:1061,2145,2334`, `rtl/iommu/e1_riscv_iommu.sv:53` | H | Single `docs/spec-db/e1-memmap.yaml` + generator → `rtl/top/e1_memmap_pkg.sv` + DTS fragment |
| H21 | Three independent address decoders | `rtl/interconnect/e1_axi_lite_interconnect.sv:174-210`, `rtl/interconnect/axi4/e1_axi4_interconnect.sv:178-205`, `rtl/top/e1_soc_integrated.sv:1041-1090` | M | Tombstone AXI-Lite decoder once AXI4 has cocotb parity |
| H22 | Two QoS taxonomies with name collisions | `rtl/cache/cache_pkg.sv` (8 classes, 3-bit) vs `rtl/interconnect/axi4/e1_axi4_pkg.sv` (7 classes, 4-bit) | M | Pick one (recommend 4-class spec-DB scheme); add explicit mapping |
| H23 | Chipyard manifest mirrored at two paths | `generators/chipyard/eliza-rocket-manifest.json`, `docs/generators/chipyard/eliza-rocket-manifest.json` | M | Generator emits canonical; mirror checks hash |
| H24 | Cluster lite-tieoff and pre-link-tieoff are byte-identical | `rtl/cpu/cluster/e1_cluster_top.sv:182-219` vs `:227-264` | H | Collapse two `ifdef` arms into one |

### 3.4 Verification

| # | Item | Anchor | Conf | Action |
|---|---|---|---|---|
| H25 | `axi_lite.sv` and `axi_lite_protocol.sv` are near-duplicates | `verify/properties/axi_lite.sv`, `verify/properties/axi_lite_protocol.sv` | H | Delete `axi_lite.sv`; rebind `dma_axil.sby` to `axi_lite_protocol_props` |
| H26 | 9× redefined cocotb helpers (`reset`, `write_reg`, `read_reg`, `word_read/write`) | `test_e1_npu.py`, `test_e1_dma.py`, `test_e1_display.py`, `test_e1_chip.py`, `test_e1_soc.py`, `test_cpu_mem_intc_contract.py`, `dma/test_dma_long_transfer.py`, `display/test_display_timing.py`, `npu/test_iree_tiny_mlp_e2e.py` | H | New `verify/cocotb/common.py` |
| H27 | 7 sub-package Makefiles repeat identical prelude with drifting `-Wno-*` lists | `verify/cocotb/*/Makefile` | H | New `verify/cocotb/common.mk` |
| H28 | 6 `.sby` files share preludes (engines, `read -formal -sv reset_properties.sv` + `cdc_properties.sv`) | `verify/formal/*.sby` | M | Generator `scripts/gen_sby.py` from per-block YAML manifests |
| H29 | `verify/check_stub_audit.py` allowlist drifts from `rtl_gap_work_order.yaml` | `verify/check_stub_audit.py:58-229` | M | Cross-validate allowlist `rationale` against `gap_id` |
| H30 | `MAX_STALL=64` (axi_lite.sv) vs `MAX_STALL=256` (axi_lite_protocol.sv) | `verify/properties/axi_lite.sv:26`, `verify/properties/axi_lite_protocol.sv:36-37` | H | Single `docs/arch/verification-budgets.md` |

### 3.5 PD

| # | Item | Anchor | Conf | Action |
|---|---|---|---|---|
| H31 | Explicit PDN topology only in `config.sky130.json` | also `config.gf180.json`, `config.ihp-sg13g2.json`, `config.sky130.exploratory.json`, `config.gf180.exploratory.json`, `config.pd-smoke.sky130.json` | M | Either OpenLane2 `_includes` or per-PDK explicit block |
| H32 | 3 SDC files duplicate `set_units` / false-path / I/O delay stanzas | `pd/constraints/e1_soc.sdc` (100ns), `e1_soc_gf180.sdc` (50ns), `e1_pd_smoke.sdc` (20ns) | M | One `pd/constraints/e1_soc_common.sdc` `source`d by each |
| H33 | 8 PDK-blocked manifests with parallel boilerplate | `pd/{corner,library}-manifests/{tsmc-n2p,tsmc-a14,intel-14a,samsung-sf2p}.yaml` | M | Jinja template + 4 specializations |
| H34 | `*-stub/` folders look duplicated; **keep them all** | `pd/{a14-stub,intel-14a-stub,n2p-stub,sf2p-stub,asap7}/` | — | NO ACTION. Each stub is a procurement-gate evidence file; `asap7/` is the active predictive flow (consider renaming `asap7/` → `asap7-predictive/`) |
| H35 | `scripts/check_pd_signoff.py` re-declares `REQUIRED_ARTIFACTS` already in JSON schema | `scripts/check_pd_signoff.py`, `pd/signoff/run-manifest.schema.json` | H | Generate Python dict from schema at import time |
| H36 | Archive run reports inconsistent (.md+.yaml vs .yaml-only) | `pd/signoff/reports/` | H | `scripts/archive_pd_signoff_run.py` always emit both |

### 3.6 Software / BSP / firmware

| # | Item | Anchor | Conf | Action |
|---|---|---|---|---|
| H37 | 4 hand-maintained DTS files duplicating SoC node graphs | `dts/eliza-e1.dts`, `eliza-e1-qemu.dts`, `eliza-e1-soc.dtsi`, `eliza-e1-android.dts` | H | All `#include` the generated `e1-platform.dtsi` |
| H38 | Identical "Expected output" 25-line block in two READMEs | `docs/sw/opensbi/README.md`, `docs/sw/u-boot/README.md` | H | Shared anchor or one Markdown include |
| H39 | `qemu_riscv64_smoke.log` and `renode_e1_soc_smoke.log` claim PASS but only contain `--version` lines | `docs/evidence/sim/qemu_riscv64_smoke.log`, `docs/evidence/sim/renode_e1_soc_smoke.log` | H | Relabel as BLOCKED |
| H40 | Address-map split-brain — UART 0x10000000 (boot ROM) vs 0x10001000 (Linux DTS) | `fw/opensbi-payloads/e1-smode/e1.c:9` vs `dts/eliza-e1.dts` | M | Pick chip-variant UART address; align both |

### 3.7 Benchmarks + scripts + build infra

| # | Item | Anchor | Conf | Action |
|---|---|---|---|---|
| H41 | Only 20/135 `check_*.py` import `scripts/chip_utils.py`; 51× redo `yaml.safe_load`, 52× redo `json.load` | search across `scripts/check_*.py` | H | Mechanical migration |
| H42 | `run_benchmarks.py` (2,097 LoC) **reimplements** `benchmarks/parsers/parse_{coremark,stream,lmbench,fio,tflite}.py` inline TWICE | `benchmarks/run_benchmarks.py:1276-1350+` | H | Replace inline regex with imports from canonical parsers |
| H43 | Two incompatible BLOCKED conventions (`STATUS: BLOCKED <id>` stdout vs JSON `"status": "BLOCKED"`) | `scripts/aggregate_tapeout_readiness.py` classifier | H | Standardise on JSON; aggregator reads files not stdout |
| H44 | 58 `eliza.*.v1` schemas declared as string constants in check scripts; only 3 have external schema files | search `'schema': 'eliza\.'` across scripts | M | Single `schemas/` directory + pydantic validators |
| H45 | Dead scripts: `check_pmic_daughtercard_bom.py`, `check_pad_consistency.py`, `check_bsp_next_import_step.py`, two `zzz-root-owned-build-preserved*/` escape dirs | search | H | Confirm + delete |
| H46 | ~40 near-identical `cocotb-*` Makefile rules + ~80 trivial `@python scripts/check_*.py` one-liners | `Makefile` | M | Pattern rules |
| H47 | Docker policy violations — `scripts/build/docker_build_tier2.sh` forces Docker on Linux x86_64 (against `packages/chip/CLAUDE.md`) | also `scripts/bootstrap_llvm_container.sh`, `scripts/alphachip/*` | M | Refactor to native-first wrapper |

---

## 4. Master type / validation checklist

| # | Item | Anchor | Conf | Action |
|---|---|---|---|---|
| T1 | No JSON-Schema or pydantic model for any `docs/spec-db/*-target.yaml` despite every file declaring `schema:` | all of `docs/spec-db/` | H | New `scripts/spec_db_models.py` with pydantic v2 |
| T2 | 0 TypedDict, 0 pydantic, 9 dataclasses across 135 check scripts | `scripts/check_*.py` | H | Migrate to typed loaders |
| T3 | `verify/regression_seeds/*.yaml`, `verify/ai_eda/*.yaml` declare schemas without validators | `verify/ai_eda/`, `verify/regression_seeds/` | H | `scripts/check_verify_ai_eda_manifests.py` + `verify/ai_eda/schemas/*.json` |
| T4 | cocotb DUT handles fully untyped (`pyproject.toml` masks via per-file `F821` ignore) | `verify/cocotb/*.py`, `pyproject.toml` `[tool.ruff]` | M | Generated `<top>_dut.pyi` stubs from testbench port lists |
| T5 | No `[tool.pytest.ini_options]` block | `pyproject.toml` | H | Add `minversion`, `testpaths`, `--strict-markers`, marker enum |
| T6 | RTL parameter literals not derived from package constants (e.g. `AXI_ID_W=4` re-declared per file) | see §3.1 H6 | H | New `rtl/top/e1_topology_pkg.sv` + import sites |
| T7 | No cross-file invariant checker for the same number appearing in multiple YAMLs | spec-db YAMLs + rail plan + operating point + AOSP gate | H | New `scripts/check_chip_stats_consistency.py` (see §6) |
| T8 | Property files use parameter defaults that disagree | `MAX_STALL=64` vs `256` | H | Single budgets file (see §3.4 H30) |
| T9 | NPU runtime contract has 25+ near-clone `*_lowering_smoke` subsections | `docs/spec-db/e1-npu-runtime-contract.json` | M | Single `(op, precision) → SupportEntry` table |
| T10 | `dict[str, Any]` is the de-facto currency in compiler runtime (78 occurrences in `e1_npu_lowering.py`) | `compiler/runtime/e1_npu_lowering.py` | M | TypedDict/msgspec/pydantic per lowering family |
| T11 | RTL operands silently truncate (`gemm_m <= wdata[1:0]`, etc.) | `rtl/npu/e1_npu.sv:891-911` | M | Host-side range assertions matching contract |
| T12 | `gemm_cfg_ok` uses magic `8'd128` for INT4 nibble mode | `rtl/npu/e1_npu.sv:417-425` | H | `localparam SCRATCH_NIBBLES = SCRATCH_BYTES*2` |
| T13 | `PERF_CYCLES`/`PERF_MACS` only count GEMM (not packed dots) | `rtl/npu/e1_npu.sv:609,615,649` | M | Either fix RTL to count all opcodes or rename + document |
| T14 | `PERF_THERMAL_THROTTLE` is a **host-writable shadow latch**, exposed as a HAL signal | `rtl/npu/e1_npu.sv:931-934`, `compiler/runtime/e1_npu_runtime.py:1244-1254` | H | Rename `thermal_throttle_sim_shadow`; mark "simulation-only" in API |

---

## 5. SOTA optimisation roster (paragraph + paper + code links)

Each item below is sized for a single workstream ticket. The convention is: **rationale paragraph → research anchor → existing code anchor → effort tier (S/M/L/XL)**.

### 5.1 NPU datapath and opcodes

**5.1.1 OCP Microscaling (MXFP8/MXFP6/MXFP4/MXINT8) operand fetch — A-1**
Block-scale low-precision FP is the single largest perf/W lever in 2028-class mobile NPUs. Blackwell, Trillium, and the Exynos 2600 all converge on shared-E8M0 exponent across 32-element blocks. The chip's `precision_matrix` enumerates the four MX formats with `state: blocked_l2_planned` (`docs/spec-db/e1-npu-runtime-contract.json:902-933`) and the microarch doc spells out the OCP MX semantics (`docs/arch/npu.md:187-208`), but no opcode, no operand fetch path, and no compiler lowering exists. The existing `DOT4_FP8_E4M3` opcode is unscaled scalar E4M3 with Q8.8 accumulation — not the production format. Landing MX requires (a) an E8M0 shared-scale operand decoder, (b) a widened accumulator (FP32 or INT32 + per-group scale), and (c) a new opcode group, which forces the opcode-renumbering described in §5.1.6 below.
*Research*: `research/npu_accelerator_2026/02_analysis/quantization_int4_int2_fp8.md`, `research/downloads/npu_accelerator/{ocp_mx_spec, mx_formats_paper, microxcaling_repo, ptq_mx_paper}.pdf`.
*Code*: `rtl/npu/e1_npu.sv:494-498,282-296`.
*Effort*: L (RTL + compiler lowering + cocotb + formal).

**5.1.2 Group-INT4 W4A16 GEMM (`GEMM_S4_GS32/64/128`) — A-2**
Dense-LLM-decode weight bandwidth is the dominant on-device LLM energy term; group-INT4 cuts it 4× over INT8 and is the most high-confidence near-term win. The contract enumerates the three group sizes as `L1_planned` (`docs/spec-db/e1-npu-runtime-contract.json:947-975`), the calibrators exist as stubs (`compiler/quantization/awq_int4.py`, `gptq_int4.py`), and the runtime smoke `lower_group_scaled_int4_matmul_smoke` already implements the math in scalar `MUL_LO`/`ADD` (`compiler/runtime/e1_npu_lowering.py:1658-1741`). The blocker is RTL: a per-K-group scale fetch path plus int32 accumulator shift.
*Research*: `research/downloads/npu_accelerator/{gptq_paper, awq_paper, omniquant_paper, hqq_repo}.pdf`.
*Effort*: M (one opcode, scratchpad scale fetch, calibrator promotion).

**5.1.3 BitNet ternary multiplier-free datapath — A-3**
BitNet b1.58 / a4.8 / 2b4t make INT2 a deployed precision (MediaTek NPU 990 ships with it). The chip's `DOT16_S2` already enters ternary lane decode under `CMD_PARAM[1]=1` with 0b00/0b01/0b10 = {0,+1,-1} and 0b11 fail-closed (`rtl/npu/e1_npu.sv:240-280,475-492`). **But the ternary path still goes through the same lane multiplier as the signed-2 path** — only the decode changes. The R-BITNET-TERN optimisation (sign-flip + sum, no multiplier) is the one that actually saves energy per ternary MAC.
*Research*: `research/downloads/npu_accelerator/{bitnet_b1_58_paper, bitnet_a4_8_paper, bitnet_2b4t_hf}.pdf`.
*Effort*: S (replace the 2-bit lane multiplier with a sign-flip/zero-mux for ternary mode only).

**5.1.4 2:4 sparse INT4 tile-level GEMM — A-4**
Trainium2 demonstrates 4× sparse-INT8 ratio; 2:4 sparse INT4 doubles effective TOPS on pruned LLMs and is the largest single step toward the 512 sparse-INT4 peak target. Today the scalar primitive (`OP_SDOT4_S4_2_4`) exists but no tile-level metadata path, no sparse-decode microengine.
*Research*: `research/downloads/npu_accelerator/{sparsegpt_paper, wanda_paper, maskllm_paper, trainium2_aws_docs}.pdf`.
*Code*: `rtl/npu/e1_npu.sv:43,452-456`, `compiler/runtime/e1_npu_lowering.py:1587-1655`.
*Effort*: L (sparse metadata format + decoder + tile dispatcher).

**5.1.5 FlashAttention-2/3 streaming-softmax engine — A-6**
Eliminates O(N²) attention materialisation; mandatory for any 2028 LLM-class context. KV bandwidth dominates decode power. The chip currently composes attention as separate `lower_attention_qk_smoke` → host requantise → host mask → `lower_attention_softmax_smoke` (scalar `OP_EXP2_NEG_Q0_8`) → host requantise → `lower_attention_av_smoke` (`compiler/runtime/e1_npu_lowering.py:3372-3520`). Each leg is a separate GEMM_S8 dispatch; nothing streams. The R-ATTN-ENGINE recommendation correctly places this at L3 because it depends on the tile fabric existing first.
*Research*: `research/downloads/npu_accelerator/{flashattention2_paper, flashattention3_paper, fusemax_paper, spatten_paper}.pdf`.
*Effort*: XL (row-streaming softmax, online normaliser state, tile fabric prerequisite).

**5.1.6 Paged-KV + MLA + GQA — A-7**
Required to deliver `concurrent_contexts_min: 8` (`docs/spec-db/npu-2028-target.yaml:78`). Today `lower_kv_cache_update_smoke` is append-only via `OP_ADD(value, 0)` scalar copies; no page table, no block indirection, no eviction, no GQA head sharing, no MLA low-rank projection. Hardware page table walker on the descriptor engine + per-context page allocation are pre-conditions.
*Research*: `research/downloads/npu_accelerator/{vllm_paged_attention, streamingllm_paper, h2o_paper, kivi_paper, deepseek_v2_mla}.pdf`.
*Effort*: XL.

**5.1.7 Opcode-space renumbering (binding constraint)**
The 4-bit opcode field is 100 % allocated (`rtl/npu/e1_npu.sv:31-46`). Every planned tensor opcode above requires either variable-length encoding or a wider opcode field. **This is the single binding constraint** on §5.1.1, §5.1.4, and §5.1.5. Nothing in the codebase plans for the extension.
*Effort*: M (descriptor word0 format change + Python runtime + MLIR dialect verifier + IREE pin).

**5.1.8 Perf-counter honesty fix — A-8**
`PERF_CYCLES`/`PERF_MACS` only increment inside GEMM (`rtl/npu/e1_npu.sv:609,615`); a billion DOT16_S2 commands records `macs=0`. `PERF_THERMAL_THROTTLE` is by its own contract a host-writable shadow latch (`docs/spec-db/e1-npu-runtime-contract.json:80-87`, `rtl/npu/e1_npu.sv:931-934`) but is exposed in `E1NpuRuntime.extended_perf` without that simulation-only context. This is exactly the "fallback that hides failure" pattern AGENTS.md warns against and must be fixed before any perf/W claim graduates.
*Effort*: S (RTL counter wiring + Python API rename).

**5.1.9 Accelergy + Timeloop closing the loop — G-5**
Driver exists (`benchmarks/sim/run_npu_timeloop.py`) but `make benchmark-sim-metrics` does **not** call it, and `energy_pj_per_int8_mac` defaults in `compiler/runtime/e1_npu_scale_model.py:25,124,141,158,175` are hand-set per config. Closing this means the energy table flows from Timeloop → scale model → claim table.
*Research*: `research/downloads/npu_accelerator/{accelergy_repo, timeloop_paper}.pdf`.
*Effort*: S.

### 5.2 Compiler + runtime

**5.2.1 IREE backend linalg→elizanpu lowering**
`compiler/iree-eliza-npu/lib/Transforms/ConvertLinalgToElizaNpu.cpp:41-50` declares a pattern whose `matchAndRewrite` body is a single `return failure();`. The pass is registered as `createConvertLinalgToElizaNpuPass`, so anyone building the dialect assumes a linalg→elizanpu lowering exists. It does not. Either land a minimal `linalg.matmul → elizanpu.gemm_s8` pattern wrapping the same 3×3×7 envelope the Python lowering uses, or delete the file and stop registering the pass.
*Research*: `research/downloads/compiler_runtime/iree_repo`.
*Effort*: M to land properly; S to delete.

**5.2.2 Single ExecuTorch backend**
Two parallel skeletons exist: `compiler/runtime/e1_executorch_delegate.py` (dataclass-based, consumes StableHLO) and `compiler/executorch-eliza/backend/` (GraphNode-based, narrow op set). They will drift. Keep the partitioner-consuming Python delegate; delete the older effort.
*Research*: `research/downloads/compiler_runtime/executorch_repo`.
*Effort*: S.

**5.2.3 StableHLO canonicalisation pipeline**
The strongest piece of the compiler stack today is `e1_npu_stablehlo.py` (1,462 LoC: parser, IR dataclass, validator). But there is **no canonicalisation** — no op fusion, no layout transformation, no constant folding. The module is consumed verbatim. Adding canonicalisation under `compiler/runtime/e1_npu_canonicalize.py` (or pushing it through MLIR proper once IREE builds) unlocks downstream fusion wins like attention/softmax fusion and conv-bn-relu folding.
*Research*: `research/downloads/compiler_runtime/{openxla_stablehlo, iree_repo, liteRT_blog}.pdf`.
*Effort*: M.

**5.2.4 CommandBuffer descriptor-ring widen**
Today capped at 7 descriptors because the RTL's 3-bit head/tail registers cannot disambiguate full from empty (`compiler/runtime/e1_npu_runtime.py:166,989`). Widening to 4-bit head/tail with a one-bit owner unlocks 15-entry batches at no real cost.
*Effort*: S.

**5.2.5 Flash-Decoding split-K scheduling — B-6**
On-device LLM decode is GEMV-shaped. `lower_matmul_smoke` already splits M/N/K into multiple 3×3×7 tiles and accumulates int32 split-K partial outputs on the host (`compiler/runtime/e1_npu_lowering.py:1393-1445`) — but this saturates the host, not a tile fabric. True Flash-Decoding requires the FlashAttention engine first.
*Research*: `research/downloads/npu_accelerator/{flashdecoding_paper, flashattention2_paper}.pdf`.
*Effort*: bundled with §5.1.5.

### 5.3 CPU subsystem + ISA

**5.3.1 Dual-port FTB for 2-taken-per-cycle BPU**
Highest-leverage geometric next step on the BPU. `bpu_top.sv:82-87` already flags it as BLOCKED with a `lint_off UNUSEDSIGNAL` on `ftb_br_valid` — `MAX_BR_PER_BLOCK=2` is declared but only one branch slot is consumed. Adding the second port effectively doubles fetch throughput on branch-dense workloads.
*Research*: CBP-5 winners 2024.
*Code*: `rtl/cpu/bpu/bpu_top.sv:82-87`.
*Effort*: M.

**5.3.2 Perceptron-SC override + BATAGE — beyond R7**
The R7 commit `57067166f4` closed CBP-5 MPKI from 17-27× to 1.4-4.4× vs the behavioural model. The remaining gap is calibration-shaped. A perceptron-SC override (Jiménez) on hard-to-predict conditionals (kernel I/O, JS dynamic dispatch) plus BATAGE (Bayesian counters in place of 3-bit saturating) are the published next moves.
*Effort*: M each.

**5.3.3 Zicbom/Zicbop/Zicboz**
Required by `cpu-2028-target.yaml:177-186`. Currently **zero RTL hits** in the tree. Without them, every DMA-buf transition needs a vendor-CSR fallback (explicitly forbidden by the spec). Land cbo.inval/clean/flush on the L1D miss/probe path; cbo.zero as a line-write-of-zeros; prefetch.r/w/i as prefetcher hints.
*Effort*: M.

**5.3.4 RVA22U64+V + Saturn vector**
Phase-B carrier for vector. Saturn is tracked-only today (`cpu-2028-target.yaml:67-72`). Saturn lands when BOOM lands. The KunMingHu manifest (`generators/chipyard/eliza-kunminghu-manifest.json`) declares RVA22U64+V but no `riscv-hwprobe` compliance check runs locally.
*Research*: `research/downloads/cpu_subsystem/{rvv_1_0_spec, rva22_profile, rva23_profile, saturn_repo, boom_v4}.pdf`.
*Effort*: XL.

**5.3.5 AIA + Sstc + IMSIC/APLIC**
The current `rtl/interrupts/e1_interrupt_controller.sv` is a 4-source PLIC-shaped AXI-Lite slave, not a real PLIC. AIA (Smaia/Ssaia/IMSIC/APLIC) is in the KunMingHu manifest but nowhere in RTL. Sstc + `stimecmp` CSR likewise. Both are required for Phase-B Linux + Android.
*Research*: `research/downloads/cpu_subsystem/{aia_spec, sstc_spec}.pdf`.
*Effort*: XL.

**5.3.6 RVdebug 1.0 Debug Module + JTAG TAP**
`rtl/top/e1_chip_top.sv:47` ties `JTAG_TDO = 1'b0`. The only "debug" RTL is `rtl/debug/e1_dbg_mmio_bridge.sv` (4-bit MMIO nibble bridge, cocotb-only). Real silicon bring-up requires DM/DTM/DMI per RVdebug 1.0-stable. Pick Chipyard's `debug-module` since the CPU path is already Chipyard. **This is the most concrete missing-subsystem signal in the entire chip top.**
*Effort*: L.

**5.3.7 RVFI tap on CVA6 + riscv-formal compliance**
`e1_cva6_wrapper.sv:319-324` ties RVFI to zero. Wiring it (the upstream CVA6 exposes `rvfi_probes_o`) unlocks the riscv-formal compliance lane.
*Research*: `research/downloads/cpu_subsystem/{riscv_formal_repo, sail_riscv_repo}.pdf`.
*Effort*: M.

### 5.4 Memory + fabric

**5.4.1 TileLink-C real fabric — D-1**
The current `tl_c_to_chi_bridge.sv` is **TL-C in name only** — a flat AXI4 line-burst FSM with no probe, no release, no probeAck data, no Branch/Trunk/Tip permission grants. Phase-B CPU AP (Saturn, KunMingHu) cannot ship without a real TL-C fabric. The cluster sits in lite-tieoff mode (`rtl/cpu/cluster/e1_cluster_top.sv:179-265`), so multi-master MESI is structurally present but never exercised. This is the largest single missing fabric in the chip.
*Research*: `research/downloads/memory_subsystem/{tilelink_spec, chipyard_constellation, chi_e_spec}.pdf`.
*Effort*: XL.

**5.4.2 Mesh NoC via Chipyard Constellation — implicit in D-1**
`memory-2028-target.yaml:166-167` declares `topology: mesh_noc`, `reference_noc: chipyard_constellation`. No Constellation generation; the fabric is a flat AXI4 crossbar.
*Effort*: bundled with §5.4.1.

**5.4.3 LPDDR6 PHY + controller — D-2**
Controller-side stub exists (`rtl/memory/dram_ctrl/e1_dram_ctrl.sv`, 437 LoC, DFI 5.0 north, 128-bit AXI4 south, reorder queue, refresh scheduler). LPDDR PHY is BLOCKED in procurement (closed third-party IP). Real timing not yet modelled (the model behind the controller is still SRAM-backed).
*Research*: `research/downloads/memory_subsystem/{jedec_lpddr6_pre_pub, samsung_lpddr5x_brief, sk_hynix_lpddr5t}.pdf`.
*Effort*: XL.

**5.4.4 SMMU/IOMMU per-master stream IDs — D-3**
`rtl/iommu/e1_riscv_iommu.sv` exists. Stream IDs needed for NPU CMD/DATA, GPU, display, camera, modem, audio.
*Research*: `research/downloads/memory_subsystem/{arm_smmuv3, riscv_iommu}.pdf`.
*Effort*: M (extend existing RTL).

**5.4.5 32 MiB SLC + 64 MiB tiled NPU SRAM — D-4, D-5**
SLC is referenced in `rtl/cache/slc/e1_slc.sv`; full 32-MiB bank build is spec-only. NPU local SRAM target is 64 MiB / 8-16 tiles / 4 MiB each / SECDED / bit-interleaving / ping-pong / ≥20 TB/s; current `e1_weight_buffer_sram.sv` is far smaller.
*Research*: `research/downloads/memory_subsystem/{eyeriss_v2_paper, buffets_isca19, nvdla}.pdf`; `research/downloads/process_packaging/{tsmc_2nm_sram_iedm2023, samsung_2nm_sram_isscc2024}.pdf`.
*Effort*: L + XL.

**5.4.6 Compression-aware DMA — D-6**
`rtl/cache/compression/e1_bdi_compress.sv` and `e1_bdi_decompress.sv` exist for SLC line-level BDI but no DMA-boundary compression. 64-element block format with header + bitmap, modes INT8/INT4/INT2/FP8 KV.
*Research*: `research/downloads/memory_subsystem/{afbc_arm, nvdla}.pdf`.
*Effort*: M.

**5.4.7 DRAM QoS classes — D-7**
Two QoS taxonomies collide today (see §3.3 H22). DRAM controller reorder queue uses round-robin, not class-aware arbitration. ParBS / ATLAS / BLISS are the canonical references for class-aware DRAM scheduling.
*Research*: `research/downloads/memory_subsystem/{parbs_paper, atlas_paper, bliss_paper}.pdf`.
*Effort*: M.

**5.4.8 RowHammer policy — D-8**
TRR + RFM + on-die ECC + link CRC counters required by `memory-2028-target.yaml:334-353`. Controller declares `SUPPORT_LINK_ECC`, `SUPPORT_ODECC` parameters but no actual TRR/RFM/PRAC state machine. No counters surfaced at MMIO.
*Research*: `research/downloads/memory_subsystem/{rowhammer_paper, jedec_rfm_prac}.pdf`.
*Effort*: L.

**5.4.9 Cache stash for CPU → NPU — D-9**
The `memory-2028-target.yaml:319-332` requires <200 ns CPU → NPU command latency. Today no stash hint channel exists. Define a CHI-cache-stash-hint-equivalent producer port on the L2 acquire path; have the L2 forward through `tl_c_to_chi_bridge` into the SLC.
*Research*: Arm CHI-E §"Cache Stash"; Marvell stash-on-write paper.
*Effort*: M.

**5.4.10 Prefetcher binding — bundle**
All five mainline 2020s prefetchers exist as RTL (BO, IPCP, Pythia stub, Berti, SPP, Stride, FDIP) but **none are bound into L1D/L2** — they live as standalone modules. `champsim_sweep.py` records the IPC delta; the gate for which goes default is unblocked but the wiring is not done.
*Research*: `research/downloads/cpu_subsystem/{berti_micro22, ipcp_isca20, pythia_micro21, best_offset_hpca16, spp_micro16, fdip_isca16}.pdf`.
*Effort*: M to bind Berti (L1D) + BO/IPCP (L2).

### 5.5 Security / RoT

**5.5.1 OpenTitan IP set integration — E-1**
The largest single missing subsystem. Spec calls for `rom_ctrl`, `lc_ctrl`, `otp_ctrl`, `keymgr`, `aes`, `hmac`, `entropy_src/csrng/edn`, Ibex sec-MCU — Apache-2.0, silicon-proven via `multiple_tape_outs_via_lowrisc_program`. Today only `rtl/security/e1_lifecycle.sv` exists.
*Research*: `research/downloads/security/{opentitan_rom_ctrl, opentitan_lc_ctrl, opentitan_otp_ctrl, opentitan_keymgr, opentitan_aes, opentitan_hmac, opentitan_entropy_src}.pdf`.
*Effort*: XL.

**5.5.2 AVB 2.0 / libavb BL2 verifier — E-2**
AOSP-standard verified boot. Rollback index lands in OTP partition.
*Research*: `research/downloads/security/{libavb_repo, avb_2_0_spec}.pdf`.
*Effort*: M (BL2 plus OTP partition spec).

**5.5.3 Ed25519 verify on OTBN + SHA-256 via HMAC — E-3**
Constant-time, OpenTitan reference programs already verified.
*Research*: `research/downloads/security/{opentitan_otbn_ed25519, opentitan_hmac}.pdf`.
*Effort*: M.

**5.5.4 dm-verity + FEC, fs-verity — E-4**
AOSP default. ~50 MB hashtree on 5 GB system fits BL2 budget.
*Research*: `research/downloads/security/{dm_verity_kernel_docs, fs_verity_kernel_docs}.pdf`.
*Effort*: S (kernel config + tools).

**5.5.5 ePMP/Smepmp on every hart + IOPMP on interconnect — E-5**
Ratified RV standards. Deny-by-default. Provides DMA isolation the threat model assumes.
*Research*: `research/downloads/security/{epmp_spec, iopmp_spec, smepmp_spec}.pdf`.
*Effort*: L.

**5.5.6 DICE / Open DICE measurement chain — E-6**
KeyMint attestation root. ~1500 LoC Apache-2.0.
*Research*: `research/downloads/security/{open_dice_repo, tcg_dice_spec}.pdf`.
*Effort*: M.

**5.5.7 PQC hybrid Ed25519 + ML-DSA-65 reserved — E-8**
Hedges Ed25519. OpenTitan OTBN can run ML-DSA-65. Reserve `header_version=2` slot.
*Research*: `research/downloads/security/{fips_204_ml_dsa, pqc_hw_paper}.pdf`.
*Effort*: S (slot reservation now; implementation deferred).

### 5.6 Verification

**5.6.1 Z3 disagreement no longer silent**
Captured `e1_dma.2`, `e1_npu.2` SBY logs show z3 returning "did not return a status" while bitwuzla returns pass. Currently treated as PASS (SBY accepts any engine returning pass). Tighten so engine-disagreement raises a flag.
*Effort*: S (SBY post-processor script).

**5.6.2 Cover-points beyond the 5 required blocks**
Today: `npu`, `dma`, `soc`, `chip`, `display` have cover-points. BPU, cache, AXI4, CPU, integration, power do not — despite owning the bulk of the test count. Add per-block cover-point classes.
*Effort*: M.

**5.6.3 k-induction beyond AXI-Lite**
Today only `e1_axi_lite_dram`, `e1_axi_lite_interconnect`, `dma_axil` have `prove` tasks. Pilot k-induction on small leaves (`bpu/ras`, `bpu/ftq`, `bootrom`).
*Effort*: M.

**5.6.4 riscv-arch-test + riscv-dv + RISCOF activation**
The manifest at `verify/riscv-arch-tests/manifest.json` is `pinned_not_run`. No compliance evidence exists. Once CVA6 is buildable (the active `bd21824ee4` commit), wire RISCOF + a `cocotb-riscv-dv` target that streams riscv-dv into Spike + RTL and diffs commit/trap.
*Research*: `research/downloads/cpu_subsystem/{riscv_dv_repo, riscof_repo, spike_repo, sail_riscv_repo}.pdf`.
*Effort*: M.

**5.6.5 NPU formal — lift the `addr<8` and `assume(!start)` ceiling**
`verify/formal/e1_npu_formal.sv` is 120 lines and **forbids the start bit** (`assume(!(... addr==6'h03 && wdata[0]))`), capping coverage at the mirror-register subset. GEMM, descriptor ring, vector, packed-dot, writeback all have **zero formal closure**. Concrete properties to add:
- Descriptor: `desc_tail==desc_head` ⟺ DESC_STATUS[0] empty; on `desc_timeout >= 128`, engine exits via timeout error
- GEMM tile: m/n/k × scratchpad bounds, INT4 nibble-mode address widening, `gemm_acc` overflow
- Vector: `vec_src_base + vec_len <= 64`, `vec_dst_base + vec_len <= 64`
- BW counter monotonicity (DESC_BYTES_READ/WRITTEN, PERF_STALL_CYCLES, PERF_SCRATCH_BYTES) absent a clear
- AXI protocol: bind `verify/properties/axi_lite_protocol.sv` to the NPU
- Thermal-throttle saturation (`rtl/npu/e1_npu.sv:934` wraps silently at 2^32)
*Effort*: M.

**5.6.6 DifuzzRTL / RTLfuzz pilot for NPU**
ML-assisted coverage closure via DifuzzRTL or similar. The chip has the AI-EDA scaffolding (`verify/ai_eda/`) and assertion-candidate manifests; the next step is wiring a feedback loop.
*Research*: `research/downloads/bench_sim_formal/{difuzzrtl_paper, rtlfuzz_paper}.pdf`.
*Effort*: L (research-grade).

**5.6.7 Sail / Spike differential testing**
Spike + Sail-RISC-V checkouts are in `external/`. No model-vs-RTL differential lane runs.
*Effort*: M.

**5.6.8 GLIFT / information-flow SVA for security properties**
Once OpenTitan IP set (§5.5.1) lands, GLIFT info-flow tracking becomes the right path for secure-boot property proofs.
*Effort*: L.

### 5.7 Physical design + tapeout

**5.7.1 Close antenna + STA waivers on Sky130A**
Latest run (RUN_2026-05-19) has 14/17 artifacts present; antenna_report and sta_report are `blocked` against the fail-regex. H-1 (tighter `repair_timing`/`repair_design` margins) already landed; next clean re-run should close them.
*Effort*: S (re-run + verify).

**5.7.2 Lift PDN topology to a shared include**
Currently only `config.sky130.json` carries the explicit PDN block. GF180 and IHP-SG13G2 fall through to pdngen defaults. OpenLane2 supports `_includes` in JSON.
*Effort*: S.

**5.7.3 AlphaChip + AutoDMP + DREAMPlace post-route validation**
Three-placer interchange via Circuit Training `.plc` is already wired through `scripts/run_post_route_ppa.py`. Today only 1 of 4 planned hard macros exists; the proxy win has zero PPA leverage without hard macros. PPO RL training is BLOCKED on H200 GPU access.
*Research*: `research/downloads/pd_eda/{alphachip_nature21, alphachip_addendum, autodmp_repo, circuitnet_2_0, false_dawn_arxiv}.pdf`, `research/downloads/alpha_chip_macro_placement/` (378 mirrored).
*Effort*: M to add the 3 missing hard macros; XL to converge PPO.

**5.7.4 MBFF (multi-bit flop) merging**
Standard mobile-class power/area lever absent from current OpenLane config.
*Research*: `research/downloads/pd_eda/mbff_papers.pdf`.
*Effort*: M (OpenROAD pass + library cells).

**5.7.5 BSPDN / PowerVia parallel variant — I-1**
`process-14a-effects.yaml` declares the variant requirements. Frontside-PDN baseline + backside variant — IR/EM/thermal per variant.
*Research*: `research/downloads/process_packaging/{intel_powervia_vlsi2023, tsmc_super_power_rail, samsung_bspdn_iedm2023}.pdf`.
*Effort*: L (when foundry agreements land).

**5.7.6 On-die thermal sensors + DTM**
DTM control loop is missing. Spec at `docs/architecture-optimization/sota-2028/power-delivery.md` describes the 16-rail target.
*Effort*: M.

**5.7.7 Padframe ESD strategy + IO ring**
Today `pd/padframe/` is a contract scaffold; no foundry IO cells.
*Effort*: L (per-foundry).

### 5.8 Software / BSP / firmware

**5.8.1 Buildroot rv64gc qemu-virt smoke — closest BLOCKED to landing**
The only BLOCKED item not requiring an AOSP checkout or Cuttlefish host. Capture harness already validates `Linux version` / `Welcome to Buildroot` / `login:` markers. Needs `external/buildroot-rv64/output/images/{Image,rootfs.cpio}`.
*Effort*: S (toolchain install + build).

**5.8.2 OpenSBI 1.6 FW_DYNAMIC + U-Boot RV64 — F-1**
Pinned at v1.8.1. The OpenSBI memory-discovery payload is gated by `docs/evidence/cpu_ap/eliza_e1_opensbi_boot.log` (BLOCKED).
*Research*: `research/downloads/bsp_software/{opensbi_1_6, u_boot_rv64, buildroot_riscv64_virt}.pdf`.
*Effort*: M.

**5.8.3 AOSP `aosp_cf_riscv64_phone` template — F-2**
Skeleton structurally complete (BoardConfig, VINTF, sepolicy, 3 HAL trees). Cuttlefish RV64 BLOCKED on virtio-gpu (commit `805a328650`).
*Research*: `research/downloads/bsp_software/{aosp_cuttlefish_rv64, vintf_spec}.pdf`.
*Effort*: L.

**5.8.4 libe1_npu + LiteRT + ExecuTorch HAL — F-3**
NNAPI relegated to legacy compat only. Aligns Android NN path.
*Effort*: M (once §5.2.2 settles).

**5.8.5 Address-map split-brain fix**
`fw/opensbi-payloads/e1-smode/e1.c:9` uses UART `0x10000000` (qemu-virt); Linux DTS targets `0x10001000` (chip variant). Single largest coherence issue in the boot path.
*Effort*: S.

**5.8.6 Real executable boot ROM + boot SRAM region**
Today `rtl/bootrom/e1_bootrom.sv` is 4 identity words (`OSPO`/`CHIP`/`1`/`0x1000`), not executable code. No boot SRAM. Two disagreeing reset vectors (cluster `0x80000000`, CVA6 `0x10000`). The boot path cannot exist coherently in one integrated boot without both.
*Effort*: M.

### 5.9 Benchmarks + scripts

**5.9.1 Unify benchmark parsers**
`run_benchmarks.py` (2,097 LoC) inlines `parse_metrics`, `parse_coremark`, `parse_stream`, … reimplementing the canonical parsers in `benchmarks/parsers/`. Regex drift across the three copies is the failure mode.
*Effort*: M.

**5.9.2 Single BLOCKED convention**
Two incompatible conventions (`STATUS: BLOCKED <id>` stdout vs JSON `"status": "BLOCKED"`). Standardise on JSON files; aggregator reads files not stdout (currently classifies via stdout-prefix matching, fragile).
*Effort*: M.

**5.9.3 Hypothesis property breadth — G-6**
Currently only ~5 of ~75 test files use Hypothesis. Schema validators, parser round-trips, and address-decoder coverage are all natural Hypothesis targets.
*Research*: `research/downloads/bench_sim_formal/hypothesis_python`.
*Effort*: M.

**5.9.4 MLPerf Power energy schema propagation — G-7 — landed**
`docs/benchmarks/report-schema.yaml` declares `energy_joules_per_inference`; a modeled MLPerf Inference harness now produces it. `benchmarks/mlperf/` runs a LoadGen-style scheduler (SingleStream + Offline) against the real E1 NPU sim (`E1NpuRuntime.gemm_s8`/`E1NpuMmioSim`) over a tiny INT8 MLP, scores accuracy/latency/throughput, and threads a scale-model-derived `energy_joules_per_inference` (provenance `simulator`, calibration `blocked-no-calibrated-assets`). Gate: `scripts/check_mlperf_inference.py`. Evidence: `docs/evidence/benchmarks/mlperf-inference-harness-evidence.yaml`. Measured silicon power (`mlperf-power-closed`) stays BLOCKED — needs Joulescope/Monsoon on fabricated silicon.
*Research*: `research/downloads/bench_sim_formal/mlperf_power_spec`.
*Effort*: M.

### 5.10 Research gaps (subsystems with no packet)

Per the crosswalk agent, the following surfaces have **no dedicated research packet** despite being part of a phone SoC:

- **GPU subsystem** — zero coverage. RVA1 / V-extension graphics, Mali/Adreno alternatives, open-source options.
- **AON microcontroller** — no packet despite Ibex AON being live in PMC.
- **DSI/DP display RTL** — touched in `mobile_platform_2026` but no implementation plan.
- **Audio DSP / VPU** — light.
- **Open-source 5G/mmWave modem** — acknowledged as hard, unsurveyed.
- **DVFS/DTM algorithm SOTA** — surveys-of-surveys, no canonical packet.
- **ML-assisted compiler scheduling** — Phaeton / Welder / RAMMER missing.

Three drift items from the crosswalk agent:
1. `docs/arch/npu.md` reads as if MX is production format — add SPEC-ONLY banner.
2. Shortlist row D-3 should flip "spec now" → "Yes" since IOMMU RTL+cocotb exists.
3. Compiler runtime files lack source-ID YAML frontmatter that the proposed validator needs.

---

## 6. Stats reporting — the user's explicit ask

The user asked for a review of "how final stats on the chip are reported (#cores, clock speed, GB RAM, etc.)". This is the most concrete actionable gap in the repo.

### 6.1 What's broken

**Six different "core count" answers exist for the same product:**

| Source | Value | Anchor |
|---|---|---|
| Cluster RTL defaults | 1 big + 3 mid + 4 little = 8 | `rtl/cpu/cluster/e1_cluster_top.sv:45-47` |
| SoC top hard literal | `NUM_CPU_CORES = 8` | `rtl/top/e1_soc_integrated.sv:149` |
| SoC top cluster override | 1+3+4 (redundant restatement) | `rtl/top/e1_soc_integrated.sv:603-605` |
| Architecture doc | 1+3+4 | `docs/arch/ooo-cluster.md:51-55` |
| Rail plan | **2 big + 4 little, no mid** | `docs/pd/rail-plan-2028.yaml:22-23` |
| Operating point | `cpu_cores: 2` | `docs/architecture-optimization/soc-optimized-operating-point.yaml:27` |
| AOSP gate | `cpu_cores: 8` | `docs/project/aosp-simulator-completion-gate.yaml:31` |

**NPU dense-INT8 TOPS target drifts 160 vs 44:**

| Source | Value | Anchor |
|---|---|---|
| Spec-DB | 160 | `docs/spec-db/npu-2028-target.yaml:64` |
| Rail plan | **44.0** | `docs/pd/rail-plan-2028.yaml:24` |
| Operating point | 44.0 | `docs/architecture-optimization/soc-optimized-operating-point.yaml:31` |

**No gate currently catches either drift.** Eight different scripts (`check_npu_2028_targets.py:43`, `check_npu_scope.py:33`, `check_cpu_npu_competitive_envelope.py:22`, `check_npu_open_scale_model.py:79-80`, `check_soc_optimization.py:133`, `check_memory_uma_claim_gate.py:451-457`, `competitor-2028-target.md:64-66`, `test_check_memory_2028_target.py:68`) each re-declare numeric targets locally.

### 6.2 Fix plan (concrete, ~1-day implementation)

1. **Author `docs/spec-db/chip-topology.yaml`** as the single nameplate truth (cpu / memory / storage / npu / fabric / debug / process). All other YAMLs become symbolic references (e.g. `cpu-2028-target.yaml` references `chip-topology.yaml#cpu` instead of restating numbers).
2. **Add `scripts/spec_db_models.py`** with pydantic v2 `BaseModel`s (`ChipTopology`, `ChipTopologyCpu`, …). The 145 `yaml.safe_load` call sites collapse into one typed loader. Schema: `eliza.chip_topology.v1`.
3. **Generate `rtl/top/e1_topology_pkg.sv`** from the YAML via `scripts/gen_e1_topology_pkg.py` (constants for `NUM_BIG_CORES`, `NUM_MID_CORES`, `NUM_LITTLE_CORES`, `NUM_CORES`, `AXI_ADDR_W`, `AXI_DATA_W`, `AXI_ID_W`). `rtl/top/e1_soc_integrated.sv:149,171-176` and `rtl/cpu/cluster/e1_cluster_top.sv:45-58` become `import e1_topology_pkg::*;`.
4. **Add `scripts/render_chip_specs.py`** to emit `build/reports/chip-nameplate.json` + `build/reports/chip-nameplate.md`. The README "Chip claims" section reads only from `build/reports/chip-nameplate.json`.
5. **Add `scripts/check_chip_stats_consistency.py`** — load `chip-topology.yaml` (truth) + every other `*-target.yaml`/`rail-plan-*.yaml`/operating-point YAML/AOSP gate YAML; assert every chip-stat field matches or carries an explicit `override_reason`. Fail-closed on unjustified drift. Add to `scripts/aggregate_tapeout_readiness.py:GATES` as `GateSpec(name="chip-stats-consistency", subsystem="platform", tier="spec")`.
6. **Push BSP header generation through the same path** — `sw/platform/generated/e1_platform_contract.h` becomes derived from `chip-topology.yaml`.
7. **Author `docs/datasheet/eliza-e1-2028.md`** rendered by `scripts/render_chip_specs.py --target datasheet`. Single page, auto-generated, claim-boundary at the top, links to each evidence gate.
8. **Extend the aggregator JSON output**:
```json
{
  "schema": "eliza.tapeout_readiness.v1",
  "chip_nameplate": { ... derived from chip-topology.yaml ... },
  "gates": [ ... ],
  "summary": { ... },
  "release_blocker": false
}
```

One file (`build/reports/tapeout-readiness.json`) carries both the spec the chip is claiming *and* the gate state proving (or blocking) those claims. This is the single artifact reviewers, BSP, and any future datasheet consume.

---

## 7. Verification + formal closure plan

| Block | cocotb | Formal | Coverage | Next step |
|---|---|---|---|---|
| NPU | ✓ (16 opcodes) | BMC depth 8, `assume(!start)` so GEMM/descriptor/vector uncovered | ✓ (opcode, axi_resp) | Lift start-bit assume + add descriptor / GEMM properties (§5.6.5) |
| DMA | ✓ | BMC depth 12, `prove` 16 on `dma_axil` | ✓ (axi_resp, irq_vector) | k-induction on full DMA, not just AXI-Lite shim |
| Display | ✓ | — | ✓ (mmio_region) | Add formal for hsync/vsync cadence |
| SoC top | ✓ | BMC depth 4 (structural only) | ✓ (mmio_region, irq_vector) | Deepen to depth 16+ once interconnect is real |
| Chip top | ✓ | — | ✓ (mmio_region, irq_vector) | Bind AXI4 protocol properties |
| BPU | ✓ (TAGE/ITTAGE/FTB/RAS/FTQ/SC/uFTB/loop) + MPKI gate | BMC depth 12 on FTQ + RAS | — | Add cover-points; k-induction on small leaves |
| Cache | ✓ (L1I/D, L2/3/SLC, BDI, DRRIP, Hawkeye, Mockingjay) | BMC depth 24 on coherence | — | Add cover-points; bind coherence properties |
| AXI4 | ✓ (burst, IRQ W1C, multi-master, width converter, DFI) | — | — | Land AXI4 protocol property pack |
| IOMMU | ✓ (1 test — too thin given security criticality) | — | — | Expand test set; add formal |
| Power | ✓ (8 tests: droop, AVFS, mailbox, RPMI) | — | — | Bind CDC properties to power blocks |
| Integration | ✓ (boot smoke, cross-domain, CVA6 DRAM, CVA6 bootrom, PMC Ibex boot) | — | — | Add cover-points |
| CPU (CVA6) | ✓ smoke; `test_csr_trap`, `test_mmu_sv39`, `test_zihpm_event_table` are skipped scaffolds | — | — | Active commit `bd21824ee4` unblocking V3Delayed crash |
| Debug | ✓ (MMIO bridge only — no DM) | BMC depth 16 | — | New RVdebug RTL needed first (§5.3.6) |

Verification SOTA roster (paragraph + research):
- **Bitwuzla wired alongside z3 — G-1 — landed.**
- **cocotb-coverage merge — G-2 — landed for 5 blocks; extend to all 12.**
- **Reset + CDC properties — G-3 — landed.**
- **AXI-Lite protocol properties — G-4 — landed; need AXI4 equivalent.**
- **Accelergy + Timeloop — G-5 — landed but `make benchmark-sim-metrics` doesn't call Timeloop yet.**
- **Hypothesis — G-6 — landed in 5 files; expand.**
- **MLPerf Power schema — G-7 — landed; modeled harness (`benchmarks/mlperf/`) now produces `energy_joules_per_inference`. Measured silicon power stays BLOCKED (`mlperf-power-closed`).**
- **DifuzzRTL / RTLfuzz** — research-grade, AI-EDA scaffolding exists.
- **Sail / Spike differential testing** — checkouts in `external/`; no live lane.
- **GLIFT info-flow** — for security properties once OpenTitan IP set lands.
- **LEC post-synth** — absent.

---

## 8. Tapeout-readiness gate table (2026-05-20)

40 PASS / 0 FAIL / 8 BLOCKED. The 8 BLOCKED items:

| # | Gate | Subsystem | Root cause | Owner |
|---|---|---|---|---|
| 1 | `cpu-big-integration` | CPU | open Kunminghu V3 8-wide scale-up: external XiangShan checkout + scale-up microbench (no license; Ascalon-D8 surveyed but rejected) | CPU/AP |
| 2 | `chipyard-verilator-linux-smoke` | CPU/BSP | RV cross toolchain not installed | BSP |
| 3 | `qemu-virt-linux-smoke` | BSP | Buildroot Image + rootfs.cpio not built | BSP (closest unblock per §5.8.1) |
| 4 | `aosp-cuttlefish-rv64` | BSP | virtio-gpu blocker, commit `805a328650` | BSP |
| 5 | `aosp-vendor-image` | BSP | 64 GB Linux x86 host + JDK 21 + AOSP checkout | BSP |
| 6 | `aosp-hal-evidence` | BSP | Real device boot transcripts | BSP |
| 7 | `mlperf-power-closed` | Benchmarks | Pre-silicon impossible | Post-silicon |
| 8 | `foundry-pdk` | PD | TSMC/Samsung/Intel/Rapidus shortlist agreements | Procurement |

None are PD-owned. The PD subsystem itself is 9/9 PASS.

---

## 9. Research downloads — local mirror

Created at `research/downloads/` (gitignored via `.gitignore: downloads/`). Indexed at `research/downloads/INDEX.md` (941 rows: `source_id | packet | url | status | local_path | sha256`).

| Packet | Downloaded | Of total | Notes |
|---|---|---|---|
| `npu_accelerator` | 80 | 99 | arXiv lane ~100 % |
| `compiler_runtime` | 32 | 74 | |
| `cpu_subsystem` | 21 | 84 | Many GitHub repos (skipped per policy) |
| `memory_subsystem` | 26 | 70 | Heavy JEDEC paywall |
| `pd_eda` | 34 | 80 | |
| `process_packaging` | 7 | 59 | **Worst lane — vendor URL rot, paywalls** |
| `security` | 38 | 70 | |
| `bsp_software` | 24 | 47 | |
| `bench_sim_formal` | 33 | 81 | |
| `mobile_platform` | 44 | 72 | |
| `ai_accelerator_sota` | 8 | 8 | |
| `alpha_chip_macro_placement` | 378 | 397 | arXiv lane dominated (581 MB) |
| `specs` | 9 | 13 | Curated landing pages |
| **Total** | **735** | **— ** | 840 MB on disk, ~9 min wall time |

Skipped or failed: 198 GitHub repos (linked only), 102 paywalled (IEEE/ACM/JEDEC/ARM/Intel/TSMC), 82 404s, 35 SSL/redirect failures, 10 transient.

Paywall priorities for library access: JEDEC LPDDR/HBM specs, IEEE Xplore ISSCC/VLSI silicon papers, ARM AMBA TRMs.

To search the corpus locally:
```
rg -i 'flash.?attention' research/downloads/ -l        # files matching
rg -i 'paged.kv|page.table.walker' research/downloads/ # passages
```

---

## 10. Priority-ordered execution plan

Sequenced by **(activation energy, leverage, dependency order)**. Items below the line are deferred pending the items above.

### Wave A — quick wins (≤1 day each, no design risk)

1. **Author `docs/spec-db/chip-topology.yaml` + pydantic model + consistency gate** (§6) — unblocks honest claims everywhere
2. **Migrate 80+ check scripts to `scripts/chip_utils.py`** (§3.7 H41) — mechanical
3. **Replace `run_benchmarks.py` inline parsers with imports from `benchmarks/parsers/`** (§3.7 H42, §5.9.1)
4. **Delete obvious dead code**: `HelloNpuRuntime` alias, no-op IREE passes, `golden_gemm_s4` alias, two `zzz-root-owned-build-preserved*/` dirs (§3.2 H10/H11/H13)
5. **Collapse `axi_lite.sv` and `axi_lite_protocol.sv`** (§3.4 H25)
6. **Single BLOCKED convention + JSON-first aggregator** (§3.7 H43)
7. **Address-map split-brain fix** (§3.6 H40, §5.8.5)
8. **Honest perf-counter rename + RTL fix** (§5.1.8)
9. **Tighten SBY z3-disagreement** (§5.6.1)
10. **Add `[tool.pytest.ini_options]` + `--strict-markers`** (§4 T5)

### Wave B — single-week consolidations

11. **Single memory-map source of truth + generator** (§3.3 H20)
12. **Extract `e1_clint.sv`, `e1_mmio_decode.sv`, `e1_behavioral_dram.sv`** (§3.1 H1-H4)
13. **`verify/cocotb/common.py` + `common.mk`** (§3.4 H26/H27)
14. **DTS `#include` consolidation** (§3.6 H37)
15. **`Lowered*Result` base class + drop `cpu_fallback`** (§3.2 H15/H16)
16. **5 quantization calibrators → shared base** (§3.2 H17)
17. **Bind all 5 prefetchers** (§5.4.10)
18. **NPU formal — lift start-bit assume, add descriptor/GEMM properties** (§5.6.5)
19. **Cover-points for BPU/cache/AXI4/CPU/integration/power** (§5.6.2)
20. **Buildroot rv64gc qemu-virt smoke** (§5.8.1) — closest BLOCKED to landing

### Wave C — month-scale features

21. **BitNet multiplier-free datapath** (§5.1.3) — single-block S/M
22. **Group-INT4 RTL** (§5.1.2)
23. **Opcode-space renumbering** (§5.1.7) — binding constraint on §5.1.1, §5.1.4, §5.1.5
24. **MX operand fetch path** (§5.1.1)
25. **Dual-port FTB / 2-taken BPU** (§5.3.1)
26. **Zicbom/Zicbop/Zicboz on L1D + prefetcher** (§5.3.3)
27. **RVdebug 1.0 DM + JTAG TAP** (§5.3.6)
28. **RVFI + riscv-formal lane** (§5.3.7)
29. **riscv-arch-test + riscv-dv + RISCOF** (§5.6.4)
30. **Compression-aware DMA** (§5.4.6), **DRAM QoS classes** (§5.4.7)
31. **DICE measurement chain + AVB 2.0 BL2 verifier** (§5.5.6/2)
32. **OpenSBI 1.6 FW_DYNAMIC + U-Boot RV64** (§5.8.2)

### Wave D — quarter-scale subsystems

33. **TileLink-C real fabric + Constellation mesh NoC** (§5.4.1, §5.4.2) — single largest missing subsystem
34. **OpenTitan IP set integration** (§5.5.1) — second-largest
35. **2:4 sparse INT4 tile** (§5.1.4)
36. **FlashAttention engine + Paged-KV walker** (§5.1.5, §5.1.6) — depend on tile fabric
37. **SLC 32 MiB + tiled NPU SRAM 64 MiB** (§5.4.5)
38. **LPDDR6 PHY + real controller timing** (§5.4.3)
39. **SMMU/IOMMU stream IDs** (§5.4.4)
40. **AIA + Sstc + IMSIC/APLIC** (§5.3.5)
41. **Saturn vector + BOOM v4** (§5.3.4)
42. **AOSP Cuttlefish RV64 boot** (§5.8.3)

### Wave E — pre-tapeout (procurement-blocked)

43. **PDK selection + foundry agreement** (TSMC N2P/A14, Samsung SF2P, Intel 14A, Rapidus N2)
44. **BSPDN / PowerVia parallel variant** (§5.7.5)
45. **Padframe ESD strategy + IO ring** (§5.7.7)
46. **On-die thermal sensors + DTM** (§5.7.6)
47. **Antenna + STA waiver closure on advanced node** (§5.7.1 equivalent at production node)
48. **KiCad mainboard routing + vendor review**

---

## 11. Risk and discipline notes

The chip's discipline reads as follows. **Every** claim is fail-closed. **Every** spec-DB YAML has `forbidden_claims_until_*`. **No** silent claim promotion has occurred. The 40/0/8 tapeout-readiness aggregator is real, the util-regression gate is real, the tool-digest pinning is real, the H-1..H-5 PD work-order rows really did land. The verification surface really does test what it says, even if the depths are shallow.

The cost of that discipline is that the codebase is also conservative: 4 different YAMLs say 4 different things about core count because nobody wanted to break their downstream consumer. Six near-duplicate ExecuTorch stubs exist because nobody wanted to delete one and learn it was needed. 30 near-duplicate `Lowered*Result` dataclasses exist because every smoke lowering added one before the shared base existed.

**The path forward is to keep the discipline and aggressively normalise.** Author the `chip-topology.yaml`. Run a `migrate to chip_utils.py` morning. Delete the no-op passes. Land the Wave A items in a week and the cleanup-debt half-life drops.

---

## 12. Pointer to per-agent deep-dive reports

The nine agent reports below are the authoritative deep-dive for each surface. This dossier is a synthesis; each report carries 100-300 more `file:line` anchors and detail than is reproduced here. All paths are gitignored (sit under `research/downloads/`).

| Agent | Report | Lines |
|---|---|---|
| 1 | Architecture + stats reporting | `research/downloads/_reports/agent1_architecture.md` | 840 |
| 2 | NPU + compiler/runtime | `research/downloads/_reports/agent2_npu_compiler.md` | 1,049 |
| 3 | CPU + memory + interconnect | `research/downloads/_reports/agent3_cpu_memory.md` | 1,122 |
| 4 | Verification (cocotb/formal/SVA) | `research/downloads/_reports/agent4_verification.md` | 644 |
| 5 | Physical design + tapeout | `research/downloads/_reports/agent5_pd_tapeout.md` | 956 |
| 6 | Software / BSP / firmware | `research/downloads/_reports/agent6_software_bsp.md` | 883 |
| 7 | Benchmarks + scripts + build infra | `research/downloads/_reports/agent7_bench_scripts.md` | 571 |
| 8 | Research-to-code crosswalk | `research/downloads/_reports/agent8_research_crosswalk.md` | 942 |
| 9 | Downloads index | `research/downloads/_reports/agent9_downloads.md` + `research/downloads/INDEX.md` | 87 / 941 |

---

*End of dossier.*
