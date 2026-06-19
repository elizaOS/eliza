# Eliza E1 chip research index

Date: 2026-05-19

This directory is the source-backed research surface for the Eliza E1 open
RISC-V AI phone SoC. Every packet under this directory is **research and
planning evidence**, not silicon, RTL, BSP, simulator, or PD signoff
evidence. Implementation claims still need to clear the gates owned by
`docs/`, `verify/`, `benchmarks/`, `pd/`, `package/`, `board/`,
`compiler/`, `fw/`, `sw/`, and `scripts/`.

## Packet map

Each packet uses the same shape:

```
<area>/
  00_index.md                       packet overview + claim boundary
  01_sources/source_inventory.yaml  ≥40 verified primary sources
  02_analysis/<topic>.md            critical assessments
  03_implementation/<area>_for_e1.md ranked High/Med/Low recommendations
```

| Area | Packet | Source count | Anchors in this repo |
| --- | --- | ---: | --- |
| NPU & AI accelerator microarchitecture | [npu_accelerator_2026](npu_accelerator_2026/00_index.md) | 99 | `docs/arch/npu.md`, `docs/arch/npu-microarch.md`, `docs/spec-db/npu-2028-target.yaml`, NPU 2028 phase-gate spec, `rtl/npu/`, `compiler/runtime/e1_npu_lowering.py` |
| AI compiler stack & on-device runtime | [compiler_runtime_2026](compiler_runtime_2026/00_index.md) | 87 | `compiler/runtime/`, `docs/spec-db/npu-2028-target.yaml#software_targets`, `docs/arch/npu.md` lowering sections |
| Open RISC-V cores & CPU subsystem | [cpu_subsystem_2026](cpu_subsystem_2026/00_index.md) | 91 | `docs/arch/cpu-subsystem.md`, `docs/arch/linux-capable-cpu-contract.md`, `docs/architecture-optimization/compute-silicon.md`, `generators/chipyard/eliza-rocket-manifest.json` |
| Memory hierarchy (DRAM, SRAM, cache, NoC) | [memory_subsystem_2026](memory_subsystem_2026/00_index.md) | 86 | `docs/arch/memory-subsystem.md`, `docs/arch/interconnect.md`, `docs/arch/memory-map.md`, `docs/spec-db/npu-2028-target.yaml` |
| Physical design & open EDA | [pd_eda_2026](pd_eda_2026/00_index.md) | 83 | `pd/openlane/config.sky130.json`, `docs/pd/`, `docs/architecture-optimization/physical-power-thermal.md`, extends [alpha_chip_macro_placement](alpha_chip_macro_placement/00_index.md) |
| Sub-2nm / 14A process, packaging, thermal, reliability | [process_packaging_2026](process_packaging_2026/00_index.md) | 64 | `docs/spec-db/process-14a-effects.yaml`, `docs/architecture-optimization/physical-power-thermal.md`, `docs/manufacturing/` |
| Security, RoT, secure boot, TEE, side channels | [security_2026](security_2026/00_index.md) | 78 | `docs/security/`, `docs/arch/security.md`, `docs/project/security-usb-storage-update-fail-closed-work-order-2026-05-17.yaml` |
| Linux / Android / AOSP RV BSP | [bsp_software_2026](bsp_software_2026/00_index.md) | 57 | `docs/sw/`, `docs/arch/android-contract.md`, `docs/arch/boot.md`, `docs/project/aosp-simulator-completion-gate.yaml` |
| Benchmarks, simulators, formal verification | [bench_sim_formal_2026](bench_sim_formal_2026/00_index.md) | 95 | `benchmarks/`, `verify/`, `docs/benchmarks/`, `docs/three-week-prototype-workstreams.md` |
| Mobile platform (display, camera, PMIC, Wi-Fi/BT, modem, PCB) | [mobile_platform_2026](mobile_platform_2026/00_index.md) | 78 | `docs/architecture-optimization/phone-platform.md`, `docs/arch/display.md`, `docs/arch/peripherals.md`, `docs/arch/wifi.md`, `board/`, `package/` |
| AI accelerator SOTA (TPU/GPU/mobile NPU/14A) | [ai_accelerator_sota](ai_accelerator_sota/00_index.md) | (pre-existing) | original SOTA packet; superseded for mobile NPU detail by `npu_accelerator_2026` |
| AlphaChip macro placement | [alpha_chip_macro_placement](alpha_chip_macro_placement/00_index.md) | (pre-existing) | original ML PD packet; extended by `pd_eda_2026` |

Total newly-captured primary sources across the ten 2026 packets: **818**.

## Source policy

- Primary sources only: arXiv, IEEE Xplore, ACM DL, JEDEC, OCP, NIST, IRDS,
  RISC-V International, MLCommons, Wi-Fi/USB-IF/3GPP, official vendor pages,
  GitHub release pages, and conference proceedings (ISSCC, IEDM, ISCA,
  MICRO, HPCA, ASPLOS, DAC, ICCAD, ASP-DAC, ISPD, HotChips, MLSys, OSDI,
  ATC, USENIX Security, IEEE S&P, NeurIPS, ICLR, PLDI).
- Press articles are accepted only when they are the sole public source for
  a relevant product or vendor-plan claim; they are tagged as such in the YAML
  inventory and not treated as proof.
- Vendor whitepapers and product briefs are treated as target context, not
  evidence of Eliza E1 capability.
- Each source entry carries `url`, `title`, `year`, `venue`, an `authors_or_vendor`
  field, and a multi-line `relevance` block tying it to a specific E1
  design question.

## Claim boundary

- These packets do not establish silicon, RTL, BSP, PD, or simulator
  evidence. They are research artifacts intended to inform architectural
  decisions and validation gates.
- Vendor or planning claims (TSMC A14, Samsung BSPDN, Qualcomm Hexagon NPU,
  Apple Neural Engine, etc.) are cited for context. No packet asserts that
  Eliza E1 currently delivers any of those numbers.
- The standing project rule applies: implementation claims must clear the
  gates in `docs/`, `verify/`, `benchmarks/`, `pd/`, `package/`, `board/`,
  `compiler/`, `fw/`, `sw/`, and `scripts/`. Research recommendations in
  `03_implementation/` of each packet are **proposals**, not closed gates.

## How to use this directory

1. When working on an Eliza E1 subsystem, read the matching packet's
   `02_analysis/` files first to ground the design space.
2. Use the source inventory `01_sources/source_inventory.yaml` to find
   primary references; never restate a numeric target from a packet without
   citing the underlying source ID.
3. Treat `03_implementation/<area>_path_for_e1.md` as a ranked candidate
   list, not a decided plan. Promote items to actual workstream tickets,
   contract docs, RTL, and gates only after the corresponding evidence is
   produced.

## Reading order for a new contributor

1. `docs/README.md` and `docs/arch/soc.md` — what E1 is today.
2. `docs/spec-db/npu-2028-target.yaml`, the NPU 2028 phase-gate spec, and
   `process-14a-effects.yaml` — what E1 is aiming at.
3. The two NPU packets (`npu_accelerator_2026`, `compiler_runtime_2026`)
   for the AI/NPU surface.
4. `cpu_subsystem_2026`, `memory_subsystem_2026`, `bsp_software_2026` for
   the Linux/Android AP scaffolding.
5. `pd_eda_2026`, `process_packaging_2026`, `mobile_platform_2026` for the
   physical realization path.
6. `security_2026` and `bench_sim_formal_2026` for the cross-cutting
   evidence disciplines.
