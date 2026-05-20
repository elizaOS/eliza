# Linux/Android-capable open RISC-V cores comparison

Date: 2026-05-19

This note compares the open RV64 cores that are credible candidates for the
Eliza E1 Android-class application processor (AP) role, or that could serve
as a secondary cluster, debug hart, or accelerator-control hart. The current
e1-chip selection is Chipyard 1.13.0 `ElizaRocketConfig` (single Rocket
RV64GC hart) per `docs/arch/cpu-subsystem.md` and pinned by
`generators/chipyard/eliza-rocket-manifest.json`. The cores below are
ordered by their plausibility as alternates or augmentations.

## Comparison matrix

| Core | uArch | ISA on master | MMU | Vector | H (Hypervisor) | Coherence | Public Linux/Android boot | License | Notes vs E1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Rocket (chipyard)** | 5-stage in-order scalar | RV64GC + optional Zb*/Zk* | Sv39 | RoCC accelerator, optional Hwacha/Saturn | optional | TileLink + L2 | upstream Linux + OpenSBI + Buildroot, Sscofpmf merged | BSD-3-Clause | Current selection. Conservative, smallest gap to a Linux gate. |
| **BOOM / SonicBOOM** | OoO 2-4 issue | RV64GC | Sv39 | optional Hwacha or RoCC | partial | TileLink-C | Linux boots on FireSim regularly | BSD-3-Clause | Strong AP candidate when Rocket bring-up closes; same Chipyard plumbing. |
| **CVA6 (Ariane)** | 6-stage in-order single-issue | RV64GC | Sv32/Sv39 | CVA6-V in progress | ratified H in development | AXI4 + cache-coherent overlays via OpenPiton/Cheshire | upstream Linux on Ariane FPGA, OpenSBI | Solderpad-2.1 | Strong industry adoption; OpenPiton/Cheshire/Carfield ecosystems use it as the host hart. |
| **XiangShan KunMingHu (v3)** | 8-issue OoO | RV64GCV + H + Zfh + B + K | Sv39/Sv48 | RVV 1.0 | yes | TileLink-C + HuanCun directory | Linux + Debian RV; Yanqi+Nanhu tapeouts at 14 nm | Mulan-PSL-v2 | Highest-performance open core. Largest area, longest verification surface. |
| **OpenC910 / OpenC920** | 12-stage 3-issue OoO | RV64GCV (V0.7.1 on C910/C920) | Sv39 | RVV 0.7.1 vector unit | partial | Private L1, shared L2 MESI | Allwinner D1 (C906), TH1520 (C910/C920) ship Debian/Android/OpenWrt | Apache-2.0 | Production-proven but pre-RVV-1.0; ABI risk for Android. |
| **OpenC908** | in-order 9-stage | RV64GCV with RVV 1.0 | Sv39 | RVV 1.0, 128-bit DLEN | no | L1+L2 | open RTL; FPGA boot evidence | Apache-2.0 | RVV 1.0 in-order alternative to Rocket; smaller area than KunMingHu. |
| **NaxRiscv** | OoO register-renamed | RV64GC + planned RVV | Sv39 | planned | planned | SpinalHDL bus, AXI overlays | Linux-capable, FPGA Linux boot demos | MIT | Newer, smaller community; useful as a SpinalHDL alternative if we ever leave Chisel/Chipyard. |
| **BlackParrot 1.x** | in-order RV64GC | RV64GC | Sv39 | none | none | BedRock directory MOESI | Linux multicore boot demos | BSD-3-Clause | Multicore-first design; not vector-friendly; good NoC reference. |
| **Vroom** | 8-wide OoO | RV64GC | Sv39 | none | none | not specified | research, no Android evidence | MIT | Treat as a research point, not a deployment candidate. |

## Per-core critical assessment

### Rocket (current selection)

- **Why it stays the selection.** Smallest verified Linux gap, the standard
  Chipyard glue (CLINT, PLIC, debug, UART, TileLink, OpenSBI hooks), the
  Gemmini RoCC integration already exists in Chipyard, and the existing
  `eliza-rocket-manifest.json` lockfile in this repo binds the version.
- **Risk.** In-order scalar Rocket cannot meet phone-class AP performance
  targets in `docs/spec-db/mobile-sota-2026.yaml`. It satisfies the
  Linux bring-up gate only.
- **E1 fit.** Keep as the AP bring-up vehicle through the Linux smoke,
  OpenSBI handoff, and trap/timer/IRQ gates in
  `docs/arch/linux-capable-cpu-contract.md`. Treat it as scaffold, not as a
  phone-class AP claim.

### BOOM / SonicBOOM

- **Why it is the natural follow-on.** Same Chipyard plumbing, same RoCC
  surface, same TileLink fabric, but real OoO that can run SPEC and
  Geekbench credibly. SonicBOOM is the published evolution and is what
  XiangShan and Chipyard tend to be benchmarked against.
- **Risk.** Larger DV surface, larger PD effort, more aggressive predictor
  invariants. Chipyard support is robust but not zero-touch.
- **E1 fit.** Primary candidate to replace Rocket once Rocket's Linux gate
  closes. Should be staged behind its own
  `docs/spec-db/cpu-2028-target.yaml` selection, not silently swapped in.

### CVA6 / Ariane

- **Why it matters.** OpenHW Group's flagship; the only open core with a
  production verification flow (`core-v-verif`, SV4SV formal), production
  tapeouts (e.g., GlobalFoundries 22 nm), and a mature SoC scaffold
  (Cheshire, Carfield, OpenPiton).
- **Risk.** Single-issue in-order; performance below BOOM/XiangShan. RVV
  unit is still being upstreamed.
- **E1 fit.** Strongest alternative if we ever leave Chipyard. CVA6 +
  Cheshire is the most batteries-included open Linux SoC.

### XiangShan KunMingHu

- **Why it matters.** Highest-performance open OoO RV64 core in 2026. RVV
  1.0, H, B, K all supported. HuanCun gives a directory-coherent L2/L3.
- **Risk.** Mulan license differs from BSD/Apache. ICT-China maintainership
  pace differs from upstream Chipyard. Area and verification surface dwarf
  Rocket. Synthesis flow toolchain is China-localized but Yosys/OpenROAD
  paths exist.
- **E1 fit.** Long-term candidate for an AP cluster when E1 needs to chase
  flagship Geekbench parity. Should not be the first generated AP; it
  would obscure the simpler Rocket gate.

### XuanTie OpenC910 / OpenC920

- **Why it matters.** Only RV64 cores in mass production for Android-class
  Linux SoCs (Allwinner D1, TH1520, LicheePi 4A). C910/C920 ship in
  consumer devices with Android (XuanTie's own Android-on-RV demos in
  2024).
- **Risk.** RVV 0.7.1 not RVV 1.0. Android RV upstream (RISE / Google) is
  RVV 1.0 only. Anyone shipping a XuanTie-class core for Android in 2026
  must commit to RVV 1.0 silicon.
- **E1 fit.** Useful primarily as a software-stack and Android-on-RV
  reference. Treat as evidence source for OpenSBI / U-Boot / kernel hooks,
  not as an RTL drop-in.

### OpenC908

- **Why it matters.** Open RVV 1.0 in-order vector core. Sits architecturally
  between Rocket+Saturn and CVA6+Ara2.
- **E1 fit.** Reference for an open RVV 1.0 in-order point design if we
  decide to bring up vectors before BOOM/KunMingHu work lands.

### NaxRiscv

- **E1 fit.** Useful only if E1 chooses to leave Chisel/Chipyard for
  SpinalHDL, which is not on the roadmap. Keep tracked, not selected.

### BlackParrot

- **E1 fit.** Useful as a directory-coherence reference (BedRock), not as
  a candidate AP. Multicore mesh design optimizes for a different system
  shape than a single AP cluster + NPU + management cores.

### Vroom

- **E1 fit.** Research curiosity; not selectable.

## Mapping to E1 contracts

| Contract gate (linux-capable-cpu-contract.md) | Best-fit open core today | Notes |
| --- | --- | --- |
| `rv64gc_isa` | Rocket (selected) | All cores above pass; Rocket has the simplest evidence path. |
| `s_mode_privilege` | Rocket, CVA6 | Both have audited M/S/U evidence in OpenSBI/Linux. |
| `mmu_sv39_or_stronger` | Rocket (Sv39), KunMingHu (Sv48) | Sv48 is not required for Android RV today (RVA22 requires Sv39). |
| `clint_timer_software_irq` | Rocket + Chipyard CLINT (selected) | Sstc is preferred long-term; track in spec-db. |
| `plic_external_irq` | Rocket + Chipyard PLIC (selected) | AIA (Smaia/Ssaia) is the long-term move for KunMingHu-class. |
| `uart_console` | Chipyard SiFive UART | Already in scaffold. |
| `dtb_linux_boot_contract` | Chipyard-generated DTS | gate via `scripts/check_chipyard_generated_linux_contract.py`. |
| `opensbi_handoff` | OpenSBI + Chipyard platform | upstream platform exists. |
| `linux_initramfs_smoke` | Rocket + Chipyard + Buildroot/initramfs | reproducible via Chipyard's marshal. |
| (future) Android CTS smoke | RVA22+V on BOOM/KunMingHu | requires NDK/CTS-on-RV stability first. |

## Recommendation

Hold the current Rocket selection through Linux/OpenSBI gates. Open a
separate `docs/spec-db/cpu-2028-target.yaml` that:

1. Names BOOM/SonicBOOM as the Phase B AP candidate inside Chipyard.
2. Lists CVA6 as a backup if Chipyard ever has to be replaced.
3. Lists Ibex (OpenTitan-style) as the management/security hart and a
   second Ibex as a watchdog/debug hart.
4. Records KunMingHu as a tracked-only point until Android RV upstream
   stabilizes and the spec-db NPU/CPU/Memory budgets justify it.

The package's NPU integration via Gemmini already binds us to Chipyard;
non-Chipyard cores are tracked as alternates only.
