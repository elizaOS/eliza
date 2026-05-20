# Thermal Modeling And Reliability Physics At Sub-2 nm / 14A-Class

Date: 2026-05-19

Scope: thermal envelopes and reliability physics relevant to E1 at A14-class
(2028 mobile target). Covers nanosheet self-heating, BTI/HCI/TDDB at GAA,
electromigration at advanced BEOL, soft-error / FIT trends, RowHammer-class
DRAM disturbances (for the package memory choice), and the AOSP / phone-side
thermal model (vapor chamber, skin temperature, thermal HAL).

Sources: `self_heating_nanosheet_edl2024`, `bti_nanosheet_ted2023`,
`em_advanced_beol_tdmr2024`, `soft_error_advanced_node_iolts2024`,
`rowhammer_class_disturbance`, `aosp_thermal_hal`,
`aosp_thermal_mitigation`, `vapor_chamber_phone_review`,
`irds_2024_more_moore`, `jedec_lpddr5x_lpddr6`.

## Self-Heating Of GAA / Nanosheet

`self_heating_nanosheet_edl2024`, `irds_2024_more_moore`:

- A stacked nanosheet device has a wrap-around gate that thermally
  insulates the channel from the substrate; lateral heat conduction through
  the gate stack is poor.
- Reported thermal resistance per device is roughly 2x FinFET at the same
  drive current.
- Steady-state channel temperature rises faster under sustained drive than
  under bursty drive. AI accelerator MAC arrays at high duty cycle are
  particularly exposed.
- BSPDN (`02_analysis/backside_power_pdn.md`) does not eliminate self-
  heating; it shifts the dominant thermal escape direction from the
  substrate side toward the backside metal stack.

Consequences for the E1 NPU at sustained AI workloads:

- A flat large systolic array is the worst topology because every MAC is
  hot simultaneously. Tiled arrays with scheduled idle phases are the
  preferred topology per
  `research/ai_accelerator_sota/02_analysis/process_14a_sub2nm_notes.md`.
- DVFS and throttling hooks must trigger before steady-state self-heating
  pushes BTI/HCI shifts past lifetime guardbands -- not just before the
  package thermal envelope is hit.

## BTI, HCI, TDDB At GAA

`bti_nanosheet_ted2023`, `irds_2024_more_moore`:

- **NBTI / PBTI**: trap density in the wrap-around HK/MG gate is higher
  than in FinFET HK/MG because the gate field is omnidirectional, and the
  channel area exposed to the gate dielectric is larger per device.
  Reported NBTI shifts are larger at iso-stress for nanosheet vs FinFET.
- **HCI**: hot-carrier injection remains a concern at high Vds operation;
  at A14-class with Vdd pinned near 0.7 V, HCI is less of an absolute
  shift but is more variable due to local Vth variation amplifying HCI
  hot-spots.
- **TDDB**: time-dependent dielectric breakdown margin narrows because
  Vdd is no longer scaling proportionally with oxide-equivalent thickness.
  Foundries compensate by using thicker HK + higher-k dielectrics, but the
  margin is tight.

For E1: the `reliability_aging_and_lifetime` required effect in
`process-14a-effects.yaml` must use nanosheet-specific BTI/HCI/TDDB
derates, not FinFET-era derates. The contract is correct to demand
lifetime derates from the foundry PDK.

## Electromigration At Advanced BEOL

`em_advanced_beol_tdmr2024`, `irds_2024_beol`:

- Cu wires at narrow lines (sub-15 nm width) approach a resistivity
  inflection due to barrier-thickness floor + grain-boundary scattering.
  The barrier consumes a growing fraction of cross-section.
- Mo and Ru wires can be deposited without a barrier or with a much thinner
  barrier, and have favorable EM activation energies for narrow lines.
  Foundries have publicly described Mo/Ru on top-of-stack or specific
  layers, not full-stack replacements.
- For E1: signal-layer and power-rail EM analysis at A14-class must use the
  foundry's metal-specific EM rules; do not assume Cu-only EM rules.
- BSPDN amplifies this because backside metal rails carry high current
  density and are typically Mo or Ru.

## Soft-Error / FIT Trends

`soft_error_advanced_node_iolts2024`:

- Per-bit SRAM FIT decreases roughly as the bit pitch shrinks (smaller
  collection area per cell), but per-chip FIT grows because total bit
  count grows.
- Sequential / latch FIT becomes the dominant component at sub-2 nm
  because the latch element is a larger fraction of an ever-smaller cell.
- Multi-bit upset (MBU) probability rises if cells are too closely packed
  without bit-interleaving.

Consequences for E1:

- The `sram_density_vmin_and_ecc` required effect must specify:
  - bit-interleaving in SRAM macros to keep MBU below SECDED's correction
    limit;
  - SECDED + repair fuse policy for L1/L2 and NPU local SRAM;
  - parity or ECC on flip-flop-heavy pipelines (NPU MAC accumulator paths,
    CPU rename / ROB / LSQ structures).
- This binds to the existing `docs/arch/memory-subsystem.md` and
  `docs/arch/npu-microarch.md` contracts.

## RowHammer / RowPress (Package Memory)

`rowhammer_class_disturbance`, `jedec_lpddr5x_lpddr6`:

- RowHammer-class disturbance persists in scaled DRAM. LPDDR5X uses
  RFM (Refresh Management) and PRAC (Per-Row Activation Counting)
  standardized at JEDEC.
- LPDDR6 (under development) is expected to include further mitigation.
- This is not a 2 nm logic concern; it is a package memory concern. For
  E1, the LPDDR5X / LPDDR6 controller must enable RFM/PRAC per JEDEC and
  this must be evidence-tracked under `docs/manufacturing/board-package-...`.

## Mobile Thermal Envelope And AOSP Thermal HAL

`aosp_thermal_hal`, `aosp_thermal_mitigation`, `vapor_chamber_phone_review`:

### Phone Thermal Envelope (Public Measurements)

- Vapor chambers in flagship phones absorb 4--8 W of transient burst
  power before saturating. After saturation, sustained dissipation is
  bounded by enclosure surface area and skin-temperature limit (typically
  4--6 W) per `vapor_chamber_phone_review`.
- Skin temperature limit: 43--45 C is the typical hard limit per
  IEC 60950-1 / IEC 62368-1. The thermal HAL reports skin temperature and
  triggers progressive throttling.
- This is consistent with the existing E1 work-order
  `docs/architecture-optimization/soc-optimized-operating-point.yaml`,
  which targets <= 95 C die temperature and is bound to PD signoff and
  workload-correlated thermal capture.

### AOSP Thermal HAL Contract

- Android's Thermal HAL (HAL v2) defines:
  - Thermal zones (CPU, GPU, NPU, modem, charger, skin) and severity
    levels (NONE / LIGHT / MODERATE / SEVERE / CRITICAL / EMERGENCY /
    SHUTDOWN).
  - Cooling devices (CPU freq cap, GPU freq cap, charger throttle).
  - Skin-temperature reporting back to Android.
- Reference mitigation pipeline:
  `aosp_thermal_mitigation` documents a PID-style throttling pipeline that
  shapes per-block performance under sustained workload.
- E1's NPU and CPU thermal-zone integration must expose temperature
  telemetry through Linux / Android compatible interfaces. This binds to
  `docs/arch/npu.md` and `docs/architecture-optimization/phone-platform.md`.

## Thermal Path On A Mobile A14-Class Die

- Die backside is the thermal-output side toward the package. On a
  BSPDN variant, the backside is also where the power-delivery metal
  lives. The thermal model must include the backside metal + nano-TSV
  stack as part of the thermal-resistance network.
- Phone packages typically use a thermal interface material (TIM) +
  graphite spreader + vapor chamber on the chassis side. The thermal
  capacity of the vapor chamber is the buffer that absorbs short bursts.
- Sustained sustained-DVFS choices have to keep average power below the
  vapor-chamber + chassis steady-state floor, not just below the
  vapor-chamber transient floor.

For E1 this implies:

- The NPU schedule and CPU DVFS must coordinate to keep sustained power
  in the 4--6 W envelope after vapor-chamber saturation.
- The transient envelope (10--30 s of high power) sets the achievable
  TOPS/W marketing number under realistic workloads but **not** the
  sustained number.

## RowHammer-Class Concerns On Logic (Future)

The `rowhammer_class_disturbance` reference is for DRAM, not 2 nm logic.
There is no current public report of a 2 nm-class logic disturbance class
analogous to RowHammer. The packet does not assert one; it is listed
because the user request specified "RowHammer-class" RAS coverage and the
relevant production attention is on the DRAM PHY + controller interaction,
not on the logic die.

## Implications For E1's process-14a-effects.yaml

Tied to `self_heating_and_power_density`, `reliability_aging_and_lifetime`,
`sram_density_vmin_and_ecc`:

- The contract is correct to require workload-correlated thermal capture.
  The transient vs sustained envelope distinction is what allows a credible
  TOPS/W claim under sustained AI workload to be separated from the burst
  TOPS/W number.
- The contract's `must_model` list for `reliability_aging_and_lifetime`
  must use nanosheet-specific derates (BTI ~2x, EM revised for Mo/Ru
  rails). FinFET-era derates underestimate end-of-life timing shift.
- The contract's `must_model` list for `sram_density_vmin_and_ecc` must
  include latch-FIT, not only bit-FIT, and must specify bit-interleaving
  + ECC + repair policy.
