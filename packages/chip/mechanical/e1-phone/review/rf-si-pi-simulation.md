# E1 phone RF / SI / PI analytical pre-scan

- evidence_class: `analytical_rf_si_pi_prescan_not_chamber_measured`
- generated: deterministic, reproducible (`simulate_e1_phone_rf_si_pi.py`)
- device: [78.0, 153.6, 12.7] mm, PC+ABS er~3.0 enclosure

This is an **analytical / closed-form pre-scan**, not a chamber, VNA, or scope measurement. Each result is bounded by a cited physical limit and checked against a target spec. A real anechoic chamber (antenna), VNA (impedance/loss), and oscilloscope/PDN-VNA (eye/droop) measurement remain the binding release evidence.

## A) Antenna -- Chu/McLean + Bode-Fano + literature efficiency

Formulas:
- Chu sphere radius `a` = (1/2)*diagonal of keepout box; `ka = 2*pi*f*a/c`.
- McLean min radiation Q: `Q_min = 1/(ka)^3 + 1/(ka)`.
- Max FBW at VSWR s: `FBW = (s-1)/(Q*sqrt(s))` (s=2).
- Bode-Fano single-resonance mismatch cap: `ln(1/|Gamma|) <= pi/(Q*FBW)`, `eta_match = 1-|Gamma|^2`.
- Total efficiency = radiation_eff (cited typical) x eta_match. Floor: -4 dB (~40 %).

| Band | f (GHz) | keepout (mm) | ka | Qmin | maxFBW% | reqFBW% | rad eff | total eff (dB) | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| cellular_low_band | 0.7-0.96 | 62.0x6.0x2.0 | 0.5354 | 8.38 | 8.43 | 31.72 | 0.55 | -3.03 | FAIL |
| cellular_mid_high | 1.7-2.7 | 62.0x6.0x2.0 | 1.3992 | 1.08 | 65.49 | 46.68 | 0.78 | -1.08 | PASS |
| cellular_n78 | 3.3-3.8 | 62.0x6.0x2.0 | 2.3127 | 0.51 | 137.77 | 14.12 | 0.8 | -0.97 | PASS |
| wifi_2g4 | 2.4-2.4835 | 34.0x5.0x2.0 | 0.8807 | 2.6 | 27.2 | 3.42 | 0.62 | -2.08 | PASS |
| wifi_5g | 5.15-5.85 | 34.0x5.0x2.0 | 1.98 | 0.63 | 111.55 | 12.75 | 0.72 | -1.43 | PASS |
| wifi_6g | 5.925-7.125 | 34.0x5.0x2.0 | 2.3438 | 0.5 | 140.21 | 18.47 | 0.7 | -1.55 | PASS |
| gnss_l1 | 1.559-1.61 | 34.0x5.0x2.0 | 0.5715 | 7.11 | 9.95 | 3.22 | 0.55 | -2.6 | PASS |

- **cellular_low_band FAIL**: Chu/McLean limit: keepout electrical size cannot support the required fractional bandwidth at VSWR 2:1 -- needs a larger keepout volume or band-switching tuner.

Antenna verdict: **FAIL_WITH_FLAGS** (1 FAIL).
Chamber confirms: total-efficiency / realized-gain / TRP / TIS sweep per band.

## B) Signal integrity -- closed-form transmission line

Formulas: Hammerstad-Jensen microstrip Z0 + eeff; edge-coupled diff `Zdiff = 2*Z0*(1-0.48*exp(-0.96*s/h))`; `alpha_c = Rs*Kr/(w*2*Z0)`, `alpha_d = pi*sqrt(eeff)/lambda0 * tan_d`.

| Net | Spec | len (mm) | Zdiff/Z0 (ohm) | target | err% | loss (dB) | budget | Verdict |
|---|---|---|---|---|---|---|---|---|
| MIPI_DSI_display_4lane | MIPI D-PHY 80-125 ohm, 100 nominal | 45.0 | 108.7 | 100.0 | 8.7 | 0.38 | 2.0 | PASS |
| MIPI_CSI_rear_cam_4lane | MIPI D-PHY 80-125 ohm, 100 nominal | 55.0 | 108.7 | 100.0 | 8.7 | 0.464 | 2.0 | PASS |
| MIPI_CSI_front_cam_2lane | MIPI D-PHY 80-125 ohm, 100 nominal | 65.0 | 108.7 | 100.0 | 8.7 | 0.548 | 2.0 | PASS |
| USB2_HS_to_typeC | USB 2.0 90 ohm +/-15 %, 480 Mbps | 90.0 | 93.6 | 90.0 | 4.03 | 0.301 | 1.5 | PASS |
| CELL_RF_MAIN_low | 50 ohm +/-10 % | 18.0 | 49.4 | 50.0 | 1.18 | 0.084 | 0.5 | PASS |
| CELL_RF_MAIN_mid | 50 ohm +/-10 % | 18.0 | 49.4 | 50.0 | 1.18 | 0.181 | 0.5 | PASS |
| CELL_RF_MAIN_n78 | 50 ohm +/-10 % | 18.0 | 49.4 | 50.0 | 1.18 | 0.271 | 0.5 | PASS |

SI verdict: **PASS** (0 FAIL).
VNA/scope confirms: TDR impedance profile, S21 insertion loss, D-PHY/USB2 eye mask.

## C) Power integrity -- IR drop, decoupling, droop

Formulas: `Rsheet = 1/(sigma*t)`, `R = Rsheet*(L/W)` (plane x0.4); `Vir = I*R`; target `Z = dV/I`; droop `dV = I*t_resp/C + I*ESR`.

| Rail | V | Ipk (A) | Rpath (mohm) | IR drop (mV / %) | droop (mV / %) | Verdict |
|---|---|---|---|---|---|---|
| VDD_CORE_0V8 | 0.8 | 3.0 | 0.263 | 0.79 / 0.099% | 20.08 / 2.51% | PASS |
| VDD_0V8_alt | 0.8 | 1.5 | 0.236 | 0.35 / 0.044% | 12.93 / 1.616% | PASS |
| VDD_1V1 | 1.1 | 1.2 | 0.394 | 0.47 / 0.043% | 11.54 / 1.049% | PASS |
| VDD_1V8 | 1.8 | 0.8 | 0.788 | 0.63 / 0.035% | 14.89 / 0.827% | PASS |
| VDD_3V3 | 3.3 | 1.0 | 1.478 | 1.48 / 0.045% | 20.61 / 0.625% | PASS |
| VSYS | 3.85 | 3.5 | 0.493 | 1.72 / 0.045% | 23.07 / 0.599% | PASS |
| RF_VBAT_modem | 3.85 | 2.0 | 3.448 | 6.9 / 0.179% | 22.77 / 0.591% | PASS |
| VBAT_main | 3.85 | 4.5 | 0.411 | 1.85 / 0.048% | 21.26 / 0.552% | PASS |

PI verdict: **PASS** (0 FAIL). Target: IR drop <3 %/rail.
PDN-VNA / scope confirms: measured PDN impedance vs frequency and load-step droop.

## Overall

- Antenna: **FAIL_WITH_FLAGS**
- Signal integrity: **PASS**
- Power integrity: **PASS**
- Overall: **FAIL_WITH_FLAGS**

### Assumptions (all areas)
- Chu sphere = smallest sphere enclosing the keepout box (diagonal/2).
- Radiation efficiency values are cited literature typicals for tuned compact-handset elements, NOT measured for this enclosure.
- Mismatch efficiency capped by Bode-Fano single-resonance bound at the band's required fractional bandwidth, VSWR 2:1.
- Total efficiency = radiation_eff * mismatch_eff; enclosure-plastic (PC+ABS, er~3.0) and hand/head loading not de-rated here -- chamber measurement is the binding evidence.
- Trace/space/height are typical-class assumptions; the board-house impedance coupon is the binding evidence.
- Insertion loss evaluated at the bit-rate fundamental (NRZ/DDR half-rate).
- Diff impedance from single-ended Z0 via edge-coupled coupling factor.
- Note: routing-constraints.yaml sets MIPI to 100 ohm diff; the task brief said 90 ohm -- the 100 ohm spec file value is used.
- Copper sigma=5.8e7 S/m; plane spreading approximated as 0.4x a same-aspect trace; via stack resistance not included (adds margin for via-in-pad PMIC/SoC fanout).
- Peak currents are datasheet-class estimates (SoC core ~3 A transient, modem TX burst ~2 A); confirm against final SoC/modem datasheets.
- Droop is a first-order pre-regulator-response bound; PDN resonance and loop phase margin require a measured VNA PDN impedance sweep.
