# Open RISC-V Cores & CPU Subsystem Research Packet

Date: 2026-05-19

This packet records a source-backed survey of open RISC-V cores, ISA
extensions, cache/coherency primitives, Linux/Android port status, and
verification methodology relevant to the Eliza E1 SoC application,
management, and security processor roles. It tracks the existing CPU/AP
selection committed in `docs/arch/cpu-subsystem.md` and
`docs/arch/linux-capable-cpu-contract.md` (Chipyard 1.13.0 `ElizaRocketConfig`
single Rocket RV64GC hart) and explores adjacent open cores that could
participate in later AP, management, security, or accelerator-control roles.

## Files

- `01_sources/source_inventory.yaml` -- provenance, URLs, captured points,
  and claim boundaries. Mirrors the schema used in
  `research/ai_accelerator_sota/01_sources/source_inventory.yaml`.
- `02_analysis/linux_android_capable_cores.md` -- Rocket / BOOM / SonicBOOM /
  CVA6 / XiangShan / OpenC910 / NaxRiscv comparison for the Eliza E1 AP role.
- `02_analysis/vector_extension_landscape.md` -- RVV 1.0 open implementations
  (Saturn, Spatz, Ara2, Vicuna, OpenC908, CVA6-V, XiangShan) and their fit
  for Eliza E1 vector fallback alongside the NPU.
- `02_analysis/coherency_and_interconnect.md` -- TileLink, AXI, ACE, CHI-B,
  Constellation NoC, ESP NoC, and OpenSBI cache management evidence in
  open ecosystems.
- `02_analysis/risc_v_android_port.md` -- Android RISC-V port state through
  2026: RISE Project, riscv-android-sig AOSP, Cuttlefish RV emulation,
  kernel.org RV tree, distro coverage, ART/HotSpot RV JIT state.
- `03_implementation/cpu_path_for_e1.md` -- High/Med/Low confidence steps
  tying open CPU options to `docs/arch/cpu-subsystem.md`,
  `docs/arch/linux-capable-cpu-contract.md`,
  `docs/architecture-optimization/compute-silicon.md`, and the missing
  `docs/spec-db/cpu-2028-target.yaml` gate.

## Claim Boundary

This packet is research and implementation-planning evidence. Public papers,
vendor pages, and project README claims are treated as targets and
directional guidance only until reproduced through local RTL, simulation,
synthesis, PD, software, and board evidence as the
`linux-capable-cpu-contract.md` gates require.

The current `ElizaRocketConfig` selection in
`generators/chipyard/eliza-rocket-manifest.json` remains the authoritative
e1-chip CPU path. Any alternate core listed here is a candidate for a future
AP, secondary AP cluster, management hart, or accelerator-control role and
needs its own selection and evidence trail before claims may move.

`docs/spec-db/cpu-2028-target.yaml` does not exist at packet date. The
implementation plan calls for its creation alongside any move beyond the
single-Rocket Linux bring-up target, mirroring the NPU spec-db pattern.
