# Eliza E1 CPU subsystem implementation path

Date: 2026-05-19

This document ranks concrete next steps for the E1 CPU/AP workstream by
confidence. It is bound to the current authoritative gates:

- `docs/arch/cpu-subsystem.md` (tiny CPU contract + Chipyard Rocket target)
- `docs/arch/linux-capable-cpu-contract.md` (Linux-capable gate matrix)
- `docs/architecture-optimization/compute-silicon.md` (P0 Rocket/CVA6
  replacement and DMA primitive)
- `generators/chipyard/eliza-rocket-manifest.json` (Chipyard 1.13.0 pin)
- `docs/spec-db/mobile-sota-2026.yaml` (architecture budgets)
- (missing) `docs/spec-db/cpu-2028-target.yaml` -- proposed below

The packet does not propose changes to RTL, scripts, or documentation
outside this directory. Each step terminates in a gate or manifest that an
external contributor can run.

## High-confidence steps (do without further debate)

### H1. Author `docs/spec-db/cpu-2028-target.yaml`.

The NPU side already has `npu-2028-target.yaml`. CPU has no equivalent.
A symmetric spec-db file should be authored separately (outside this
packet) with at minimum:

- `target_year`, `target_class`, `positioning`
- `selected_ap_path`: pointer to `eliza-rocket-manifest.json`
- `phase_a_isa`: RV64GC (current Rocket)
- `phase_b_isa`: RVA22U64+V (BOOM + Saturn)
- `phase_c_isa`: RVA23 (KunMingHu / future)
- `vector`: RVV 1.0 only; explicit forbid on RVV 0.7.1
- `mmu`: Sv39 minimum, Sv48 optional
- `coherence_protocol`: TileLink-C
- `interrupt_controller`: PLIC required, AIA tracked
- `timer`: CLINT today, Sstc tracked
- `cache_maint`: Zicbom/Zicbop/Zicboz required
- `android_profile_target`: RVA22U64+V (tracked), RVA23 (long-term)
- `forbidden_paths`: RVV 0.7.1, vendor cache CSRs, Hwacha (pre-RVV-1.0)

This file is the bridge between the bring-up gate and any phone-class AP
claim. Without it, the bring-up gate is the only governance and any future
core swap would happen without a written selection.

### H2. Keep Rocket as the bring-up vehicle.

The current selection in `eliza-rocket-manifest.json` is correct for the
Linux smoke / OpenSBI handoff / trap-timer-IRQ gates. Do not touch the pin.
Specifically:

- Do not add a vector unit to Rocket before Linux gates close.
- Do not swap to BOOM before Linux gates close.
- Do not adopt CVA6 unless we leave Chipyard, which is not planned.

### H3. Pin RVV 1.0 as the only accepted vector ISA.

Anywhere the codebase mentions RVV (vector) should require V1.0. Forbid
RVV 0.7.1 references in spec-db and registry. Anything else creates a
compatibility surface that Android RV upstream will reject.

### H4. Pin RVA22U64+V as the spec-db Android baseline.

Even though Android RV is not a near-term boot claim, the architecture
budget in `mobile-sota-2026.yaml` and the future `cpu-2028-target.yaml`
should both pin the Android profile target to RVA22U64+V (long-term
RVA23). This forecloses accidental commitments to non-Android-compatible
extension sets.

### H5. Record cache maintenance as Zicb* (no vendor CSRs).

The Zicbom + Zicbop + Zicboz path is what Linux RV upstream uses for DMA
cache management. Any future NPU coherent DMA gate should reference these,
not XuanTie / vendor-specific CSRs.

## Medium-confidence steps (worth doing after H1-H5 land)

### M1. Add a tracked-only entry for Saturn in the spec-db.

The vector engine candidate for the Chipyard path is Saturn. Adding it as
a tracked alternate (not the selection) in `cpu-2028-target.yaml`
captures the right deferral semantics.

### M2. Add Ibex as the named management/security hart.

`mobile-sota-2026.yaml` already lists Ibex as a candidate for the
management/security subsystem. The future `cpu-2028-target.yaml` should
make that selection explicit:

- one Ibex hart for root-of-trust / boot integrity (OpenTitan-style)
- optional second Ibex hart for always-on / wake / debug

Without this, the CPU subsystem document only describes the AP and leaves
the management plane unspecified.

### M3. Plan the BOOM/SonicBOOM Phase B selection.

A short selection note should be drafted (outside this packet) that
captures BOOM as the Phase B AP candidate and the reasons:

- same Chipyard plumbing (no fabric/coherence rework)
- OoO required for SPEC/Geekbench parity targets
- Saturn already integrates with BOOM in Chipyard 1.13.0

This is a Medium-confidence pick because XiangShan KunMingHu is a stronger
performance target but a worse integration target.

### M4. Track AIA (Smaia/Ssaia) and Sstc as long-term gates.

These ratified privileged-mode extensions are required for scalable
interrupt and timer service on phone-class APs. They are not required
for the Rocket Linux smoke gate, but they should appear in the future
spec-db as tracked items with explicit "PLIC + CLINT fallback acceptable
for bring-up" language.

### M5. Add verification flow entries to `cpu-2028-target.yaml`.

Pin the RV verification tools we will rely on:

- Spike as the golden ISS
- Sail-RISC-V as the formal model reference
- riscv-arch-test via RISCOF for compliance
- riscv-formal RVFI for instruction-trace formal
- riscv-dv for random instruction streams
- ImperasDV as a commercial alternative ISS (optional)

The point is to choose verification primitives that are independent of
the core selection so a future Rocket -> BOOM swap does not invalidate
the DV harness.

## Low-confidence / human-decision items

### L1. CHERI-RISC-V adoption.

CHERI offers capability-based memory safety. Industry adoption (ARM
Morello) is mature on Arm but very immature on RV. Adopting CHERI on E1
would foreclose mainline Android RV compatibility. Not recommended;
needs human policy call.

### L2. Hypervisor extension (H) requirement.

H is ratified and KVM-RISC-V upstream supports it. But KVM is not a
phone-class workload until Android Cuttlefish-on-device matters. Pinning H
as required adds DV cost; pinning H as optional defers the decision.
Needs human call after Phase B AP selection.

### L3. XiangShan KunMingHu as a future AP candidate.

KunMingHu is the highest-performance open RV core in 2026. Adopting it
would replace Chipyard plumbing with HuanCun + Mulan-licensed components.
The integration cost is high and the upstream license differs from BSD/
Apache. Track only; the human decision to leave Chipyard is non-trivial.

### L4. Custom AP cluster vs BOOM/KunMingHu.

A custom OoO core sized for E1 (e.g., a 4-wide derivative of BOOM with
private E1 microcode for the NPU command path) is theoretically the
highest-leverage option but has by far the highest verification cost.
Out of scope until Phase B closes.

## Crosslink: AlphaChip-style ML floorplanning

The `research/alpha_chip_macro_placement/` packet already covers RL macro
placement. CPU subsystem implications:

- AlphaChip's published demonstrations target Ariane/CVA6 floorplans and
  TPU systolic arrays. The Chipyard Rocket selection is therefore inside
  the demonstrated regime.
- BOOM and KunMingHu floors have not been demonstrated publicly with
  AlphaChip-class RL; expect higher placement variance.
- If we ever move to KunMingHu or a custom OoO core, the placement
  research backlog must grow to cover the larger macro count and the
  HuanCun directory cache macros.

## Verification of the implementation plan

This packet contains no executable code. The "verification" of the plan is
that every recommendation cites an existing gate file or proposes a new
spec-db file whose contents are listed concretely. The action for an
external contributor is:

1. Author `docs/spec-db/cpu-2028-target.yaml` per H1.
2. Add Saturn, Ibex management-core, and BOOM Phase B entries per M1-M3.
3. Add verification-tool selections per M5.
4. Defer L1-L4 to human policy review.

No RTL, script, or evidence-manifest changes are part of this packet.
