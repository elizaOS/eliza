#!/usr/bin/env python3
"""Regenerate the E1 phone retail spec sheet, refreshed mass budget, and
tolerance stack from the params YAML, assembly manifest, and prior STEP-derived
mass rollup. Deterministic; safe to re-run.

Evidence class: cad_estimate_for_evt_planning, not_measured_hardware.
"""
from __future__ import annotations

import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
MECH = ROOT / "mechanical" / "e1-phone"
CAD_PARAMS = MECH / "cad" / "e1_phone_params.yaml"
MANIFEST = MECH / "out" / "assembly-manifest.json"
REVIEW = MECH / "review"
PRIOR_MASS_BUDGET = REVIEW / "mass-budget.json"

EVIDENCE_CLASS = "cad_estimate_for_evt_planning, not_measured_hardware"

# Refined densities (g/cm^3) per AGENTS brief.
DENSITY = {
    "pc_abs": 1.13,
    "cover_glass": 2.50,
    "lipo_pouch": 2.40,
    "fr4_pcb": 1.90,
    "si_ic": 2.33,
    "ss_steel": 7.85,
    "brass": 8.50,
    "aluminum": 2.70,
    "ndfeb": 7.50,
    "copper": 8.96,
    "fpc_polyimide": 2.40,
    "adhesive_foam": 1.00,
    "silicone_gasket": 1.20,
    "tungsten": 19.30,
}

# Role -> refined density override (g/cm^3). None = use part's original.
ROLE_DENSITY = {
    "molded enclosure": DENSITY["pc_abs"],
    "screen retention": DENSITY["adhesive_foam"],
    "battery": DENSITY["lipo_pouch"],
    "PCB": DENSITY["fr4_pcb"],
    "EMI shield": DENSITY["ss_steel"],
    "I/O": DENSITY["ss_steel"],
    "I/O seal": DENSITY["silicone_gasket"],
    "button": DENSITY["pc_abs"],
    "button seal": DENSITY["silicone_gasket"],
    "camera seal": DENSITY["adhesive_foam"],
    "haptics": DENSITY["si_ic"],
    "split-board interconnect": DENSITY["fpc_polyimide"],
    "side-key interconnect": DENSITY["fpc_polyimide"],
    "connector": DENSITY["si_ic"],
}

# Hidden / off-STEP masses (g) — not represented in out/*.step but required
# for a defensible BOM rollup. Datasheet- or class-typical values.
HIDDEN_MASSES = [
    ("Quectel RG255C 5G RedCap modem LGA module", 5.2, "datasheet"),
    ("Murata Type 2EA Wi-Fi 6E + BT 5.3 module", 0.4, "datasheet"),
    ("nano-SIM tray + retention mechanism", 1.2, "class typical"),
    ("4x M1.4x3 stainless screws", 0.8, "0.2 g each"),
    ("4x brass heat-set inserts", 1.2, "0.3 g each"),
    ("2x cellular antenna FPCs", 1.0, "0.5 g each"),
    ("Wi-Fi/BT antenna FPC", 0.4, "class typical"),
    ("GPS antenna patch", 0.3, "class typical"),
    ("EMI cans extra (SoC/modem/PMIC fill)", 2.5, "beyond STEP shell"),
    ("Speaker neodymium magnet", 0.8, "1115 class"),
    ("LRA tungsten weight", 1.2, "0612 X-axis LRA"),
    ("Camera VCM coil + magnet", 0.6, "OV13855 AF"),
    ("Display backlight LED bar + diffuser", 3.0, "off-LCM STEP"),
    ("PCB copper/soldermask + thru-hole IC mass beyond outline", 4.0, "8-layer fill"),
    ("Battery PCM board + nickel tabs", 1.5, "pouch class"),
    ("Adhesives + foam + gaskets system total", 2.0, "assembly seal stack"),
]

TARGET_MASS_G = 185.0


def refresh_mass_budget() -> dict:
    prior = json.loads(PRIOR_MASS_BUDGET.read_text())
    refreshed_parts = []
    role_totals: dict[str, float] = {}
    rollup = 0.0
    for p in prior["parts"]:
        role = p["role"]
        vol_mm3 = float(p["volume_mm3"])
        if p["excluded_placeholder"]:
            rho = 0.0
            mass_g = 0.0
        else:
            rho = ROLE_DENSITY.get(role, float(p["density_g_per_cm3"]))
            # screen role: cover glass uses 2.50, LCM uses 1.20 (effective)
            if role == "screen":
                rho = DENSITY["cover_glass"] if "cover_glass" in p["name"] else 1.20
            # audio: speakers/mics ~2.2 effective, meshes 1.20
            if role == "audio":
                rho = float(p["density_g_per_cm3"])
            # camera (lens module bodies are mixed plastic/metal ~1.20-2.2)
            if role == "camera":
                rho = float(p["density_g_per_cm3"])
            mass_g = vol_mm3 * rho / 1000.0
        refreshed_parts.append({
            "name": p["name"],
            "role": role,
            "volume_mm3": round(vol_mm3, 3),
            "density_g_per_cm3": round(rho, 3),
            "mass_g": round(mass_g, 4),
            "excluded_placeholder": p["excluded_placeholder"],
        })
        role_totals[role] = role_totals.get(role, 0.0) + mass_g
        rollup += mass_g

    hidden = [
        {"item": name, "mass_g": round(m, 3), "source": src}
        for name, m, src in HIDDEN_MASSES
    ]
    hidden_total = sum(h["mass_g"] for h in hidden)
    total = rollup + hidden_total
    delta = total - TARGET_MASS_G

    return {
        "evidence_class": EVIDENCE_CLASS,
        "claim_boundary": (
            "Mass estimated from STEP volume x nominal density plus datasheet/"
            "class-typical masses for items absent from the STEP set. Not "
            "measured on hardware."
        ),
        "density_table_g_per_cm3": DENSITY,
        "step_rollup_mass_g": round(rollup, 3),
        "hidden_mass_total_g": round(hidden_total, 3),
        "total_estimated_mass_g": round(total, 3),
        "target_mass_g": TARGET_MASS_G,
        "delta_to_target_g": round(delta, 3),
        "mass_by_role_g": {k: round(v, 3) for k, v in sorted(role_totals.items())},
        "hidden_masses": hidden,
        "parts": refreshed_parts,
    }


def build_spec_sheet(params: dict, mass_total_g: float) -> dict:
    env = params["device"]["envelope_mm"]
    envelope_vol_cm3 = env[0] * env[1] * env[2] / 1000.0
    return {
        "evidence_class": EVIDENCE_CLASS,
        "source_params_yaml": str(CAD_PARAMS.relative_to(ROOT.parent)),
        "device": {
            "name": params["device"]["name"],
            "revision": params["device"]["revision"],
            "os": "AOSP / Android 14",
        },
        "mechanical": {
            "dimensions_mm": {"width": env[0], "height": env[1], "thickness": env[2]},
            "envelope_volume_cm3": round(envelope_vol_cm3, 2),
            "corner_radius_mm": params["device"]["corner_radius_mm"],
            "mass_g": round(mass_total_g, 1),
            "mass_target_g": TARGET_MASS_G,
            "color": params["device"]["plastic_color"],
            "material": "PC+ABS injection molded",
        },
        "display": {
            "size_in": 5.5,
            "resolution_px": [1080, 1920],
            "type": "IPS LCD",
            "interface": "MIPI DSI",
            "touch": "capacitive multi-touch",
            "cover_glass_mm": params["display"]["cover_glass_mm"],
            "active_area_mm": params["display"]["active_area_mm"],
        },
        "compute": {
            "soc_class": "Unisoc T606",
            "ram_gb": 4,
            "ram_type": "LPDDR4X",
            "storage_gb": 64,
            "storage_type": "eMMC 5.1",
        },
        "cellular": {
            "modem": "Quectel RG255C 5G RedCap LGA",
            "bands_typical": ["n1", "n3", "n5", "n8", "n28", "n40", "n41", "n77", "n78"],
            "note": "5G RedCap (NR-Light); LTE fallback per module datasheet",
        },
        "wireless": {
            "module": "Murata Type 2EA",
            "wifi": "Wi-Fi 6E (2.4/5/6 GHz)",
            "bluetooth": "Bluetooth 5.3",
        },
        "usb": {
            "connector": "USB Type-C (GCT USB4105)",
            "data": "USB 2.0",
            "power_delivery": "USB-PD 15 W wired",
            "video_out": False,
        },
        "battery": {
            "chemistry": "LiPo pouch",
            "capacity_mAh": 4500,
            "nominal_voltage_V": 3.85,
            "energy_Wh": 17.33,
            "wireless_charging": False,
        },
        "audio": {
            "bottom_speaker": "1115 micro speaker module",
            "earpiece": "1206 receiver behind cover glass",
            "microphones": "2x MEMS (bottom + top noise-cancel)",
            "haptic": "0612 X-axis LRA",
        },
        "camera": {
            "rear": "13 MP OmniVision OV13855 autofocus",
            "front": "5 MP GalaxyCore GC5035 fixed-focus",
        },
        "environmental": {
            "ip_rating_design_intent": "IP54 (dust-protected, splash-resistant)",
            "ip_rating_certified": False,
            "ip_rating_reasoning": (
                "USB-C perimeter gasket + drip-break lip + drain shelf, "
                "labyrinth-sealed side buttons with elastomer gaskets, "
                "perimeter cover-glass adhesive bond, port mesh on acoustic "
                "openings. Sufficient for IP54 design intent; IP67 not "
                "claimed (no pressure-tested chassis seal)."
            ),
            "drop_target_m": 1.0,
            "drop_target_faces": 6,
            "drop_certified": False,
        },
        "evidence_note": (
            "All values are CAD-derived for EVT planning. No measured hardware. "
            "Mass, IP rating, and drop figures are design targets and require "
            "EVT/DVT verification."
        ),
    }


def build_tolerance_stack() -> dict:
    """Worst-case + RSS tolerance stacks for 4 critical gaps."""
    stacks = []

    def stack(name, target_nom, target_tol, contributors):
        wc = sum(abs(c["tol_mm"]) for c in contributors)
        rss = (sum(c["tol_mm"] ** 2 for c in contributors)) ** 0.5
        wc_pass = wc <= target_tol
        rss_pass = rss <= target_tol
        stacks.append({
            "name": name,
            "target_nominal_mm": target_nom,
            "target_tolerance_mm": target_tol,
            "contributors": contributors,
            "worst_case_sum_mm": round(wc, 4),
            "rss_mm": round(rss, 4),
            "worst_case_pass": wc_pass,
            "rss_pass": rss_pass,
            "verdict": "PASS" if rss_pass else "FAIL",
        })

    # Common contributors
    plastic_shrink = {"source": "PC+ABS molding shrink ±0.15%", "tol_mm": 0.05}
    mold_tol = {"source": "steel mold cavity tolerance", "tol_mm": 0.05}
    adhesive = {"source": "PSA adhesive cure thickness", "tol_mm": 0.03}
    placement = {"source": "manual assembly placement", "tol_mm": 0.10}

    stack(
        "display_gap_to_bezel",
        0.15,
        0.10,
        [
            plastic_shrink,
            mold_tol,
            adhesive,
            {"source": "LCM cover glass datasheet ±0.05", "tol_mm": 0.05},
            placement,
        ],
    )
    stack(
        "power_button_cap_proud_above_bezel",
        0.30,
        0.05,
        [
            plastic_shrink,
            mold_tol,
            {"source": "tact switch travel datasheet ±0.05", "tol_mm": 0.05},
            placement,
        ],
    )
    stack(
        "usb_c_aperture_vs_receptacle_clearance",
        0.20,
        0.05,
        [
            plastic_shrink,
            mold_tol,
            {"source": "GCT USB4105 datasheet shell ±0.10", "tol_mm": 0.10},
            placement,
        ],
    )
    stack(
        "rear_camera_ring_vs_cover_glass",
        0.10,
        0.05,
        [
            plastic_shrink,
            mold_tol,
            adhesive,
            {"source": "cover glass cut tolerance ±0.05", "tol_mm": 0.05},
            placement,
        ],
    )

    return {
        "evidence_class": EVIDENCE_CLASS,
        "method": (
            "Worst-case sum (linear) and RSS (root-sum-square) of contributor "
            "tolerances. Verdict uses RSS vs target tolerance."
        ),
        "stacks": stacks,
    }


def md_mass_budget(mb: dict) -> str:
    lines = [
        "# E1 phone — refreshed mass budget (CAD estimate)",
        "",
        f"- Evidence class: `{mb['evidence_class']}`",
        f"- STEP rollup: **{mb['step_rollup_mass_g']:.2f} g**",
        f"- Hidden/off-STEP masses: **{mb['hidden_mass_total_g']:.2f} g**",
        f"- Total estimated mass: **{mb['total_estimated_mass_g']:.2f} g**",
        f"- Target: {mb['target_mass_g']:.1f} g",
        f"- Delta to target: **{mb['delta_to_target_g']:+.2f} g**",
        "",
        "## Mass by role",
        "",
        "| Role | Mass (g) |",
        "|---|---|",
    ]
    for role, m in mb["mass_by_role_g"].items():
        lines.append(f"| {role} | {m:.3f} |")
    lines += ["", "## Hidden / off-STEP masses", "",
              "| Item | Mass (g) | Source |", "|---|---|---|"]
    for h in mb["hidden_masses"]:
        lines.append(f"| {h['item']} | {h['mass_g']:.3f} | {h['source']} |")
    if mb["delta_to_target_g"] < 0:
        lines += ["",
                  f"Delta is **{mb['delta_to_target_g']:+.2f} g** (under target). "
                  "Likely missed mass: cover-glass ink layer + polarizer "
                  "(~1-2 g), bond-line adhesive coverage beyond perimeter "
                  "ribbon, conformal coating, and labeling. EVT mass "
                  "measurement will close the gap."]
    else:
        lines += ["",
                  f"Delta is **{mb['delta_to_target_g']:+.2f} g** (over target). "
                  "Optimization candidates: thin back-shell ribs, reduce EMI "
                  "can wall thickness from 0.20 mm to 0.15 mm, lighter LRA "
                  "counterweight."]
    return "\n".join(lines) + "\n"


def md_spec_sheet(s: dict) -> str:
    d = s["mechanical"]["dimensions_mm"]
    lines = [
        f"# {s['device']['name']} — retail spec sheet",
        "",
        f"- Evidence class: `{s['evidence_class']}`",
        f"- Source: `{s['source_params_yaml']}`",
        f"- Revision: {s['device']['revision']}",
        "",
        "## Mechanical",
        f"- Dimensions: {d['width']} x {d['height']} x {d['thickness']} mm",
        f"- Envelope volume: {s['mechanical']['envelope_volume_cm3']:.2f} cm^3",
        f"- Corner radius: {s['mechanical']['corner_radius_mm']} mm",
        f"- Mass: {s['mechanical']['mass_g']:.1f} g (target {s['mechanical']['mass_target_g']:.0f} g)",
        f"- Color / material: {s['mechanical']['color']} / {s['mechanical']['material']}",
        "",
        "## Display",
        f"- 5.5\" IPS LCD, 1080x1920 FHD, MIPI DSI, capacitive multi-touch",
        f"- Cover glass: {s['display']['cover_glass_mm']} mm",
        f"- Active area: {s['display']['active_area_mm']} mm",
        "",
        "## Compute",
        f"- SoC class: {s['compute']['soc_class']}",
        f"- RAM: {s['compute']['ram_gb']} GB {s['compute']['ram_type']}",
        f"- Storage: {s['compute']['storage_gb']} GB {s['compute']['storage_type']}",
        f"- OS: {s['device']['os']}",
        "",
        "## Cellular",
        f"- Modem: {s['cellular']['modem']}",
        f"- Bands (typical): {', '.join(s['cellular']['bands_typical'])}",
        f"- Note: {s['cellular']['note']}",
        "",
        "## Wireless",
        f"- Module: {s['wireless']['module']}",
        f"- Wi-Fi: {s['wireless']['wifi']}",
        f"- Bluetooth: {s['wireless']['bluetooth']}",
        "",
        "## USB",
        f"- {s['usb']['connector']}, {s['usb']['data']}, {s['usb']['power_delivery']}",
        f"- Video out: {s['usb']['video_out']}",
        "",
        "## Battery & charging",
        f"- {s['battery']['capacity_mAh']} mAh @ {s['battery']['nominal_voltage_V']} V "
        f"= {s['battery']['energy_Wh']} Wh ({s['battery']['chemistry']})",
        f"- Wireless charging: {s['battery']['wireless_charging']}",
        "",
        "## Audio",
        f"- Bottom speaker: {s['audio']['bottom_speaker']}",
        f"- Earpiece: {s['audio']['earpiece']}",
        f"- Microphones: {s['audio']['microphones']}",
        f"- Haptic: {s['audio']['haptic']}",
        "",
        "## Camera",
        f"- Rear: {s['camera']['rear']}",
        f"- Front: {s['camera']['front']}",
        "",
        "## Environmental",
        f"- IP rating (design intent): {s['environmental']['ip_rating_design_intent']}",
        f"- IP rating certified: {s['environmental']['ip_rating_certified']}",
        f"- Reasoning: {s['environmental']['ip_rating_reasoning']}",
        f"- Drop target: {s['environmental']['drop_target_m']} m on "
        f"{s['environmental']['drop_target_faces']} faces (design target, "
        "not certified)",
        "",
        f"_{s['evidence_note']}_",
    ]
    return "\n".join(lines) + "\n"


def md_tolerance_stack(t: dict) -> str:
    lines = [
        "# E1 phone — tolerance stack analysis",
        "",
        f"- Evidence class: `{t['evidence_class']}`",
        f"- Method: {t['method']}",
        "",
    ]
    for s in t["stacks"]:
        lines += [
            f"## {s['name']}",
            f"- Target: {s['target_nominal_mm']} ± {s['target_tolerance_mm']} mm",
            f"- Worst-case sum: {s['worst_case_sum_mm']} mm "
            f"({'PASS' if s['worst_case_pass'] else 'FAIL'})",
            f"- RSS: {s['rss_mm']} mm "
            f"({'PASS' if s['rss_pass'] else 'FAIL'})",
            f"- **Verdict: {s['verdict']}**",
            "",
            "| Contributor | ± Tol (mm) |",
            "|---|---|",
        ]
        for c in s["contributors"]:
            lines.append(f"| {c['source']} | {c['tol_mm']} |")
        lines.append("")
    return "\n".join(lines) + "\n"


def main() -> None:
    params = yaml.safe_load(CAD_PARAMS.read_text())

    mb = refresh_mass_budget()
    (REVIEW / "mass-budget.json").write_text(json.dumps(mb, indent=2) + "\n")
    (REVIEW / "mass-budget.md").write_text(md_mass_budget(mb))

    spec = build_spec_sheet(params, mb["total_estimated_mass_g"])
    (REVIEW / "e1-phone-spec-sheet.json").write_text(json.dumps(spec, indent=2) + "\n")
    (REVIEW / "e1-phone-spec-sheet.md").write_text(md_spec_sheet(spec))

    tol = build_tolerance_stack()
    (REVIEW / "tolerance-stack.json").write_text(json.dumps(tol, indent=2) + "\n")
    (REVIEW / "tolerance-stack.md").write_text(md_tolerance_stack(tol))

    print(f"Total mass: {mb['total_estimated_mass_g']:.2f} g "
          f"(delta {mb['delta_to_target_g']:+.2f} g vs {TARGET_MASS_G} g)")
    for s in tol["stacks"]:
        print(f"  {s['name']}: WC={s['worst_case_sum_mm']} RSS={s['rss_mm']} "
              f"-> {s['verdict']}")


if __name__ == "__main__":
    main()
