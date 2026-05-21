#!/usr/bin/env python3
"""First-principles RF / SI / PI pre-scan for the E1 phone (EVT0 concept).

This is an analytical / closed-form pre-scan, NOT a chamber / VNA / scope
measurement. It moves the RF/SI/PI residual from "requires chamber" to
"analytically pre-scanned, chamber confirms later" by bounding each result
against a cited physical limit and a target spec.

Three areas:
  A) ANTENNA  -- Chu-Harrington fundamental Q/efficiency-bandwidth limit on the
                 keepout electrical size + Bode-Fano matching bound + cited
                 typical handset total-efficiency literature.
  B) SIGNAL INTEGRITY -- closed-form microstrip/stripline impedance (Hammerstad-
                 Jensen / Wadell), conductor+dielectric insertion loss, eye budget
                 vs MIPI D-PHY and USB 2.0 HS specs.
  C) POWER INTEGRITY  -- PCB copper IR drop, decoupling target impedance, and
                 first-order rail droop under a load step.

Cited limits / specs:
  - L. J. Chu, "Physical Limitations of Omni-Directional Antennas," J. Appl.
    Phys. 19, 1163 (1948); R. F. Harrington (1960); McLean's exact form of the
    minimum radiation Q:  Q_min = 1/(k a)^3 + 1/(k a).  (J. S. McLean, IEEE TAP
    44(5), 1996.)  Fractional bandwidth FBW <= 1/(Q * sqrt(s)) at VSWR s.
  - H. W. Bode / R. M. Fano, "Theoretical limitations on the broadband matching
    of arbitrary impedances," J. Franklin Inst. 249 (1950): bandwidth-reflection
    integral bound for a single-resonance load.
  - Typical compact-handset total antenna efficiency from literature
    (e.g. Refs in Pedersen/Andersen handset studies, Skycross/Ethertronics app
    notes, 3GPP TR 37.xxx OTA): low-band 700-960 MHz ~ -6 to -4 dB (25-40%),
    mid/high 1.7-2.7 GHz ~ -3 to -2 dB (50-63%), n78 3.3-3.8 GHz ~ -2.5 to -1.5 dB.
  - MIPI Alliance D-PHY v1.2/v2.x: HS differential 80-125 ohm (100 ohm nominal),
    HS data rate to 2.5 Gbps/lane (D-PHY), eye / channel insertion-loss budget.
  - USB 2.0 spec (USB-IF rev 2.0): 90 ohm +/-15% differential, HS 480 Mbps,
    high-speed channel rise time and eye mask.

evidence_class: analytical_rf_si_pi_prescan_not_chamber_measured
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------------------
# Physical constants
# ---------------------------------------------------------------------------
C0 = 299_792_458.0  # m/s
MU0 = 4.0e-7 * np.pi
EPS0 = 1.0 / (MU0 * C0**2)
ETA0 = np.sqrt(MU0 / EPS0)  # ~376.73 ohm free-space impedance
SIGMA_CU = 5.8e7  # S/m, annealed copper

EVIDENCE_CLASS = "analytical_rf_si_pi_prescan_not_chamber_measured"

REVIEW_DIR = Path(__file__).resolve().parents[1] / "mechanical/e1-phone/review"


# ===========================================================================
# Shared helpers
# ===========================================================================
def lin_to_db(x: float) -> float:
    return 10.0 * np.log10(x)


def db_to_lin(x: float) -> float:
    return 10.0 ** (x / 10.0)


def enclosing_sphere_radius_m(l_mm: float, w_mm: float, h_mm: float) -> float:
    """Radius of the smallest sphere enclosing the radiating volume (Chu sphere)."""
    diag_mm = np.sqrt(l_mm**2 + w_mm**2 + h_mm**2)
    return 0.5 * diag_mm * 1e-3


# ===========================================================================
# A) ANTENNA -- Chu / McLean Q limit + Bode-Fano + literature efficiency
# ===========================================================================
def mclean_min_q(ka: float) -> float:
    """McLean exact minimum radiation Q for a linearly polarized antenna."""
    return 1.0 / (ka**3) + 1.0 / ka


def chu_fractional_bandwidth(ka: float, vswr: float = 2.0) -> float:
    """Max fractional bandwidth achievable at the Chu Q limit for a VSWR=s match.

    FBW = (s - 1) / (Q * sqrt(s))   (matched-VSWR bandwidth, Yaghjian-Best form).
    """
    q = mclean_min_q(ka)
    return (vswr - 1.0) / (q * np.sqrt(vswr))


def bode_fano_max_efficiency(ka: float, frac_bw_required: float, vswr: float = 2.0) -> float:
    """Bode-Fano single-resonance bound on the best |Gamma| achievable when
    forcing the required fractional bandwidth onto a load of the given radiation Q.

    Bode-Fano:  integral ln(1/|Gamma|) df <= pi/(R C) ; for a single resonance
    of loaded Q this collapses to ln(1/|Gamma|_avg) <= pi/(Q * FBW).
    Mismatch efficiency cap eta_match = 1 - |Gamma|^2.
    """
    q = mclean_min_q(ka)
    # Best achievable average reflection magnitude over the band:
    ln_inv_gamma = np.pi / (q * frac_bw_required)
    gamma = np.exp(-ln_inv_gamma)
    eta_match = 1.0 - gamma**2
    return float(np.clip(eta_match, 0.0, 1.0)), float(gamma)


# Typical measured radiation efficiency of a well-tuned compact-handset element
# (literature, excludes mismatch). Lower in low-band where the element is a small
# fraction of a wavelength and ground-plane losses dominate.
TYPICAL_RAD_EFF = {
    "low_band": 0.55,    # 700-960 MHz, electrically small edge element
    "mid_high": 0.78,    # 1.7-2.7 GHz
    "n78": 0.80,         # 3.3-3.8 GHz
    "gnss_l1": 0.55,     # 1.559-1.61 GHz passive patch/FPC
    "wifi_2g4": 0.62,    # 2.4 GHz side PIFA
    "wifi_5g": 0.72,     # 5 GHz
    "wifi_6g": 0.70,     # 6 GHz
}

# Carrier / spec minimum total-efficiency floors (typical operator OTA intake
# expressed as total efficiency; -4 dB ~ 40% is the common "passable" gate).
PASS_FLOOR_DB = -4.0  # ~40 % total efficiency

# Cellular low-band aperture/band-switch tuner. A real buyable RFFE part
# (Qorvo QPC1252Q; alt pSemi PE613050) retunes the electrically-small low-band
# element across 700-960 MHz. The key physics: the radio never needs the FULL
# 700-960 MHz span matched at once -- it transmits/receives ONE carrier at a
# time (LTE <=20 MHz, NR low-band <=20 MHz, a single RF channel). The tuner
# steps its resonance to center the narrow Chu match window on the ACTIVE
# carrier; the modem programs the tuner state per channel over RFFE. So the
# binding requirement is the INSTANTANEOUS single-carrier FBW (a few %), which
# the Chu cap clears, not the whole-band 31.7% FBW.
LOW_BAND_TUNER = {
    "mpn_primary": "Qorvo QPC1252Q",
    "mpn_alternate": "pSemi PE613050",
    "control": "MIPI RFFE v2.1",
    "states": 12,
    # Tuner resonance center states (GHz) spanning 700-960 MHz. The state grid
    # step must be <= the Chu instantaneous match window at that center so there
    # is no coverage gap between adjacent states. The match window narrows toward
    # the low end (smaller ka => higher Q => tighter Chu BW ~25-30 MHz at 660 MHz),
    # so the grid is denser there. A 12-state tuner (e.g. cascaded QPC1252Q banks,
    # or a wider-state-count Qorvo/pSemi RFFE tuner) provides the needed centers.
    "center_states_GHz": [
        0.640, 0.665, 0.690, 0.715, 0.745, 0.780, 0.820, 0.860,
        0.895, 0.925, 0.945, 0.962,
    ],
    # Worst-case instantaneous single carrier the tuner state must match (20 MHz
    # LTE/NR low-band channel). This is the FBW the Chu cap must clear per state.
    "instantaneous_carrier_bw_mhz": 20.0,
    # Insertion loss the tuner adds in series with the element (RON/COFF),
    # de-rates radiation efficiency. Vendor-typical aperture-tuner IL.
    "insertion_loss_db": 0.5,
}

ANTENNA_BANDS = [
    # (label, f_lo_GHz, f_hi_GHz, keepout(l,w,h)mm, rad_eff_key, role)
    ("cellular_low_band", 0.700, 0.960, (62.0, 6.0, 2.0), "low_band", "cellular_main"),
    ("cellular_mid_high", 1.700, 2.700, (62.0, 6.0, 2.0), "mid_high", "cellular_main"),
    ("cellular_n78", 3.300, 3.800, (62.0, 6.0, 2.0), "n78", "cellular_main"),
    ("wifi_2g4", 2.400, 2.4835, (34.0, 5.0, 2.0), "wifi_2g4", "wifi_bt_chain"),
    ("wifi_5g", 5.150, 5.850, (34.0, 5.0, 2.0), "wifi_5g", "wifi_bt_chain"),
    ("wifi_6g", 5.925, 7.125, (34.0, 5.0, 2.0), "wifi_6g", "wifi_bt_chain"),
    ("gnss_l1", 1.559, 1.610, (34.0, 5.0, 2.0), "gnss_l1", "gnss_rx"),
]


def analyze_antenna() -> dict:
    bands = []
    for label, f_lo, f_hi, keepout, eff_key, role in ANTENNA_BANDS:
        f_lo_hz, f_hi_hz = f_lo * 1e9, f_hi * 1e9
        f_c_hz = np.sqrt(f_lo_hz * f_hi_hz)
        frac_bw_req = (f_hi_hz - f_lo_hz) / f_c_hz

        a = enclosing_sphere_radius_m(*keepout)  # Chu sphere radius
        k = 2.0 * np.pi * f_c_hz / C0
        ka = k * a

        q_min = mclean_min_q(ka)
        fbw_cap = chu_fractional_bandwidth(ka, vswr=2.0)  # max FBW at VSWR 2:1
        eta_match, gamma = bode_fano_max_efficiency(ka, max(frac_bw_req, 1e-6), vswr=2.0)

        rad_eff = TYPICAL_RAD_EFF[eff_key]
        total_eff = rad_eff * eta_match
        total_eff_db = lin_to_db(total_eff)

        # Verdict: keepout volume sufficient for a passable (>40 %, -4 dB) link.
        passable = total_eff_db >= PASS_FLOOR_DB
        # Flag whether the *fundamental* (Chu) limit even permits the band BW.
        bw_feasible = fbw_cap >= frac_bw_req
        verdict = "PASS" if (passable and bw_feasible) else "FAIL"

        note = ""
        tuner_block: dict | None = None
        if not bw_feasible:
            note = (
                "Chu/McLean limit: keepout electrical size cannot support the "
                "required fractional bandwidth at VSWR 2:1 -- needs a larger "
                "keepout volume or band-switching tuner."
            )
        elif not passable:
            note = (
                "Bode-Fano-bounded total efficiency below -4 dB floor; element "
                "is electrically small in this band -- bigger keepout / longer "
                "edge slot recommended."
            )

        # Cellular low band: resolve the Chu fractional-bandwidth shortfall with an
        # aperture/band-switch tuner. The tuner steps the element across discrete
        # states; each state only has to match its narrow segment, so the binding
        # requirement becomes the *worst segment's* instantaneous FBW, not the full
        # 700-960 MHz span. We re-evaluate each segment against the Chu cap at that
        # segment's own center, apply the Bode-Fano mismatch bound per segment, and
        # de-rate radiation efficiency by the tuner's series insertion loss.
        if label == "cellular_low_band" and not bw_feasible:
            tuner_il_lin = db_to_lin(-LOW_BAND_TUNER["insertion_loss_db"])
            carrier_bw_hz = LOW_BAND_TUNER["instantaneous_carrier_bw_mhz"] * 1e6
            centers = LOW_BAND_TUNER["center_states_GHz"]
            seg_rows = []
            all_seg_ok = True
            worst_seg_eff_db = 99.0
            worst_state_match_mhz = 1e9
            for c_ghz in centers:
                s_c_hz = c_ghz * 1e9
                # Instantaneous single-carrier FBW the state must match.
                seg_fbw_req = carrier_bw_hz / s_c_hz
                s_k = 2.0 * np.pi * s_c_hz / C0
                s_ka = s_k * a
                seg_fbw_cap = chu_fractional_bandwidth(s_ka, vswr=2.0)
                seg_feasible = seg_fbw_cap >= seg_fbw_req
                # Width (MHz) of the Chu VSWR-2:1 match window this state provides.
                state_match_mhz = seg_fbw_cap * s_c_hz / 1e6
                worst_state_match_mhz = min(worst_state_match_mhz, state_match_mhz)
                seg_eta, seg_gamma = bode_fano_max_efficiency(
                    s_ka, max(seg_fbw_req, 1e-6), vswr=2.0
                )
                seg_total = rad_eff * seg_eta * tuner_il_lin
                seg_total_db = lin_to_db(seg_total)
                seg_pass = seg_feasible and seg_total_db >= PASS_FLOOR_DB
                all_seg_ok = all_seg_ok and seg_pass
                worst_seg_eff_db = min(worst_seg_eff_db, seg_total_db)
                seg_rows.append({
                    "tuner_center_GHz": round(c_ghz, 4),
                    "instantaneous_carrier_bw_mhz": LOW_BAND_TUNER["instantaneous_carrier_bw_mhz"],
                    "seg_required_FBW_pct": round(float(seg_fbw_req) * 100.0, 2),
                    "seg_max_FBW_at_vswr2_pct": round(float(seg_fbw_cap) * 100.0, 2),
                    "state_match_window_mhz": round(float(state_match_mhz), 1),
                    "seg_bandwidth_feasible": bool(seg_feasible),
                    "seg_total_efficiency_db": round(float(seg_total_db), 2),
                    "seg_meets_vswr2_and_floor": bool(seg_pass),
                })
            # No-gap coverage: each adjacent center-to-center step must be <= the
            # narrower of the two states' match windows (windows grow with freq, so
            # the binding constraint is the lower state of each pair). Adjacent
            # half-windows then overlap and there is no hole in 700-960 MHz coverage.
            state_windows = [s["state_match_window_mhz"] for s in seg_rows]
            coverage_no_gap = True
            worst_gap_margin_mhz = 1e9
            for i in range(len(centers) - 1):
                step_mhz = (centers[i + 1] - centers[i]) * 1000.0
                pair_window = min(state_windows[i], state_windows[i + 1])
                worst_gap_margin_mhz = min(worst_gap_margin_mhz, pair_window - step_mhz)
                if step_mhz > pair_window:
                    coverage_no_gap = False
            max_step_mhz = max(
                (centers[i + 1] - centers[i]) * 1000.0 for i in range(len(centers) - 1)
            ) if len(centers) > 1 else 0.0
            all_seg_ok = all_seg_ok and coverage_no_gap
            tuner_block = {
                "part": LOW_BAND_TUNER["mpn_primary"],
                "alternate": LOW_BAND_TUNER["mpn_alternate"],
                "control": LOW_BAND_TUNER["control"],
                "states": LOW_BAND_TUNER["states"],
                "instantaneous_carrier_bw_mhz": LOW_BAND_TUNER["instantaneous_carrier_bw_mhz"],
                "tuner_insertion_loss_db": LOW_BAND_TUNER["insertion_loss_db"],
                "tuner_states": seg_rows,
                "max_center_step_mhz": round(max_step_mhz, 1),
                "narrowest_state_match_window_mhz": round(float(worst_state_match_mhz), 1),
                "worst_coverage_overlap_margin_mhz": round(float(worst_gap_margin_mhz), 1),
                "coverage_no_gap": bool(coverage_no_gap),
                "worst_state_total_eff_db": round(float(worst_seg_eff_db), 2),
                "all_states_meet_vswr2_and_floor": bool(all_seg_ok),
            }
            if all_seg_ok:
                verdict = "PASS_WITH_TUNER"
                total_eff_db = worst_seg_eff_db  # report worst switched state
                total_eff = db_to_lin(total_eff_db)
                bw_feasible = True  # feasible per switched carrier with the tuner
                note = (
                    f"Low-band covered by an {LOW_BAND_TUNER['states']}-state aperture "
                    f"band-switch tuner ({LOW_BAND_TUNER['mpn_primary']}, "
                    f"{LOW_BAND_TUNER['control']}). The full 31.7% span exceeds the "
                    f"{round(float(fbw_cap)*100,1)}% Chu instantaneous BW, but the radio "
                    f"matches only one {LOW_BAND_TUNER['instantaneous_carrier_bw_mhz']:.0f} MHz "
                    "carrier at a time; the modem programs the tuner state to center the "
                    "Chu match window on the active channel. Every state's instantaneous "
                    f"carrier FBW fits the Chu cap, the {round(max_step_mhz,0):.0f} MHz state grid "
                    f"step is within the {round(float(worst_state_match_mhz),0):.0f} MHz match "
                    "window (no coverage gap), and worst-state total efficiency is "
                    f"{round(float(worst_seg_eff_db),2)} dB after tuner insertion loss."
                )

        band_entry = {
            "band": label,
            "role": role,
            "freq_GHz": [round(f_lo, 4), round(f_hi, 4)],
            "f_center_GHz": round(f_c_hz / 1e9, 4),
            "keepout_mm": list(keepout),
            "keepout_volume_mm3": round(float(np.prod(keepout)), 1),
            "chu_sphere_radius_mm": round(a * 1e3, 3),
            "ka": round(float(ka), 4),
            "electrically_small_ka_lt_1": bool(ka < 1.0),
            "mclean_Q_min": round(float(q_min), 2),
            "max_FBW_at_vswr2_pct": round(float(fbw_cap) * 100.0, 2),
            "required_FBW_pct": round(float(frac_bw_req) * 100.0, 2),
            "bode_fano_match_eff": round(float(eta_match), 4),
            "bode_fano_avg_gamma": round(float(gamma), 4),
            "typical_radiation_eff": rad_eff,
            "total_efficiency": round(float(total_eff), 4),
            "total_efficiency_db": round(float(total_eff_db), 2),
            "pass_floor_db": PASS_FLOOR_DB,
            "bandwidth_feasible": bool(bw_feasible),
            "verdict": verdict,
            "note": note,
        }
        if tuner_block is not None:
            band_entry["aperture_tuner"] = tuner_block
        bands.append(band_entry)

    n_fail = sum(1 for b in bands if b["verdict"] == "FAIL")
    return {
        "method": "Chu/McLean min-Q + Bode-Fano matching bound x literature radiation efficiency",
        "vswr_assumed": 2.0,
        "pass_floor": "total efficiency >= -4 dB (~40 %)",
        "bands": bands,
        "fail_count": n_fail,
        "verdict": "PASS" if n_fail == 0 else "FAIL_WITH_FLAGS",
        "assumptions": [
            "Chu sphere = smallest sphere enclosing the keepout box (diagonal/2).",
            "Radiation efficiency values are cited literature typicals for tuned "
            "compact-handset elements, NOT measured for this enclosure.",
            "Mismatch efficiency capped by Bode-Fano single-resonance bound at "
            "the band's required fractional bandwidth, VSWR 2:1.",
            "Total efficiency = radiation_eff * mismatch_eff; enclosure-plastic "
            "(PC+ABS, er~3.0) and hand/head loading not de-rated here -- chamber "
            "measurement is the binding evidence.",
            "Cellular low band (700-960 MHz) is covered by a 4-state aperture "
            "band-switch tuner (Qorvo QPC1252Q, MIPI RFFE; alt pSemi PE613050). "
            "Each switched segment's required FBW is re-checked against the Chu "
            "cap at the segment center and the Bode-Fano mismatch bound, then "
            "de-rated by 0.5 dB tuner insertion loss. PASS_WITH_TUNER means every "
            "segment meets VSWR 2:1 and the -4 dB efficiency floor; the modem "
            "retunes the tuner state per active band.",
        ],
    }


# ===========================================================================
# B) SIGNAL INTEGRITY -- closed-form microstrip / edge-coupled diff line
# ===========================================================================
# 8-layer 0.8 mm HDI stackup. Outer microstrip dielectric ~ prepreg er 3.8.
# Geometry assumptions (typical for this class; final values need a board-house
# impedance coupon).
ER_PREPREG = 3.8         # FR-4-class prepreg, ~1-2 GHz
TAN_D = 0.018            # loss tangent FR-4 class
CU_T_UM = 18.0           # 1/2 oz finished outer copper (plated)
ROUGHNESS_RMS_UM = 0.4   # VLP/RTF foil


def microstrip_z0(w_um: float, h_um: float, er: float, t_um: float) -> tuple[float, float]:
    """Hammerstad-Jensen single-ended microstrip Z0 + effective er."""
    w = w_um * 1e-6
    h = h_um * 1e-6
    t = t_um * 1e-6
    # Thickness correction (Wheeler/Hammerstad)
    if t > 0:
        dw = (t / np.pi) * np.log(1.0 + 4.0 * np.e / (t / h) / ((1.0 / np.tanh(np.sqrt(6.517 * (w / h)))) ** 2))
        w_eff = w + dw
    else:
        w_eff = w
    u = w_eff / h
    # Effective permittivity (Hammerstad-Jensen)
    a = 1.0 + (1.0 / 49.0) * np.log((u**4 + (u / 52.0) ** 2) / (u**4 + 0.432)) \
        + (1.0 / 18.7) * np.log(1.0 + (u / 18.1) ** 3)
    b = 0.564 * ((er - 0.9) / (er + 3.0)) ** 0.053
    eeff = (er + 1.0) / 2.0 + (er - 1.0) / 2.0 * (1.0 + 10.0 / u) ** (-a * b)
    # Characteristic impedance (Hammerstad-Jensen)
    fu = 6.0 + (2.0 * np.pi - 6.0) * np.exp(-((30.666 / u) ** 0.7528))
    z01 = (ETA0 / (2.0 * np.pi)) * np.log(fu / u + np.sqrt(1.0 + (2.0 / u) ** 2))
    z0 = z01 / np.sqrt(eeff)
    return float(z0), float(eeff)


def diff_z0(w_um: float, h_um: float, s_um: float, er: float, t_um: float) -> tuple[float, float]:
    """Edge-coupled differential microstrip: Zdiff ~ 2*Z0*(1 - 0.48*exp(-0.96 s/h)).

    (Wadell / IPC-2141 closed form for edge-coupled microstrip coupling factor.)
    """
    z0, eeff = microstrip_z0(w_um, h_um, er, t_um)
    sh = s_um / h_um
    z_diff = 2.0 * z0 * (1.0 - 0.48 * np.exp(-0.96 * sh))
    return float(z_diff), float(eeff)


def conductor_loss_db_per_m(z0: float, f_hz: float, w_um: float, t_um: float) -> float:
    """First-order conductor (skin-effect) attenuation, dB/m, with roughness."""
    rs = np.sqrt(np.pi * f_hz * MU0 / SIGMA_CU)  # surface resistance ohm/sq
    delta = 1.0 / np.sqrt(np.pi * f_hz * MU0 * SIGMA_CU)
    # Hammerstad-Bracken roughness correction
    kr = 1.0 + (2.0 / np.pi) * np.arctan(1.4 * (ROUGHNESS_RMS_UM * 1e-6 / delta) ** 2)
    w = w_um * 1e-6
    r_per_m = rs * kr / w  # approx series R per unit length (one conductor)
    alpha_c = r_per_m / (2.0 * z0)  # Np/m
    return float(alpha_c * 8.686)


def dielectric_loss_db_per_m(f_hz: float, eeff: float, tan_d: float) -> float:
    lam0 = C0 / f_hz
    alpha_d = np.pi * np.sqrt(eeff) / lam0 * tan_d  # Np/m
    return float(alpha_d * 8.686)


def analyze_signal_integrity() -> dict:
    lines = []

    # ---- MIPI D-PHY (DSI display 4-lane, CSI camera 4/2-lane), 100 ohm diff ----
    # Geometry: 0.075 mm trace / 0.075 mm space over ~0.075 mm prepreg to In1_GND.
    for name, target_z, tol_pct, rate_gbps, length_mm, w_um, s_um, h_um in [
        ("MIPI_DSI_display_4lane", 100.0, 10.0, 1.5, 45.0, 75.0, 75.0, 75.0),
        ("MIPI_CSI_rear_cam_4lane", 100.0, 10.0, 1.5, 55.0, 75.0, 75.0, 75.0),
        ("MIPI_CSI_front_cam_2lane", 100.0, 10.0, 1.5, 65.0, 75.0, 75.0, 75.0),
    ]:
        z_diff, eeff = diff_z0(w_um, h_um, s_um, ER_PREPREG, CU_T_UM)
        z0_se, _ = microstrip_z0(w_um, h_um, ER_PREPREG, CU_T_UM)
        # D-PHY HS clock for 1.5 Gbps DDR -> 750 MHz fundamental; loss at fundamental.
        f_hz = rate_gbps * 1e9 / 2.0
        a_c = conductor_loss_db_per_m(z0_se, f_hz, w_um, CU_T_UM)
        a_d = dielectric_loss_db_per_m(f_hz, eeff, TAN_D)
        il_db = (a_c + a_d) * (length_mm * 1e-3)
        z_err = abs(z_diff - target_z) / target_z * 100.0
        # D-PHY HS channel budget: <= ~ 2 dB IL at the fundamental over short flex.
        il_budget = 2.0
        verdict = "PASS" if (z_err <= tol_pct and il_db <= il_budget) else "FAIL"
        lines.append({
            "net": name, "type": "mipi_dphy_diff", "spec": "MIPI D-PHY 80-125 ohm, 100 nominal",
            "rate_gbps_per_lane": rate_gbps, "length_mm": length_mm,
            "geometry_um": {"w": w_um, "s": s_um, "h": h_um, "t": CU_T_UM},
            "z_diff_ohm": round(z_diff, 1), "target_ohm": target_z, "tol_pct": tol_pct,
            "z_error_pct": round(z_err, 2), "eeff": round(eeff, 3),
            "f_eval_MHz": round(f_hz / 1e6, 1),
            "loss_db": round(il_db, 3), "loss_budget_db": il_budget,
            "verdict": verdict,
        })

    # ---- USB 2.0 HS, 90 ohm diff to USB-C ----
    # Tight-coupled 0.127 mm trace / 0.120 mm space over 0.075 mm prepreg lands
    # ~94 ohm diff (within +/-15 %); a board-house coupon trims to 90 ohm.
    usb_w, usb_s, usb_h = 127.0, 120.0, 75.0
    z_diff, eeff = diff_z0(usb_w, usb_h, usb_s, ER_PREPREG, CU_T_UM)
    z0_se, _ = microstrip_z0(usb_w, usb_h, ER_PREPREG, CU_T_UM)
    f_hz = 480e6 / 2.0  # 240 MHz HS fundamental
    a_c = conductor_loss_db_per_m(z0_se, f_hz, usb_w, CU_T_UM)
    a_d = dielectric_loss_db_per_m(f_hz, eeff, TAN_D)
    length_mm = 90.0
    il_db = (a_c + a_d) * (length_mm * 1e-3)
    z_err = abs(z_diff - 90.0) / 90.0 * 100.0
    il_budget = 1.5
    verdict = "PASS" if (z_err <= 15.0 and il_db <= il_budget) else "FAIL"
    lines.append({
        "net": "USB2_HS_to_typeC", "type": "usb2_diff", "spec": "USB 2.0 90 ohm +/-15 %, 480 Mbps",
        "rate_gbps_per_lane": 0.48, "length_mm": length_mm,
        "geometry_um": {"w": usb_w, "s": usb_s, "h": usb_h, "t": CU_T_UM},
        "z_diff_ohm": round(z_diff, 1), "target_ohm": 90.0, "tol_pct": 15.0,
        "z_error_pct": round(z_err, 2), "eeff": round(eeff, 3),
        "f_eval_MHz": round(f_hz / 1e6, 1),
        "loss_db": round(il_db, 3), "loss_budget_db": il_budget, "verdict": verdict,
    })

    # ---- Cellular RF feed 50 ohm microstrip to antenna ----
    # 0.30 mm trace over 0.15 mm prepreg gives ~50 ohm on this stackup.
    rf = []
    for name, length_mm, f_ghz in [
        ("CELL_RF_MAIN_low", 18.0, 0.85),
        ("CELL_RF_MAIN_mid", 18.0, 2.2),
        ("CELL_RF_MAIN_n78", 18.0, 3.55),
    ]:
        z0_se, eeff = microstrip_z0(300.0, 150.0, ER_PREPREG, CU_T_UM)
        f_hz = f_ghz * 1e9
        a_c = conductor_loss_db_per_m(z0_se, f_hz, 300.0, CU_T_UM)
        a_d = dielectric_loss_db_per_m(f_hz, eeff, TAN_D)
        il_db = (a_c + a_d) * (length_mm * 1e-3)
        z_err = abs(z0_se - 50.0) / 50.0 * 100.0
        il_budget = 0.5  # feed-line loss directly subtracts from TRP/TIS
        verdict = "PASS" if (z_err <= 10.0 and il_db <= il_budget) else "FAIL"
        rf.append({
            "net": name, "type": "rf_single", "spec": "50 ohm +/-10 %",
            "f_GHz": f_ghz, "length_mm": length_mm,
            "geometry_um": {"w": 300.0, "h": 150.0, "t": CU_T_UM},
            "z0_ohm": round(z0_se, 1), "target_ohm": 50.0, "tol_pct": 10.0,
            "z_error_pct": round(z_err, 2), "eeff": round(eeff, 3),
            "loss_db": round(il_db, 3), "loss_budget_db": il_budget, "verdict": verdict,
        })
    lines.extend(rf)

    n_fail = sum(1 for ln in lines if ln["verdict"] == "FAIL")
    return {
        "method": "Hammerstad-Jensen Z0 + edge-coupled diff coupling (Wadell/IPC-2141), "
                  "skin-effect (with Hammerstad-Bracken roughness) + dielectric loss",
        "stackup": "8-layer 0.8 mm HDI, outer microstrip, prepreg er=3.8, tan_d=0.018, 18 um Cu",
        "lines": lines,
        "fail_count": n_fail,
        "verdict": "PASS" if n_fail == 0 else "FAIL_WITH_FLAGS",
        "assumptions": [
            "Trace/space/height are typical-class assumptions; the board-house "
            "impedance coupon is the binding evidence.",
            "Insertion loss evaluated at the bit-rate fundamental (NRZ/DDR half-rate).",
            "Diff impedance from single-ended Z0 via edge-coupled coupling factor.",
            "Note: routing-constraints.yaml sets MIPI to 100 ohm diff; the task "
            "brief said 90 ohm -- the 100 ohm spec file value is used.",
        ],
    }


# ===========================================================================
# C) POWER INTEGRITY -- IR drop, decoupling target Z, rail droop
# ===========================================================================
def copper_sheet_resistance(t_um: float) -> float:
    """Sheet resistance (ohm/sq) of a copper plane/trace of given thickness."""
    return 1.0 / (SIGMA_CU * t_um * 1e-6)


def analyze_power_integrity() -> dict:
    rails = []
    # (rail, V, peak_I_A, ripple_tol_pct, path: width_mm, len_mm, cu_t_um, plane?,
    #  decap_uF, decap_esr_mohm, fsw_kHz, droop_tol_pct)
    rail_defs = [
        # SoC core 0V8 transient 3 A: short, wide plane drop.
        ("VDD_CORE_0V8", 0.80, 3.0, 5.0, 6.0, 8.0, 35.0, True, 47.0, 5.0, 2000.0, 5.0),
        ("VDD_0V8_alt", 0.80, 1.5, 5.0, 5.0, 6.0, 35.0, True, 22.0, 5.0, 2000.0, 5.0),
        ("VDD_1V1", 1.10, 1.2, 5.0, 4.0, 8.0, 35.0, True, 22.0, 6.0, 2000.0, 5.0),
        ("VDD_1V8", 1.80, 0.8, 5.0, 3.0, 12.0, 35.0, True, 10.0, 8.0, 1500.0, 5.0),
        ("VDD_3V3", 3.30, 1.0, 5.0, 2.0, 15.0, 35.0, True, 10.0, 10.0, 1500.0, 5.0),
        ("VSYS", 3.85, 3.5, 5.0, 4.0, 20.0, 70.0, True, 100.0, 5.0, 1000.0, 6.0),
        # Modem TX burst on RF_VBAT from VBAT, 2 A burst.
        ("RF_VBAT_modem", 3.85, 2.0, 6.0, 2.5, 35.0, 70.0, False, 47.0, 8.0, 1000.0, 8.0),
        ("VBAT_main", 3.85, 4.5, 6.0, 6.0, 25.0, 70.0, True, 220.0, 4.0, 1000.0, 6.0),
    ]
    for (name, v, i_pk, ripple_tol, w_mm, l_mm, t_um, is_plane,
         decap_uf, esr_mohm, fsw_khz, droop_tol) in rail_defs:
        rsheet = copper_sheet_resistance(t_um)
        squares = l_mm / w_mm
        r_path = rsheet * squares
        if is_plane:
            r_path *= 0.4  # plane spreads current; ~0.4x of a same-aspect trace
        v_ir = i_pk * r_path
        ir_pct = v_ir / v * 100.0
        # Target decoupling impedance to hold ripple under peak step:
        z_target = (v * ripple_tol / 100.0) / i_pk
        # Bulk-cap impedance floor at switching frequency (ESR-limited above f_esr).
        w_sw = 2.0 * np.pi * fsw_khz * 1e3
        z_cap = np.hypot(esr_mohm * 1e-3, 1.0 / (w_sw * decap_uf * 1e-6))
        # First-order droop from a load step held by the decoupling network:
        # transient charge over the cap before the regulator loop responds.
        # dV = I * t_resp / C, with t_resp ~ 1 / (2*pi*fsw) control bandwidth proxy.
        t_resp = 1.0 / (2.0 * np.pi * fsw_khz * 1e3)
        v_droop = i_pk * t_resp / (decap_uf * 1e-6) + i_pk * esr_mohm * 1e-3
        droop_pct = v_droop / v * 100.0

        ir_ok = ir_pct < 3.0
        z_ok = z_cap <= z_target
        droop_ok = droop_pct <= droop_tol
        verdict = "PASS" if (ir_ok and droop_ok) else "FAIL"
        rails.append({
            "rail": name, "voltage_v": v, "peak_current_a": i_pk,
            "path_mm": {"w": w_mm, "l": l_mm, "cu_um": t_um}, "is_plane": is_plane,
            "path_resistance_mohm": round(r_path * 1e3, 3),
            "ir_drop_mv": round(v_ir * 1e3, 2), "ir_drop_pct": round(ir_pct, 3),
            "ir_drop_pass_lt_3pct": bool(ir_ok),
            "decap_uF": decap_uf, "decap_esr_mohm": esr_mohm,
            "z_target_mohm": round(z_target * 1e3, 2), "z_cap_mohm": round(z_cap * 1e3, 2),
            "z_target_met": bool(z_ok),
            "droop_mv": round(v_droop * 1e3, 2), "droop_pct": round(droop_pct, 3),
            "droop_tol_pct": droop_tol, "droop_pass": bool(droop_ok),
            "verdict": verdict,
        })

    n_fail = sum(1 for r in rails if r["verdict"] == "FAIL")
    return {
        "method": "PCB copper sheet-resistance IR drop + decoupling target impedance "
                  "(Z=dV/dI) + first-order load-step droop (I*t_resp/C + I*ESR)",
        "rails": rails,
        "fail_count": n_fail,
        "verdict": "PASS" if n_fail == 0 else "FAIL_WITH_FLAGS",
        "assumptions": [
            "Copper sigma=5.8e7 S/m; plane spreading approximated as 0.4x a "
            "same-aspect trace; via stack resistance not included (adds margin "
            "for via-in-pad PMIC/SoC fanout).",
            "Peak currents are datasheet-class estimates (SoC core ~3 A transient, "
            "modem TX burst ~2 A); confirm against final SoC/modem datasheets.",
            "Droop is a first-order pre-regulator-response bound; PDN resonance and "
            "loop phase margin require a measured VNA PDN impedance sweep.",
        ],
    }


# ===========================================================================
# Report writers
# ===========================================================================
def write_md(result: dict, path: Path) -> None:
    a, si, pi = result["antenna"], result["signal_integrity"], result["power_integrity"]
    L = []
    L.append("# E1 phone RF / SI / PI analytical pre-scan\n")
    L.append(f"- evidence_class: `{result['evidence_class']}`")
    L.append(f"- generated: deterministic, reproducible (`{Path(__file__).name}`)")
    L.append(f"- device: {result['device']['envelope_mm']} mm, PC+ABS er~3.0 enclosure\n")
    L.append("This is an **analytical / closed-form pre-scan**, not a chamber, VNA, or "
             "scope measurement. Each result is bounded by a cited physical limit and "
             "checked against a target spec. A real anechoic chamber (antenna), VNA "
             "(impedance/loss), and oscilloscope/PDN-VNA (eye/droop) measurement remain "
             "the binding release evidence.\n")

    L.append("## A) Antenna -- Chu/McLean + Bode-Fano + literature efficiency\n")
    L.append("Formulas:")
    L.append("- Chu sphere radius `a` = (1/2)*diagonal of keepout box; `ka = 2*pi*f*a/c`.")
    L.append("- McLean min radiation Q: `Q_min = 1/(ka)^3 + 1/(ka)`.")
    L.append("- Max FBW at VSWR s: `FBW = (s-1)/(Q*sqrt(s))` (s=2).")
    L.append("- Bode-Fano single-resonance mismatch cap: `ln(1/|Gamma|) <= pi/(Q*FBW)`, "
             "`eta_match = 1-|Gamma|^2`.")
    L.append("- Total efficiency = radiation_eff (cited typical) x eta_match. Floor: -4 dB (~40 %).\n")
    L.append("| Band | f (GHz) | keepout (mm) | ka | Qmin | maxFBW% | reqFBW% | rad eff | total eff (dB) | Verdict |")
    L.append("|---|---|---|---|---|---|---|---|---|---|")
    for b in a["bands"]:
        L.append(f"| {b['band']} | {b['freq_GHz'][0]}-{b['freq_GHz'][1]} | "
                 f"{'x'.join(str(x) for x in b['keepout_mm'])} | {b['ka']} | {b['mclean_Q_min']} | "
                 f"{b['max_FBW_at_vswr2_pct']} | {b['required_FBW_pct']} | {b['typical_radiation_eff']} | "
                 f"{b['total_efficiency_db']} | {b['verdict']} |")
    L.append("")
    for b in a["bands"]:
        if b["note"]:
            L.append(f"- **{b['band']} {b['verdict']}**: {b['note']}")
        tuner = b.get("aperture_tuner")
        if tuner:
            L.append(f"\n  Aperture band-switch tuner `{tuner['part']}` "
                     f"(alt `{tuner['alternate']}`, {tuner['control']}, "
                     f"{tuner['states']} states, {tuner['tuner_insertion_loss_db']} dB IL, "
                     f"matching one {tuner['instantaneous_carrier_bw_mhz']:.0f} MHz carrier per state):")
            L.append("\n  | Tuner center (GHz) | reqFBW% (carrier) | maxFBW% (Chu) | match window (MHz) | feasible | state eff (dB) | VSWR2+floor |")
            L.append("  |---|---|---|---|---|---|---|")
            for s in tuner["tuner_states"]:
                L.append(f"  | {s['tuner_center_GHz']} | {s['seg_required_FBW_pct']} | "
                         f"{s['seg_max_FBW_at_vswr2_pct']} | {s['state_match_window_mhz']} | "
                         f"{'yes' if s['seg_bandwidth_feasible'] else 'NO'} | "
                         f"{s['seg_total_efficiency_db']} | "
                         f"{'PASS' if s['seg_meets_vswr2_and_floor'] else 'FAIL'} |")
            L.append(f"\n  No-gap coverage: max state step {tuner['max_center_step_mhz']} MHz "
                     f"<= narrowest match window {tuner['narrowest_state_match_window_mhz']} MHz "
                     f"-> **{tuner['coverage_no_gap']}**. All states meet VSWR 2:1 + floor: "
                     f"**{tuner['all_states_meet_vswr2_and_floor']}**; worst-state "
                     f"total efficiency {tuner['worst_state_total_eff_db']} dB.")
    L.append(f"\nAntenna verdict: **{a['verdict']}** ({a['fail_count']} FAIL).")
    L.append("Chamber confirms: total-efficiency / realized-gain / TRP / TIS sweep per band.\n")

    L.append("## B) Signal integrity -- closed-form transmission line\n")
    L.append("Formulas: Hammerstad-Jensen microstrip Z0 + eeff; edge-coupled diff "
             "`Zdiff = 2*Z0*(1-0.48*exp(-0.96*s/h))`; "
             "`alpha_c = Rs*Kr/(w*2*Z0)`, `alpha_d = pi*sqrt(eeff)/lambda0 * tan_d`.\n")
    L.append("| Net | Spec | len (mm) | Zdiff/Z0 (ohm) | target | err% | loss (dB) | budget | Verdict |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    for ln in si["lines"]:
        z = ln.get("z_diff_ohm", ln.get("z0_ohm"))
        L.append(f"| {ln['net']} | {ln['spec']} | {ln['length_mm']} | {z} | {ln['target_ohm']} | "
                 f"{ln['z_error_pct']} | {ln['loss_db']} | {ln['loss_budget_db']} | {ln['verdict']} |")
    L.append(f"\nSI verdict: **{si['verdict']}** ({si['fail_count']} FAIL).")
    L.append("VNA/scope confirms: TDR impedance profile, S21 insertion loss, D-PHY/USB2 eye mask.\n")

    L.append("## C) Power integrity -- IR drop, decoupling, droop\n")
    L.append("Formulas: `Rsheet = 1/(sigma*t)`, `R = Rsheet*(L/W)` (plane x0.4); "
             "`Vir = I*R`; target `Z = dV/I`; droop `dV = I*t_resp/C + I*ESR`.\n")
    L.append("| Rail | V | Ipk (A) | Rpath (mohm) | IR drop (mV / %) | droop (mV / %) | Verdict |")
    L.append("|---|---|---|---|---|---|---|")
    for r in pi["rails"]:
        L.append(f"| {r['rail']} | {r['voltage_v']} | {r['peak_current_a']} | "
                 f"{r['path_resistance_mohm']} | {r['ir_drop_mv']} / {r['ir_drop_pct']}% | "
                 f"{r['droop_mv']} / {r['droop_pct']}% | {r['verdict']} |")
    L.append(f"\nPI verdict: **{pi['verdict']}** ({pi['fail_count']} FAIL). Target: IR drop <3 %/rail.")
    L.append("PDN-VNA / scope confirms: measured PDN impedance vs frequency and load-step droop.\n")

    L.append("## Overall\n")
    L.append(f"- Antenna: **{a['verdict']}**")
    L.append(f"- Signal integrity: **{si['verdict']}**")
    L.append(f"- Power integrity: **{pi['verdict']}**")
    L.append(f"- Overall: **{result['overall_verdict']}**\n")
    L.append("### Assumptions (all areas)")
    for sec in (a, si, pi):
        for x in sec["assumptions"]:
            L.append(f"- {x}")
    path.write_text("\n".join(L) + "\n")


def main() -> int:
    antenna = analyze_antenna()
    si = analyze_signal_integrity()
    pi = analyze_power_integrity()

    any_fail = any(s["fail_count"] > 0 for s in (antenna, si, pi))
    result = {
        "schema": "eliza.e1_phone_rf_si_pi_simulation.v1",
        "evidence_class": EVIDENCE_CLASS,
        "claim_boundary": (
            "Closed-form / first-principles analytical pre-scan of antenna efficiency "
            "(Chu/McLean + Bode-Fano), transmission-line impedance & loss (Hammerstad-"
            "Jensen), and power-integrity IR drop / droop. Not a chamber, VNA, scope, or "
            "PDN-VNA measurement and cannot satisfy RF/SI/PI release gates."
        ),
        "device": {"envelope_mm": [78.0, 153.6, 12.7], "enclosure": "PC+ABS er~3.0, flush back"},
        "cited_limits": [
            "Chu 1948 / Harrington 1960 / McLean 1996 (min radiation Q)",
            "Bode 1945 / Fano 1950 (broadband matching bound)",
            "MIPI Alliance D-PHY (80-125 ohm diff, 100 nominal)",
            "USB-IF USB 2.0 rev 2.0 (90 ohm +/-15 %, 480 Mbps HS)",
        ],
        "antenna": antenna,
        "signal_integrity": si,
        "power_integrity": pi,
        "overall_verdict": "FAIL_WITH_FLAGS" if any_fail else "PASS",
        "residual_measurement": (
            "Anechoic-chamber total-efficiency/TRP/TIS per band, VNA S11/S21 + TDR on "
            "routed EVT0 board, oscilloscope D-PHY/USB2 eye, and PDN-VNA impedance + "
            "load-step droop remain the binding evidence."
        ),
    }

    json_path = REVIEW_DIR / "rf-si-pi-simulation.json"
    md_path = REVIEW_DIR / "rf-si-pi-simulation.md"
    json_path.write_text(json.dumps(result, indent=2) + "\n")
    write_md(result, md_path)

    print(f"antenna   : {antenna['verdict']} ({antenna['fail_count']} FAIL)")
    print(f"signal_int: {si['verdict']} ({si['fail_count']} FAIL)")
    print(f"power_int : {pi['verdict']} ({pi['fail_count']} FAIL)")
    print(f"overall   : {result['overall_verdict']}")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
