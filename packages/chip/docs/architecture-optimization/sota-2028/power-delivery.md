# Power Delivery SOTA — 2028 RISC-V Phone-Class AP

Sub-report of [2028-sota-integrated-report.md](../2028-sota-integrated-report.md).

## A. SOTA snapshot — mobile-class SoC PDN

### A.1 PMIC / external regulator landscape

| SoC | Process | Companion PMIC | Public rail count | Notes |
| --- | --- | --- | --- | --- |
| Snapdragon 8 Elite Gen 5 | TSMC N3P | PMK8550 / PM8550 family (multi-die set: 8550, 8550VS, 8550B, PMR735, PMX75, PM8010, plus separate Hexagon PMIC) | ~6-8 dies, 30-40 LDOs + ~12-16 SMPS bucks | RPMh + RSC + VRM accelerators coordinate per-rail. Linaro DT binding `qcom,rpmh-regulator` lists discrete buck/LDO control. |
| MediaTek Dimensity 9500 | TSMC N3P | MT6373 + MT6363 (+ MT6362 sub-PMIC) | MT6363 ≈ 7 bucks + 4 VEMC + LDOs; MT6373 ≈ 4 bucks + 16 LDOs | Dual-PMIC partition. Some rails GPU/NPU-only fast-DVFS bucks; others AON / IO / analog LDOs. |
| Apple A19 Pro | TSMC N3P | Custom Apple (no public part #; teardowns show ≥ 2 Apple PMIC + Dialog/STMicro for sub-systems) | ~12-18 primary rails on-die regulated | Apple uses many fine-grained on-die LDOs per cluster; PMIC supplies pre-regulated mid-voltage rails (~1.0 V) that SoC post-regulates per domain. |
| Samsung Exynos 2600 | Samsung SF2 (2 nm GAA) | S2MPS27 + S2MPB02-class | ~8-10 SMPS + 20+ LDOs across pair | I²C / SPMI control. |
| Google Tensor G5 | TSMC 3 nm | Reused Samsung S2MPS-class | ~10-14 primary rails | Upstream DT `google,gs201-power-domain` hints at coarse layout. |

### A.2 On-die regulator and droop sensor practice

- **Intel FIVR (4th-gen Core, 22 nm, 2013)** — 140 MHz multi-phase buck with package-trace inductors; on-die MIM caps. 80 MHz unity-gain BW.
- **Intel MIA + FIVR2 (10th-gen, 2020)** — magnetic inductor array on-package.
- **Distributed digital LDOs** — 28 nm distributed dLDOs published with ~100 mV droop / 500 mA load / settling <20 ns. Newer 22 nm computational dLDOs target 10 A class for big cores with sub-20-ns transient.
- **Adaptive clocking for droop tolerance** — IBM POWER9 and AMD 28 nm x86-64 publish full ACS systems: clock stretches on droop detection within 1-3 cycles, recovers within tens of cycles.
- **Apple specifics largely undocumented** in primary literature, but iPhone-class chips widely understood (via patents and teardown) to use per-cluster LDOs and adaptive clocking — Apple holds multiple droop-detector / supply-droop-compensation patents (USPTO 10145868, 10320375, 10749513, 11397444).

### A.3 Backside power delivery (BSPDN / PowerVia / SPR)

- **Intel PowerVia (production, 18A in 2025)** — first production BSPDN. Internal E-core test vehicle with > 90% utilization shows: >30% platform voltage droop improvement, 6% frequency benefit at iso-voltage, looser frontside metal pitch reducing lithography cost.
- **TSMC A14 (production 2028)** — first version is frontside-PDN only for mobile/client. Separate **A14 + SPR (Super Power Rail)** = informally "A12" with BSPDN ships in 2029.
- Samsung SF2 has BSPDN roadmap; Exynos 2600 reported on SF2 without BSPDN.
- **Thermal trade-off**: BSPDN puts power TSVs through bulk, removing thermal contact between active devices and substrate top side. SemiEngineering and IRDS 2024 flag higher local Tj because heat travels through BEOL of carrier rather than directly out back. Cooling at package and board must compensate.

### A.4 On-die decap density

- TSMC SHPMIM caps for N2: > 2× density vs SHDMIM, 50% lower sheet/via resistance.
- TSMC iCAP (CoWoS interposer DTC) — 340 nF/mm².
- Mobile-class on-die decap rule-of-thumb (teardown analysis): ~5-10× total Cdecap-to-Cload in package + die combined, with deep-trench MIM contributing the majority of high-frequency response (1-100 MHz); package + board caps cover 10 kHz-10 MHz.

### A.5 Mobile SoC power envelope (public + measured)

| SoC | Sustained TDP (independent throttle) | Peak power | Typical Tj |
| --- | --- | --- | --- |
| Snapdragon 8 Elite Gen 5 | ~6.5-7.5 W (Galaxy S26 thermal) | ~12-14 W peak burst | 95-110 °C |
| Dimensity 9500 | ~6 W ("56% NPU peak power down" claim) | ~11 W peak | 95-105 °C |
| A19 Pro | ~6 W iPhone 17 Pro; Tom's Guide 15.5 h battery | ~10 W peak | 95-100 °C |
| Exynos 2600 | Provisional; early reviews show poor sustained vs peak | ~12 W peak (S26 tests) | 95-110 °C |

## B. Current state in `packages/chip`

| Aspect | State | Evidence |
| --- | --- | --- |
| PMIC | None. No vendor, no IP, no board placement. | `docs/architecture-optimization/physical-power-thermal.md` |
| Rail count | 2 (VDDCORE @ 1.8 V, VDDIO @ 3.3 V) for Sky130 demo pad ring | `package/e1-demo-pinout.yaml` |
| On-die LDOs / IVR | None | grep returns 0 |
| DVFS controller | None. Only narrative in `docs/arch/linux-capable-cpu-contract.md` | |
| Droop sensors | None | |
| AVFS / adaptive clocking | None | |
| BSPDN | `frontside_power_delivery_until_specific_bspdn_option_is_selected` in `docs/spec-db/process-14a-effects.yaml`. Two variants planned: `frontside_pdn_a14_class`, `backside_pdn_or_super_power_rail_follow_on` |
| Decap strategy | OpenLane defaults on Sky130 demo. No package-level or DTC plan. |
| IR-drop signoff | OpenROAD `irdrop.rpt` only: VPWR worst 87.6 µV @ TT 25 °C 1.8 V; VGND 105.98 µV — 5.5 mW SkyWater 130 nm demo. **Not mobile-class workload.** |
| EM signoff | Not produced |
| UPF / IEEE 1801 | Not authored |
| Power-management firmware | Not started. No SBI MPxy, RPMI client, SCMI server |
| Total budget | 5.5 mW (OpenLane demo) vs **4.57 W modeled** in `soc-optimized-operating-point.yaml` |

Gap: design-document level only on PDN; ~830× scaling distance between OpenLane demo current (3 mA on VDDCORE) and 2028 phone-class draw (~5 A across all core rails at ~0.7 V).

## C. Recommended 2028 target

### C.1 Process anchor

- Primary release: **TSMC A14** (frontside PDN), HVM 2028, 2nd-gen GAA nanosheet.
- Stretch/follow-on: **A14 + SPR ("A12")** BSPDN variant, HVM 2029 — opt-in DTCO swap (separate `pd/openroad/` config), not critical path. Budget shows +6% perf and 30% droop reduction *if* thermal mitigation closes.
- Backup: Samsung SF2P (BSPDN) — second-source.

### C.2 Rail topology — 16 rails (production 2028 SKU)

Aligned with `soc-optimized-operating-point.yaml`'s 2-core CPU + NPU + memory layout, scaled to phone-class. Budget targets, not measurements.

| # | Rail | Nominal V (TT) | DVFS range | Peak I (A) | Avg I (A) | Regulator | Domain |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | VDD_CPU_BIG | 0.70 V | 0.55-0.95 V | 3.5 | 1.0 | Ext buck + on-die dLDO/core | 2× big OoO cores @ 3.2 GHz base |
| 2 | VDD_CPU_LITTLE | 0.65 V | 0.50-0.85 V | 1.5 | 0.4 | Ext buck + on-die dLDO | 4× little in-order |
| 3 | VDD_NPU | 0.70 V | 0.55-0.90 V | 2.5 | 1.7 | Ext buck + on-die dLDO | 44 TOPS @ 1.2 W |
| 4 | VDD_GPU | 0.70 V | 0.55-0.90 V | 2.0 | 0.6 | Ext buck | Framebuffer + future GPU |
| 5 | VDD_SOC_FABRIC | 0.75 V | 0.65-0.85 V | 1.2 | 0.5 | Ext buck | NoC, IOMMU, system cache |
| 6 | VDD_SRAM | 0.80 V | 0.70-0.90 V | 1.5 | 0.6 | Ext buck | All on-die SRAM |
| 7 | VDD_LPDDR_VDDQ | 0.50 V | fixed | 0.8 | 0.5 | Ext buck | LPDDR5X IO |
| 8 | VDD_LPDDR_VDD1 | 1.80 V | fixed | 0.3 | 0.15 | Ext LDO | LPDDR5X array |
| 9 | VDD_LPDDR_VDD2H/2L | 1.05/0.50 V | fixed | 0.5 | 0.3 | Ext buck | LPDDR controller |
| 10 | VDD_PHY_ANALOG | 0.85 V | fixed | 0.4 | 0.2 | Ext LDO | LPDDR PHY analog |
| 11 | VDD_AON | 0.75 V | fixed | 0.05 | 0.02 | Ext LDO + on-die retention LDO | AON island, RTC, mgmt |
| 12 | VDD_PMC | 0.80 V | fixed | 0.1 | 0.05 | Ext LDO | Power-mgmt RISC-V (Ibex) |
| 13 | VDD_IO_18 | 1.80 V | fixed | 0.5 | 0.2 | Ext buck | GPIO, audio, sensor IO |
| 14 | VDD_IO_33 | 3.30 V | fixed | 0.2 | 0.1 | Ext buck | Slow IO, eMMC fallback |
| 15 | VDD_USB_PHY / PCIe | 0.85 / 1.20 V | fixed | 0.3 | 0.1 | Ext LDO | USB 3.x + PCIe Gen4 PHY |
| 16 | VDD_RF_REF | 1.80 V | fixed | 0.2 | 0.05 | Ext LDO | WiFi/BT analog ref |

**Sum: ~5.0 W peak, ~3.5 W sustained at 95 °C Tj, ~1.0 W idle.** Matches `soc-optimized-operating-point.yaml` (max 4.57 W modeled).

### C.3 On-die regulator strategy

- **Per-core dLDO** on big-CPU and NPU. Target <20 ns droop response, ~5% drop @ full step.
- **No FIVR-class buck on-die** in v0 — area cost too high for first open mobile SoC. Switched-capacitor 2:1 SC-DC in v1 if `pd/openlane` supports cap density.
- **AON retention LDO** in always-on island to hold mgmt-core state during deep sleep (S3-equivalent).

### C.4 Adaptive clocking + droop sensing

- **Droop sensor per voltage domain** — ring-oscillator-based, <1 ns droop detect, sampled at 200 MHz. Reference: 22 nm all-digital ADCD (Bowman/Tokunaga).
- **Clock stretcher** per CPU/NPU core, 1-cycle response. Implementation: programmable phase-blender.
- **AVFS loop** — closed-loop voltage tuning driven by in-situ timing margin monitors (canary FFs); 100 µs update; 6.25 mV voltage delta.

### C.5 Decap budget

- **On-die**: SHPMIM-class (A14 equivalent) deep-MIM, target 150 nF/mm² average. Hot-rail CPU/NPU islands target 5× ICs/Iavg ratio = ~250 nF on 12 mm² die area-stretch.
- **Package**: 0.1-10 µF cap bank between BGA balls, ≥40 caps for 5 W SoC.
- **Board**: bulk 22-100 µF tantalum/MLCC near each external buck; ≥4 high-frequency 100 nF MLCCs per ball pair on each core rail.

### C.6 Power-management firmware stack

```
S-mode Linux  --SBI MPXY (sysbus mailbox)-->  M-mode OpenSBI
                                                  |
                                                  | RPMI v1.0
                                                  v
                                          Eliza Power-Mgmt Core (Ibex-32)
                                                  |
                                                  |  SPMI / I2C / RPMSG-equivalent
                                                  v
                                              External PMIC set
```

- **RISC-V MPXY** SBI extension (ratified SBI v3.0) + **RPMI v1.0** (ratified) — drop-in equivalent to Arm SCMI; reuse Linux clk/regulator/cpufreq infrastructure with SBI MPXY mailbox drivers (merged for 6.x).
- **Power-mgmt core**: Ibex-class RV32IMC, gated on AON, runs always-on. Owns: PMIC sequencing, DVFS table arbitration, thermal throttle policy, droop telemetry, secure-boot keys.
- **DVFS tables**: per-corner (SS/TT/FF + 0/25/85/105 °C), generated at characterization from `pd/signoff/sta/*`.

## D. Benchmarks / evaluation / testing

### D.1 Pre-silicon

1. **Activity-traced power signoff** — real workload VCDs (Geekbench-equivalent int trace, MLPerf Mobile NPU INT8, LLM-7B-INT4 token loop, sustained NPU CNN, idle, display refresh) through PrimePower (commercial) or **OpenSTA + Capacitate** (open) into `pd/signoff/power.rpt`. Replaces modeled numbers in `soc-optimized-operating-point.yaml`.
2. **Static IR-drop signoff** — Voltus or RedHawk-SC at SS/TT/FF + 4 thermal corners, all 16 rails. Acceptance: <5% nominal Vdd droop.
3. **Dynamic IR-drop signoff** — vector-driven dynamic with worst-case vectors per block (CPU integer burst, NPU GEMM saturation, CPU+NPU+display simultaneous). Acceptance: <10% droop, AVFS-corrected timing must close.
4. **EM signoff** — foundry-mandated current density limits on all PG layers + clock/reset signal wires. Lifetime derate ≥10 years at 85 °C avg Tj.
5. **PDN impedance** — Z_pdn(f) under 5 mΩ DC and <15 mΩ across 1 kHz-1 GHz. Resonance peaks tracked at package + board boundary.
6. **Anti-resonance + Ldi/dt** — simulate worst slew (CPU NEON-equivalent saturation → idle in 1 cycle) with package + board model.

### D.2 Post-silicon

1. **Power-virus workload** — synthesize custom RTL "current bomb" (mprime + stressapptest + INT8-GEMM saturation analog) calibrated to peak modeled rail current.
2. **Sustained perf-vs-temp** — 30-min runs at 25 °C ambient → measure Tj, throttle response, sustained Geekbench, MLPerf, LLM tok/s. Compare to:
   - A19 Pro sustained Geekbench multi (~8500 after ~10 min)
   - Snapdragon 8 Elite Gen 5 sustained Geekbench multi (~9200)
   - Dimensity 9500 sustained Geekbench multi (~8400)
3. **DVFS table tuning per silicon corner** — characterize each chip at SS/TT/FF and bin into 3 voltage tables.
4. **Droop event capture** — on-die telemetry of droop sensor events during workload transitions; expect <1 event/sec at production V/F.
5. **Skin-temperature correlation** — chamber + free-air with phone-class enclosure; cross-reference `benchmarks/power/manifests/e1-npu-sustained-capture.template.json`.

## E. Optimizations: has / should / needs

### Has
- Two-rail demo padframe with explicit IO/core separation.
- Operating-point optimizer with corner sweep (`make soc-optimization`).
- Process effects contract distinguishing FSPDN and BSPDN variants (`docs/spec-db/process-14a-effects.yaml`).
- Local IR-drop reporting from OpenROAD on Sky130 demo.

### Should (P1, 2028 target)
- Per-domain power gating with retention FFs on caches/regfiles. UPF (IEEE 1801) for every island.
- Per-cluster fast DVFS via on-die dLDOs (CPU big, NPU).
- AVFS loop + droop sensors + clock stretchers.
- Thermal-aware DVFS with on-die DTSs (≥8 sensors, one per power island).
- SBI MPXY + RPMI power-management firmware on Ibex management core.
- DTC + MIM on-die decap sized 5× Cload, per-rail allocation.

### Definitely needs (P0, gates the chip)
- **Pick a PMIC vendor or design discrete bucks/LDOs.** Open mobile-class PMIC IP does not exist publicly. Options:
  1. Buy Renesas/MPS/TI/Maxim mobile PMIC catalog parts and use 4-6 in parallel.
  2. License closed IP (Synaptics, Dialog) — slow, expensive.
  3. Custom analog design — requires analog team and separate older-node tapeout (realistic for v0: discrete PMIC daughtercard from 8-12 catalog regulators, hop to integrated for v1).
- **Authoritative rail list and UPF.** Today's 2-rail padframe good only for Sky130 demo. 14A SKU must publish 16-rail map and freeze before RTL closes.
- **Power signoff EDA path.** OpenROAD static IR-drop is triage. Buy Voltus or RedHawk-SC seats; gap to open EDA in dynamic IR/EM is years.
- **Activity-traced power** — replace OpenLane `metrics.json` mW with VCD-driven `power.rpt` for: NPU INT8 GEMM saturation, CPU integer burst, idle, display refresh.
- **Package model with bond-wire / BGA inductance** in PDN sim. Pad-frame R/L from `pd/openlane/runs/.../padframe_inclusive_lvs` must feed back into IR-drop.

## F. Risks and open questions

| Risk | Severity | Mitigation |
| --- | ---: | --- |
| **No open mobile-class PMIC IP exists.** Synopsys/Renesas/Maxim/TI/MPS catalog parts are closed; "open PMIC" in 2025 limited to academic ASICs and few RISC-V-controlled industrial parts (Silergy, Allwinner T536). | High | v0 SKU uses 6-8 catalog buck/LDO ICs on daughtercard, controlled via I²C/SPMI by mgmt core. v1 internalizes. |
| **A14 production 2028 ships without BSPDN.** Mobile A14 is frontside-only; BSPDN ("A12") slips to 2029. | Medium | Plan FSPDN as primary release. Treat BSPDN as 2029 re-spin, not 2028 commitment. |
| **Power signoff EDA is closed.** OpenROAD lacks vector-driven dynamic IR-drop. Voltus / RedHawk-SC required for tapeout-grade. | High | Budget for commercial EDA seats during signoff. Document open-EDA fallback gating release if Voltus unavailable: static-only IR + worst-case vectorless dynamic with 2× extra margin. |
| **Droop response at >3.5 GHz** requires fast custom loops. Public 22 nm dLDO numbers at lower clocks; mobile big-core 3.2 GHz + NPU peak switching events stress the loop. | Medium | Mandate adaptive clocking (1-cycle stretch) so droop tolerance is not solely on regulator response. |
| **BSPDN thermal penalty** if 2029 variant. Active layer buried in BEOL of carrier; local Tj rises 5-10 °C at same power. | Medium | Reserve 5 °C thermal headroom in BSPDN variant; require enclosure rework before that SKU. |
| **SBI MPXY + RPMI is new** — kernel drivers landed 2025 in 6.x, ABI settling. | Low-Medium | Track Linux mainline carefully; pin OpenSBI release used at silicon bring-up; document fallback to direct PSCI-style calls. |
| **No droop sensor IP today.** All-digital droop detectors well-published but Eliza has none in RTL. | High | Allocate one engineer-month to port public 22 nm-style ADCD design into our PDK; bind into `rtl/power/`. |
| **PMIC-to-SoC interface (SPMI vs I²C vs RPMSG)** — must be chosen before pad ring close. | Medium | Standardize on SPMI v2.0 for v0 (industry default), plus I²C fallback for bring-up board. |
| **Decap density at 14A** — actual DTC area cost competes with logic placement. | Medium | Floor-plan decap allocations in `pd/openroad/` early; mark hot rails for DTC priority. |

## Concrete next moves (≤ 4 weeks)

1. Author `docs/pd/rail-plan-2028.yaml` listing 16 rails, nominal V, DVFS range, peak/avg I, regulator type, decoupling target. Bind to `pd/signoff/manifest.yaml`.
2. Add `docs/pd/pmic-selection.md` with 3 candidate paths (catalog-daughtercard / closed-IP / custom analog); pick v0 path.
3. UPF skeleton in `pd/upf/e1_soc_top.upf`: 16 power domains, isolation cells, retention per island. UPF gate added to `make pd-check`.
4. Stand up `rtl/power/droop_sensor.sv` + `rtl/power/clock_stretcher.sv` ports of public 22 nm designs; cocotb tests for droop event injection.
5. `scripts/check_pdn_workload_signoff.py` — fails closed if `pd/signoff/<RUN>/reports/ir_drop.rpt` is not vector-driven, multi-corner, signed by Voltus/RedHawk OR explicitly waived with open-flow fallback margin.
6. Wire `soc-optimized-operating-point.yaml` to rail-plan; gate operating-point report on rail-plan hash, so future modeled-power changes invalidate the claim.
7. RFC: choose SBI MPxy + RPMI as power-management ABI. Open issue against `docs/project/spec-rtl-sw-pd-handoff-work-order.yaml`.

## Sources

- [Qualcomm Snapdragon 8 Elite Gen 5 brief](https://www.qualcomm.com/content/dam/qcomm-martech/dm-assets/documents/Snapdragon-8-Elite-Gen-5-product-brief.pdf)
- [Qualcomm RPMh](https://docs.qualcomm.com/bundle/publicresource/topics/80-88500-4/45_RPMh.html)
- [Linux qcom,rpmh-regulator DT binding](https://www.kernel.org/doc/Documentation/devicetree/bindings/regulator/qcom,rpmh-regulator.txt)
- [Linaro: Qualcomm PM8550 mainline](https://linaro.github.io/msm/pmic/pm8550)
- [MediaTek Dimensity 9500](https://www.mediatek.com/dimensity-9500)
- [LKML — MediaTek MT6373 PMIC binding (Oct 2025)](https://lkml.org/lkml/2025/10/16/413)
- [Intel PowerVia IEEE VLSI 2023](https://ieeexplore.ieee.org/document/10185208/)
- [Semiconductor Engineering: BSPDN thermal challenges](https://semiengineering.com/backside-power-delivery-creates-fab-tool-thermal-dissipation-barriers/)
- [TSMC A14 2028 production, BSPDN slips to 2029](https://www.tomshardware.com/tech-industry/tsmcs-2nm-nodes-get-nanoflex-n2p-loses-backside-power-delivery)
- [Intel FIVR — IEEE ISSCC 2013](https://ieeexplore.ieee.org/document/6803344)
- [Intel MIA — IEEE 2020](https://ieeexplore.ieee.org/document/9159488/)
- [Computational digital LDO for mobile SoC big-core (2024)](https://www.researchgate.net/publication/384768142_A_Computational_Digital_LDO_With_Distributed_Power-Gating_Switches_and_Time-Based_Fast-Transient_Controller_for_Mobile_SoC_Application)
- [POWER9 adaptive clocking ISSCC](https://www.researchgate.net/publication/314295172_265_Adaptive_clocking_in_the_POWER9_processor_for_voltage_droop_protection)
- [22 nm all-digital ADCD — Bowman/Tokunaga](https://www.semanticscholar.org/paper/A-22-nm-All-Digital-Dynamically-Adaptive-Clock-for-Bowman-Tokunaga/fea271a241d4cb626a9c3896cb2ed22cc886ac78)
- [Apple droop-detector patents: USPTO 10145868](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10145868), [10320375](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10320375), [10749513](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10749513), [11397444](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11397444)
- [TSMC SHPMIM N2 capacitor](https://www.tomshardware.com/tech-industry/tsmcs-2nm-nodes-get-nanoflex-n2p-loses-backside-power-delivery)
- [Deep-trench capacitor — WikiChip](https://en.wikichip.org/wiki/deep_trench_capacitor)
- [Real World Tech — Power delivery in a modern processor](https://www.realworldtech.com/power-delivery/4/)
- [Ansys RedHawk-SC](https://www.ansys.com/products/semiconductors/ansys-redhawk-sc)
- [Synopsys VC LP — UPF static signoff](https://www.synopsys.com/content/dam/synopsys/gated-assets/verification/vc_lp_ds.pdf)
- [IEEE 1801 / UPF 4.0 — DVCon 2024](https://dvcon.org/introduction-of-ieee-1801-2024-upf-4-0-improvements-for-the-specification-and-verification-of-low-power-intent)
- [OpenSBI — RISC-V MPXY + RPMI v1.0](https://github.com/riscv-software-src/opensbi/releases/)
- [LWN — Linux SBI MPXY and RPMI](https://lwn.net/Articles/1031561/)
- [SBI MPXY mailbox DT binding RFC v2](https://patchwork.kernel.org/project/linux-clk/patch/20250203084906.681418-4-apatel@ventanamicro.com/)
- [Notebookcheck Snapdragon 8 Elite Gen 5](https://www.notebookcheck.net/Qualcomm-Snapdragon-8-Elite-Gen-5-Processor-Benchmarks-and-Specs.1123169.0.html)
- [Notebookcheck Apple A19 Pro](https://www.notebookcheck.net/Apple-A19-Pro-Processor-Benchmarks-and-Specs.1126974.0.html)
- [Notebookcheck Dimensity 9500](https://www.notebookcheck.net/MediaTek-Dimensity-9500-Processor-Benchmarks-and-Specs.957550.0.html)
- [Samsung Exynos 2600](https://semiconductor.samsung.com/processor/mobile-processor/exynos-2600/)
