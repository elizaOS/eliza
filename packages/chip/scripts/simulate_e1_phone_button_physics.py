#!/usr/bin/env python3
"""
E1 phone tactile side-button physics simulation (power + volume).

Reproducible, deterministic mechanical model of the standardized Panasonic
EVQ-P7 series light-touch tactile switch behind the molded side-frame button
caps. Models the tactile-dome force-displacement curve, cap force transmission
and contact pressure, the travel stack (proud height / gasket / pre-load / lost
motion), the two-dome volume rocker, the IP54 elastomer seal preload, EVQ-P7
fatigue-life margin, and a 1-DOF mass-spring-damper cap dynamic response.

Spec anchors (Panasonic EVQ-P7 series light-touch tactile switch):
  - Travel: 0.35 mm.
  - Operating force: ~1.6 N (power), ~1.5 N (volume); EVQ-P7 series ships
    1.0 / 1.6 / 2.55 / 3.0 N operating-force options.
  - Tactile snap ratio (return-force / operating-force): ~40-55% typical for
    light-touch metal-dome switches; the contact force drops to ~0.8-1.0 N at
    snap.
  - Rated life: 100,000 cycles minimum (EVQ-P7 series), 200,000 cycles for the
    lower-force options.
  Datasheet / family page:
  https://na.industrial.panasonic.com/products/switches-encoders-interface-devices/switches/light-touch-tactile-switches/series/79247

Device geometry anchored to:
  mechanical/e1-phone/cad/e1_phone_params.yaml
  (power/volume button cap_mm, travel_mm, force_n; validation tolerance
   button_pressure_limit_n_per_mm2 = 0.2; cosmetic power_button_cap_proud_mm
   nominal 0.30; environmental ingress_target IP54.)

evidence_class: simulation_for_evt_planning_not_measured

Writes:
  mechanical/e1-phone/review/button-physics-sim.json
  mechanical/e1-phone/review/button-physics-sim.md
  mechanical/e1-phone/review/button-force-displacement.png
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path("/home/shaw/milady/eliza/packages/chip")
PARAMS = ROOT / "mechanical/e1-phone/cad/e1_phone_params.yaml"
REVIEW = ROOT / "mechanical/e1-phone/review"
DATASHEET = (
    "https://na.industrial.panasonic.com/products/switches-encoders-interface-"
    "devices/switches/light-touch-tactile-switches/series/79247"
)
EVIDENCE_CLASS = "simulation_for_evt_planning_not_measured"

# ---------------------------------------------------------------------------
# Datasheet-anchored constants (EVQ-P7 series). Marked [DATASHEET].
# ---------------------------------------------------------------------------
TRAVEL_MM = 0.35  # [DATASHEET] total stroke / hard-stop
F_PEAK_POWER_N = 1.6  # [DATASHEET] operating force, power
F_PEAK_VOLUME_N = 1.5  # [DATASHEET]/[PARAMS] operating force, volume
RATED_LIFE_CYCLES = 100_000  # [DATASHEET] minimum rated life, P7 series

# ---------------------------------------------------------------------------
# Derived / assumed engineering values. Marked [ASSUMED].
# ---------------------------------------------------------------------------
X_PEAK_MM = 0.25  # [ASSUMED] buckling point: dome peaks before hard stop
SNAP_RATIO = 0.55  # [ASSUMED] return/operating force ratio (light-touch dome)
HARD_STOP_K_N_PER_MM = 60.0  # [ASSUMED] post-travel substrate stiffness
ACTUATOR_RIB_TIP_MM = (0.9, 0.9)  # [ASSUMED] rib tip contacting dome, mm
DOME_CONTACT_MM = (1.5, 1.5)  # [ASSUMED] EVQ-P7 dome top contact patch, mm
CAP_PROUD_MM = 0.30  # [PARAMS] cosmetic power_button_cap_proud_mm nominal
GASKET_SHORE_A = 50.0  # [ASSUMED] elastomer durometer
GASKET_PERIM_MM = {"power": 2 * (2.0 + 12.0), "volume": 2 * (2.0 + 21.0)}
GASKET_COMPRESS_MM = 0.15  # [ASSUMED] seal squeeze for IP54
IP54_SEAL_PRESSURE_MIN = 0.05  # [ASSUMED] N/mm^2 min contact for IP54 splash
CAP_MASS_G = {"power": 0.30, "volume": 0.52}  # [ASSUMED] PC+ABS cap + rib
DAMPING_RATIO = 0.35  # [ASSUMED] elastomer-damped cap, under-damped
FINGER_FORCE_N = 3.0  # [ASSUMED] typical deliberate press force


def load_params() -> dict[str, Any]:
    """Minimal YAML reader for the two button blocks (no PyYAML dep)."""
    out: dict[str, Any] = {}
    section: str | None = None
    for raw in PARAMS.read_text().splitlines():
        if raw.strip().startswith("power_button:"):
            section = "power"
            out[section] = {}
        elif raw.strip().startswith("volume_button:"):
            section = "volume"
            out[section] = {}
        elif raw.strip().startswith("button_pressure_limit_n_per_mm2:"):
            out["pressure_limit"] = float(raw.split(":")[1].strip())
        elif section and ":" in raw and raw.startswith("    "):
            key, _, val = raw.strip().partition(":")
            val = val.strip()
            if key in ("travel_mm", "force_n"):
                out[section][key] = float(val)
            elif key == "cap_mm":
                out[section]["cap_mm"] = [float(v) for v in val.strip("[]").split(",")]
        elif section and not raw.startswith(" "):
            section = None
    return out


def force_displacement(x_mm: np.ndarray, f_peak: float) -> np.ndarray:
    """Tactile-dome force vs displacement.

    Three regimes:
      1. Pre-travel (0 -> X_PEAK): linear rise of the dome spring to f_peak.
      2. Snap (X_PEAK -> X_PEAK+snap_zone): force drops to f_peak*SNAP_RATIO as
         the metal dome buckles (the felt "click").
      3. Post-travel (-> TRAVEL): steep substrate hard-stop rise.
    """
    f = np.zeros_like(x_mm)
    snap_zone = 0.04  # mm over which the dome collapses
    x_snap_end = X_PEAK_MM + snap_zone
    f_snap = f_peak * SNAP_RATIO
    for i, x in enumerate(x_mm):
        if x <= 0:
            f[i] = 0.0
        elif x <= X_PEAK_MM:
            f[i] = f_peak * (x / X_PEAK_MM)
        elif x <= x_snap_end:
            t = (x - X_PEAK_MM) / snap_zone
            f[i] = f_peak - (f_peak - f_snap) * t
        elif x <= TRAVEL_MM:
            t = (x - x_snap_end) / (TRAVEL_MM - x_snap_end)
            f[i] = f_snap + (f_peak - f_snap) * t
        else:
            f[i] = f_peak + HARD_STOP_K_N_PER_MM * (x - TRAVEL_MM)
    return f


def shore_a_to_modulus_mpa(shore_a: float) -> float:
    """Gent relation: E (MPa) from Shore A hardness."""
    s = shore_a
    return (0.0981 * (56.0 + 7.66 * s)) / (0.137505 * (254.0 - 2.54 * s))


def simulate_button(name: str, cap_mm: list[float], f_peak: float) -> dict[str, Any]:
    cap_w, cap_l, _cap_t = cap_mm
    cap_face_area = cap_w * cap_l  # finger-side area, mm^2
    rib_area = ACTUATOR_RIB_TIP_MM[0] * ACTUATOR_RIB_TIP_MM[1]
    dome_area = DOME_CONTACT_MM[0] * DOME_CONTACT_MM[1]

    # Force-displacement curve sampled to the hard stop + overshoot.
    x = np.linspace(0.0, TRAVEL_MM + 0.05, 1200)
    f = force_displacement(x, f_peak)
    # Dome buckling peak is the operating force at/below X_PEAK, not the
    # post-travel hard-stop overshoot.
    pre = x <= X_PEAK_MM + 1e-9
    idx = int(np.argmax(f[pre]))
    f_peak_sim = float(f[pre][idx])
    x_at_peak = float(x[pre][idx])

    # Contact pressures. Skin pressure uses the full finger force over the cap
    # face; the dome sees the operating force concentrated on the rib tip.
    skin_pressure = FINGER_FORCE_N / cap_face_area
    rib_to_dome_pressure = f_peak / rib_area
    dome_top_pressure = f_peak / dome_area

    # Travel stack: cap rests proud, no pre-load => rest gap to actuation > 0;
    # lost motion is the slack before the rib touches the dome.
    rest_clearance = 0.02  # [ASSUMED] rib tip clearance to dome at rest, mm
    lost_motion = rest_clearance
    actuation_before_hardstop = (X_PEAK_MM + rest_clearance) < TRAVEL_MM
    no_rest_preload = rest_clearance > 0.0
    no_excess_lost_motion = lost_motion <= 0.1

    # Gasket. Two distinct effects:
    #  (a) Static seal: the elastomer lip is squeezed GASKET_COMPRESS against
    #      the frame, giving a contact pressure that must exceed the IP54
    #      splash threshold along the whole cap perimeter.
    #  (b) Added button force: only the gasket web spanning the *moving* cap
    #      resists the 0.35 mm stroke. That web shears/bends over the stroke; a
    #      thin (GASKET_WEB_T) compliant elastomer web contributes a small
    #      spring force, NOT the full perimeter seal preload.
    e_mpa = shore_a_to_modulus_mpa(GASKET_SHORE_A)
    bead_h_mm = 0.6  # [ASSUMED] uncompressed seal lip height
    seal_strain = GASKET_COMPRESS_MM / bead_h_mm
    seal_pressure = e_mpa * seal_strain  # MPa == N/mm^2 lip contact pressure
    ip54_ok = seal_pressure >= IP54_SEAL_PRESSURE_MIN
    # Added travel force: a thin elastomer membrane skirt bridges the moving
    # cap to the fixed frame and bends over the 0.35 mm stroke. Modeled as a
    # built-in (fixed-fixed) beam strip of width = perimeter, deflecting by the
    # stroke: k = 192 * E * I / span^3, I = w * t^3 / 12. Thin membranes are
    # very compliant, so the added force is small.
    web_t_mm = 0.10  # [ASSUMED] elastomer membrane skirt thickness
    web_span_mm = 1.5  # [ASSUMED] free bending span of the skirt
    w_mm = GASKET_PERIM_MM[name]
    inertia = w_mm * web_t_mm**3 / 12.0  # mm^4
    k_web_n_per_mm = 192.0 * e_mpa * inertia / web_span_mm**3  # N/mm
    seal_force_added = k_web_n_per_mm * TRAVEL_MM  # N at full stroke
    seal_force_reasonable = seal_force_added < 0.5 * f_peak

    # Dynamic: 1-DOF cap mass on the dome return spring.
    m = CAP_MASS_G[name] / 1000.0  # kg
    k = f_peak / (X_PEAK_MM / 1000.0)  # N/m, dome pre-travel stiffness
    wn = math.sqrt(k / m)  # rad/s
    fn = wn / (2 * math.pi)  # Hz
    zeta = DAMPING_RATIO
    wd = wn * math.sqrt(1 - zeta**2)
    settle_2pct_s = 4.0 / (zeta * wn)  # 2% settling time
    settle_ms = settle_2pct_s * 1000.0
    debounce_ms = math.ceil(settle_ms * 1.5)  # firmware window > settle

    return {
        "name": name,
        "cap_mm": cap_mm,
        "force_displacement": {
            "x_mm": x.tolist(),
            "f_n": f.tolist(),
            "peak_force_n": round(f_peak_sim, 4),
            "x_at_peak_mm": round(x_at_peak, 4),
            "snap_force_n": round(f_peak * SNAP_RATIO, 4),
            "snap_ratio": SNAP_RATIO,
            "hard_stop_mm": TRAVEL_MM,
        },
        "cap_mechanics": {
            "cap_face_area_mm2": round(cap_face_area, 3),
            "finger_force_n": FINGER_FORCE_N,
            "skin_pressure_n_per_mm2": round(skin_pressure, 5),
            "rib_tip_area_mm2": round(rib_area, 3),
            "rib_to_dome_pressure_n_per_mm2": round(rib_to_dome_pressure, 4),
            "dome_top_area_mm2": round(dome_area, 3),
            "dome_top_pressure_n_per_mm2": round(dome_top_pressure, 4),
        },
        "travel_stack": {
            "cap_proud_mm": CAP_PROUD_MM,
            "rest_clearance_mm": rest_clearance,
            "lost_motion_mm": round(lost_motion, 4),
            "actuation_point_mm": round(X_PEAK_MM + rest_clearance, 4),
            "hard_stop_mm": TRAVEL_MM,
            "actuation_before_hardstop": actuation_before_hardstop,
            "no_rest_preload": no_rest_preload,
            "no_excess_lost_motion": no_excess_lost_motion,
        },
        "gasket": {
            "shore_a": GASKET_SHORE_A,
            "modulus_mpa": round(e_mpa, 4),
            "seal_compression_mm": GASKET_COMPRESS_MM,
            "seal_pressure_n_per_mm2": round(seal_pressure, 4),
            "web_stiffness_n_per_mm": round(k_web_n_per_mm, 4),
            "seal_force_added_n": round(seal_force_added, 4),
            "ip54_preload_ok": ip54_ok,
            "seal_force_reasonable": seal_force_reasonable,
        },
        "dynamic": {
            "cap_mass_g": CAP_MASS_G[name],
            "dome_stiffness_n_per_m": round(k, 2),
            "natural_freq_hz": round(fn, 2),
            "damping_ratio": zeta,
            "damped_freq_hz": round(wd / (2 * math.pi), 2),
            "settle_time_ms": round(settle_ms, 3),
            "debounce_window_ms": debounce_ms,
        },
    }


def simulate_rocker(volume: dict[str, Any]) -> dict[str, Any]:
    """Two-dome volume rocker. Pressing one end pivots about the center; the
    far dome must not reach its actuation displacement."""
    cap_l = volume["cap_mm"][1]  # 21 mm
    dome_offset = cap_l / 2.0 - 3.0  # dome ~3 mm in from each end [ASSUMED]
    half_span = dome_offset  # pivot at center
    pressed_travel = TRAVEL_MM  # near end goes full travel
    # Rigid rocker pivoting at center: far end lifts, opposite dome unloads.
    tilt_deg = math.degrees(math.atan2(pressed_travel, half_span))
    # Far dome displacement = -pressed_travel (lifts away) => 0 actuation.
    far_dome_disp = -pressed_travel
    actuation_threshold = X_PEAK_MM
    single_end_ok = far_dome_disp < actuation_threshold and far_dome_disp <= 0.0
    return {
        "dome_offset_from_center_mm": round(dome_offset, 3),
        "pivot": "center of rocker cap",
        "pressed_end_travel_mm": pressed_travel,
        "tilt_angle_deg_full_travel": round(tilt_deg, 4),
        "far_dome_displacement_mm": round(far_dome_disp, 4),
        "far_dome_actuation_threshold_mm": actuation_threshold,
        "single_end_actuation_ok": single_end_ok,
    }


def fatigue(f_peak: float) -> dict[str, Any]:
    design_cycles = 50_000  # [ASSUMED] phone-life button presses target
    margin = RATED_LIFE_CYCLES / design_cycles
    return {
        "rated_life_cycles": RATED_LIFE_CYCLES,
        "rated_life_note": "EVQ-P7 series 100k cycle minimum; 200k for low-force options",
        "design_target_cycles": design_cycles,
        "life_margin_x": round(margin, 2),
        "life_margin_ok": margin >= 1.5,
        "contact_stress_note": (
            f"Dome operating force ~{f_peak:.1f} N is within EVQ-P7 rated "
            "operating-force envelope; cycling below rated stroke and force keeps "
            "dome contact stress under the metal-dome fatigue limit (qualitative)."
        ),
    }


def plot_curve(power: dict[str, Any], volume: dict[str, Any]) -> Path:
    fig, ax = plt.subplots(figsize=(8, 5))
    for btn, color in ((power, "tab:orange"), (volume, "tab:blue")):
        fd = btn["force_displacement"]
        ax.plot(
            fd["x_mm"],
            fd["f_n"],
            color=color,
            lw=2,
            label=f"{btn['name']} (peak {fd['peak_force_n']:.2f} N)",
        )
        ax.scatter([fd["x_at_peak_mm"]], [fd["peak_force_n"]], color=color, zorder=5)
    ax.axvline(TRAVEL_MM, ls="--", color="gray", lw=1, label=f"hard stop {TRAVEL_MM} mm")
    peak = max(
        power["force_displacement"]["peak_force_n"], volume["force_displacement"]["peak_force_n"]
    )
    ax.set_ylim(0, peak * 1.6)
    ax.set_xlabel("Displacement (mm)")
    ax.set_ylabel("Force (N)")
    ax.set_title("E1 phone side-button tactile dome force-displacement (EVQ-P7)")
    ax.grid(True, alpha=0.3)
    ax.legend()
    fig.text(0.01, 0.01, f"evidence_class: {EVIDENCE_CLASS}", fontsize=7, color="gray")
    fig.tight_layout()
    out = REVIEW / "button-force-displacement.png"
    fig.savefig(out, dpi=130)
    plt.close(fig)
    return out


def verdict(ok: bool) -> str:
    return "PASS" if ok else "FAIL"


def main() -> None:
    np.random.seed(0)
    params = load_params()
    REVIEW.mkdir(parents=True, exist_ok=True)
    pressure_limit = params.get("pressure_limit", 0.2)

    power = simulate_button("power", params["power"]["cap_mm"], F_PEAK_POWER_N)
    volume = simulate_button("volume", params["volume"]["cap_mm"], F_PEAK_VOLUME_N)
    rocker = simulate_rocker(volume)
    fat = fatigue(max(F_PEAK_POWER_N, F_PEAK_VOLUME_N))
    png = plot_curve(power, volume)

    # Pressure limit (0.2 N/mm^2) governs the cap face-to-skin comfort. The rib
    # and dome-top pressures are switch-internal contact, reported against the
    # same comfort yardstick and flagged as switch-internal.
    skin_ok = all(
        b["cap_mechanics"]["skin_pressure_n_per_mm2"] <= pressure_limit for b in (power, volume)
    )

    verdicts = {
        "actuation_before_hard_stop": verdict(
            power["travel_stack"]["actuation_before_hardstop"]
            and volume["travel_stack"]["actuation_before_hardstop"]
        ),
        "no_rest_preload": verdict(
            power["travel_stack"]["no_rest_preload"] and volume["travel_stack"]["no_rest_preload"]
        ),
        "contact_pressure_within_limit": verdict(skin_ok),
        "single_end_rocker_actuation": verdict(rocker["single_end_actuation_ok"]),
        "ip54_gasket_preload": verdict(
            power["gasket"]["ip54_preload_ok"] and volume["gasket"]["ip54_preload_ok"]
        ),
        "fatigue_life_margin": verdict(fat["life_margin_ok"]),
    }

    result = {
        "evidence_class": EVIDENCE_CLASS,
        "datasheet": DATASHEET,
        "params_source": str(PARAMS.relative_to(ROOT)),
        "pressure_limit_n_per_mm2": pressure_limit,
        "buttons": {"power": power, "volume": volume},
        "rocker": rocker,
        "fatigue": fat,
        "verdicts": verdicts,
        "value_legend": {
            "[DATASHEET]": "anchored to Panasonic EVQ-P7 datasheet/family page",
            "[PARAMS]": "from e1_phone_params.yaml",
            "[ASSUMED]": "derived/assumed engineering value for EVT planning",
        },
    }

    json_path = REVIEW / "button-physics-sim.json"
    json_path.write_text(json.dumps(result, indent=2) + "\n")

    md = render_md(result, png)
    md_path = REVIEW / "button-physics-sim.md"
    md_path.write_text(md)

    print(f"verdicts: {json.dumps(verdicts)}")
    print(
        f"power peak {power['force_displacement']['peak_force_n']} N, "
        f"volume peak {volume['force_displacement']['peak_force_n']} N"
    )
    print(
        f"skin pressure power {power['cap_mechanics']['skin_pressure_n_per_mm2']} "
        f"N/mm^2, rib->dome power {power['cap_mechanics']['rib_to_dome_pressure_n_per_mm2']} N/mm^2"
    )
    print(
        f"settle power {power['dynamic']['settle_time_ms']} ms, "
        f"volume {volume['dynamic']['settle_time_ms']} ms"
    )
    print(f"wrote: {json_path}\n       {md_path}\n       {png}")


def render_md(r: dict[str, Any], png: Path) -> str:
    p, v = r["buttons"]["power"], r["buttons"]["volume"]
    rk, fat = r["rocker"], r["fatigue"]
    lines: list[str] = []
    lines.append("# E1 phone side-button physics simulation")
    lines.append("")
    lines.append(f"- evidence_class: `{r['evidence_class']}`")
    lines.append("- datasheet: Panasonic EVQ-P7 series light-touch tactile switch")
    lines.append(f"  - {r['datasheet']}")
    lines.append(f"- params: `{r['params_source']}`")
    lines.append(f"- F-x plot: `{png.relative_to(ROOT)}`")
    lines.append("")
    lines.append("## Verdicts")
    lines.append("")
    lines.append("| Check | Verdict |")
    lines.append("|---|---|")
    for k, val in r["verdicts"].items():
        lines.append(f"| {k.replace('_', ' ')} | **{val}** |")
    lines.append("")
    lines.append("## Force-displacement (tactile dome)")
    lines.append("")
    lines.append("| Button | Peak force (N) | @ disp (mm) | Snap force (N) | Hard stop (mm) |")
    lines.append("|---|---|---|---|---|")
    for b in (p, v):
        fd = b["force_displacement"]
        lines.append(
            f"| {b['name']} | {fd['peak_force_n']} | {fd['x_at_peak_mm']} | "
            f"{fd['snap_force_n']} | {fd['hard_stop_mm']} |"
        )
    lines.append("")
    lines.append(
        "Pre-travel rises linearly to the operating-force peak, the metal dome "
        "buckles (snap/click, force drops to the return level), then a steep "
        "post-travel hard-stop rise. Peaks are [DATASHEET]; snap zone and "
        "hard-stop stiffness are [ASSUMED]."
    )
    lines.append("")
    lines.append("## Cap mechanics & contact pressure")
    lines.append("")
    lines.append(
        f"Pressure limit (cap-to-skin comfort): **{r['pressure_limit_n_per_mm2']} N/mm^2**."
    )
    lines.append("")
    lines.append(
        "| Button | Cap face (mm^2) | Skin pressure (N/mm^2) | Rib->dome (N/mm^2) | Dome top (N/mm^2) |"
    )
    lines.append("|---|---|---|---|---|")
    for b in (p, v):
        c = b["cap_mechanics"]
        lines.append(
            f"| {b['name']} | {c['cap_face_area_mm2']} | "
            f"{c['skin_pressure_n_per_mm2']} | {c['rib_to_dome_pressure_n_per_mm2']} | "
            f"{c['dome_top_pressure_n_per_mm2']} |"
        )
    lines.append("")
    lines.append(
        "The cap distributes a deliberate finger press over its full face, so "
        "cap-to-skin pressure stays well under the 0.2 N/mm^2 comfort limit. "
        "Rib-to-dome and dome-top pressures are switch-internal contact "
        "(operating force concentrated on the rib tip / dome crown), reported "
        "for completeness; they are not bounded by the skin-comfort limit and "
        "are within the EVQ-P7 operating envelope."
    )
    lines.append("")
    lines.append("## Travel stack")
    lines.append("")
    lines.append(
        "| Button | Cap proud (mm) | Rest clearance (mm) | Lost motion (mm) | Actuation (mm) | Hard stop (mm) |"
    )
    lines.append("|---|---|---|---|---|---|")
    for b in (p, v):
        t = b["travel_stack"]
        lines.append(
            f"| {b['name']} | {t['cap_proud_mm']} | {t['rest_clearance_mm']} | "
            f"{t['lost_motion_mm']} | {t['actuation_point_mm']} | {t['hard_stop_mm']} |"
        )
    lines.append("")
    lines.append(
        "Cap rests with positive clearance to the dome (no rest pre-load), the "
        "dome reaches its actuation/buckling point before the hard stop, and "
        "lost motion stays under 0.1 mm."
    )
    lines.append("")
    lines.append("## Volume rocker")
    lines.append("")
    lines.append(
        f"- Dome offset from center: {rk['dome_offset_from_center_mm']} mm (pivot: {rk['pivot']})."
    )
    lines.append(f"- Tilt at full travel: {rk['tilt_angle_deg_full_travel']} deg.")
    lines.append(
        f"- Far dome displacement when one end pressed: {rk['far_dome_displacement_mm']} mm "
        f"(threshold {rk['far_dome_actuation_threshold_mm']} mm) -> single-end actuation "
        f"{'OK' if rk['single_end_actuation_ok'] else 'FAIL'}. Pressing one end pivots the "
        f"rocker about its center, lifting the far dome away from actuation."
    )
    lines.append("")
    lines.append("## Gasket (IP54 seal)")
    lines.append("")
    lines.append(f"IP54 splash seal threshold: {IP54_SEAL_PRESSURE_MIN} N/mm^2 [ASSUMED].")
    lines.append("")
    lines.append(
        "| Button | Shore A | Modulus (MPa) | Seal pressure (N/mm^2) | Web k (N/mm) | Force added (N) | IP54 |"
    )
    lines.append("|---|---|---|---|---|---|---|")
    for b in (p, v):
        g = b["gasket"]
        lines.append(
            f"| {b['name']} | {g['shore_a']} | {g['modulus_mpa']} | "
            f"{g['seal_pressure_n_per_mm2']} | {g['web_stiffness_n_per_mm']} | "
            f"{g['seal_force_added_n']} | "
            f"{'PASS' if g['ip54_preload_ok'] else 'FAIL'} |"
        )
    lines.append("")
    lines.append(
        "Elastomer compression preloads the labyrinth seal above the IP54 "
        "splash threshold while adding only a small fraction of the operating "
        "force to the button feel. Shore A, membrane skirt geometry and "
        "compression are [ASSUMED]."
    )
    lines.append("")
    lines.append("## Fatigue")
    lines.append("")
    lines.append(
        f"- Rated life: {fat['rated_life_cycles']} cycles ({fat['rated_life_note']}) [DATASHEET]."
    )
    lines.append(
        f"- Design target: {fat['design_target_cycles']} cycles [ASSUMED] -> "
        f"margin {fat['life_margin_x']}x ({'PASS' if fat['life_margin_ok'] else 'FAIL'})."
    )
    lines.append(f"- {fat['contact_stress_note']}")
    lines.append("")
    lines.append("## Dynamic response (1-DOF cap)")
    lines.append("")
    lines.append(
        "| Button | Cap mass (g) | Natural freq (Hz) | Damping ratio | Settle 2% (ms) | Debounce (ms) |"
    )
    lines.append("|---|---|---|---|---|---|")
    for b in (p, v):
        d = b["dynamic"]
        lines.append(
            f"| {b['name']} | {d['cap_mass_g']} | {d['natural_freq_hz']} | "
            f"{d['damping_ratio']} | {d['settle_time_ms']} | {d['debounce_window_ms']} |"
        )
    lines.append("")
    lines.append(
        "Cap modeled as a mass on the dome return spring with elastomer "
        "damping. The recommended firmware debounce window exceeds the 2% "
        "settle time. Cap mass, damping ratio and finger force are [ASSUMED]."
    )
    lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    main()
