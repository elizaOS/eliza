#!/usr/bin/env python3
"""Regenerate the E1 phone retail spec sheet from the params YAML and the
CAD-generated mass budget. Deterministic; safe to re-run.

This script owns ONLY ``review/e1-phone-spec-sheet.{json,md}``. The mass budget
and tolerance stack are produced by ``generate_e1_phone_cad.py`` and are read
here, never rewritten, so the spec sheet always reflects the current CAD
geometry rather than a private, drifting copy.

Evidence class: cad_estimate_for_evt_planning, not_measured_hardware.
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
MECH = ROOT / "mechanical" / "e1-phone"
CAD_PARAMS = MECH / "cad" / "e1_phone_params.yaml"
REVIEW = MECH / "review"
MASS_BUDGET = REVIEW / "mass-budget.json"

EVIDENCE_CLASS = "cad_estimate_for_evt_planning, not_measured_hardware"

# Items required for a defensible shipping mass but absent from the CAD STEP
# geometry that the mass budget rolls up (modem/Wi-Fi LGA modules, antennas,
# fasteners, conformal coating, labeling, cabling, packaging-adjacent stack).
# Datasheet- or class-typical; held as a single reconciliation adder so the CAD
# geometry subtotal stays the single source of truth for measured volumes.
ASSEMBLY_STAGE_MASS_G = 8.4


def load_cad_geometry_mass_g() -> float:
    budget = json.loads(MASS_BUDGET.read_text())
    return float(budget["total_estimated_mass_g"])


def build_spec_sheet(params: dict) -> dict:
    dev = params["device"]
    env = dev["envelope_mm"]
    envelope_vol_cm3 = env[0] * env[1] * env[2] / 1000.0

    cad_geometry_g = load_cad_geometry_mass_g()
    reconciled_g = cad_geometry_g + ASSEMBLY_STAGE_MASS_G
    ship_target_g = float(dev["ship_target_mass_g"])
    ship_tol_g = 10.0
    concept_target_g = float(dev["target_mass_g"])
    max_mass_g = float(dev["max_mass_g"])
    ship_low_g = ship_target_g - ship_tol_g
    ship_high_g = ship_target_g + ship_tol_g
    within_ship_window = ship_low_g <= reconciled_g <= ship_high_g
    ship_target_pass = reconciled_g <= max_mass_g
    ship_target_verdict = "PASS" if ship_target_pass else "FAIL"

    bat = params["battery"]
    rear_cam = params["components"]["rear_camera"]
    front_cam = params["components"]["front_camera"]
    flash = params["components"]["rear_flash_led"]

    return {
        "evidence_class": EVIDENCE_CLASS,
        "source_params_yaml": str(CAD_PARAMS.relative_to(ROOT.parent)),
        "device": {
            "name": dev["name"],
            "revision": dev["revision"],
            "os": "AOSP / Android 14",
        },
        "mechanical": {
            "dimensions_mm": {
                "width": env[0],
                "height": env[1],
                "thickness": env[2],
            },
            "back_face": ("fully flush flat back, no camera bump, no protruding lens ring"),
            "envelope_volume_cm3": round(envelope_vol_cm3, 2),
            "corner_radius_mm": dev["corner_radius_mm"],
            "mass_g": round(reconciled_g, 2),
            "mass_cad_geometry_subtotal_g": round(cad_geometry_g, 2),
            "mass_missing_items_subtotal_g": ASSEMBLY_STAGE_MASS_G,
            "mass_ship_target_g": ship_target_g,
            "mass_ship_target_tolerance_g": ship_tol_g,
            "mass_ship_target_window_g": [ship_low_g, ship_high_g],
            "mass_max_g": max_mass_g,
            "mass_within_ship_target_window": within_ship_window,
            "mass_ship_target_verdict": ship_target_verdict,
            "mass_target_g": concept_target_g,
            "mass_target_note": (
                f"{concept_target_g:.0f} g aspirational concept target; "
                f"{ship_target_g:.0f} +/-{ship_tol_g:.0f} g EVT0 ship-target window "
                f"({ship_low_g:.0f}-{ship_high_g:.0f} g); {max_mass_g:.0f} g hard "
                f"maximum weight. Flush-back rev ({env[2]} mm, "
                f"{bat['capacity_mah']} mAh battery) reconciled CAD mass "
                f"{reconciled_g:.2f} g is {ship_target_verdict} against the "
                f"{max_mass_g:.0f} g maximum"
                + (
                    (
                        " and within the ship-target window."
                        if within_ship_window
                        else (
                            f"; it is above the ship-target window but under the "
                            f"hard maximum with {max_mass_g - reconciled_g:.2f} g "
                            "margin. The CAD mass is a nominal-density geometry "
                            "estimate, not measured hardware."
                        )
                    )
                    if ship_target_pass
                    else (
                        f" (over by {reconciled_g - max_mass_g:.2f} g). The CAD "
                        "mass is a nominal-density geometry estimate, not measured "
                        "hardware; the overage must be closed at EVT by measured "
                        "component mass and/or mass-reduction before the maximum "
                        "can be claimed."
                    )
                )
            ),
            "color": dev["plastic_color"],
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
            "soc_class": "Rockchip RK3566 (quad Cortex-A55, Mali-G52, 1 TOPS NPU)",
            "module": (
                "Firefly Core-3566JD4-class System-on-Module (PATH A, default) "
                "bundling SoC + LPDDR4 + eMMC + PMIC behind a public 260-pin "
                "SODIMM pinout"
            ),
            "ram_gb": 2,
            "ram_type": "LPDDR4",
            "storage_gb": 32,
            "storage_type": "eMMC 5.1",
            "cost_down_note": (
                "A bare-SoC path (bare Unisoc T606 / RK3566 + discrete "
                "LPDDR4/eMMC/PMIC, PATH B) is ~$4.55-7.10/unit cheaper but "
                "requires the SoC vendor NDA for the BGA ball-map."
            ),
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
            "candidate": bat["candidate"],
            "envelope_mm": bat["envelope_mm"],
            "capacity_mAh": bat["capacity_mah"],
            "nominal_voltage_V": bat["nominal_voltage_v"],
            "energy_Wh": bat["energy_wh"],
            "wireless_charging": False,
        },
        "audio": {
            "bottom_speaker": "1115 micro speaker module",
            "earpiece": "1206 receiver behind cover glass",
            "microphones": "2x MEMS (bottom + top noise-cancel)",
            "haptic": "0612 X-axis LRA",
        },
        "camera": {
            "rear": (
                f"13 MP OmniVision OV13855 autofocus, "
                f"{rear_cam['lens_count']} lens ({rear_cam['array']})"
            ),
            "rear_array": rear_cam["array"],
            "rear_flash": (
                "single rear torch/flash LED (Everlight/OSRAM-class "
                f"~{flash['envelope_mm'][0]}x{flash['envelope_mm'][1]} mm) behind "
                "a flush light-pipe window, AW36515-class flash driver"
            ),
            "front": (
                f"5 MP GalaxyCore GC5035 fixed-focus, "
                f"{front_cam['lens_count']} lens ({front_cam['array']})"
            ),
            "front_array": front_cam["array"],
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


def md_spec_sheet(s: dict) -> str:
    d = s["mechanical"]["dimensions_mm"]
    m = s["mechanical"]
    cg = s["display"]["cover_glass_mm"]
    aa = s["display"]["active_area_mm"]
    bat = s["battery"]
    lines = [
        f"# {s['device']['name']} — retail spec sheet",
        "",
        f"- Evidence class: `{s['evidence_class']}`",
        f"- Source: `{s['source_params_yaml']}`",
        f"- Revision: {s['device']['revision']}",
        "",
        "## Mechanical",
        f"- Dimensions: {d['width']} x {d['height']} x {d['thickness']} mm ({m['back_face']})",
        f"- Envelope volume: {m['envelope_volume_cm3']:.2f} cm^3",
        f"- Corner radius: {m['corner_radius_mm']} mm",
        f"- Mass: {m['mass_g']:.2f} g reconciled "
        f"({m['mass_cad_geometry_subtotal_g']:.2f} g CAD geometry + "
        f"{m['mass_missing_items_subtotal_g']:.1f} g assembly-stage items); "
        f"ship target {m['mass_ship_target_g']:.0f} "
        f"+/-{m['mass_ship_target_tolerance_g']:.0f} g "
        f"({m['mass_ship_target_verdict']}). {m['mass_target_note']} "
        f"Aspirational concept target {m['mass_target_g']:.0f} g retained for "
        "reference.",
        f"- Color / material: {m['color']} / {m['material']}",
        "",
        "## Display",
        '- 5.5" IPS LCD, 1080x1920 FHD, MIPI DSI, capacitive multi-touch',
        f"- Cover glass: {cg} mm",
        f"- Active area: {aa} mm",
        "",
        "## Compute",
        f"- SoC class: {s['compute']['soc_class']}",
        f"- Module: {s['compute']['module']}",
        f"- RAM: {s['compute']['ram_gb']} GB {s['compute']['ram_type']} (on-module)",
        f"- Storage: {s['compute']['storage_gb']} GB "
        f"{s['compute']['storage_type']} (on-module; 64/128 GB option)",
        f"- OS: {s['device']['os']}",
        f"- Cost-down note: {s['compute']['cost_down_note']}",
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
        f"- {bat['capacity_mAh']} mAh @ {bat['nominal_voltage_V']} V "
        f"= {bat['energy_Wh']} Wh ({bat['chemistry']}, {bat['candidate']})",
        f"- Wireless charging: {bat['wireless_charging']}",
        "",
        "## Audio",
        f"- Bottom speaker: {s['audio']['bottom_speaker']}",
        f"- Earpiece: {s['audio']['earpiece']}",
        f"- Microphones: {s['audio']['microphones']}",
        f"- Haptic: {s['audio']['haptic']}",
        "",
        "## Camera",
        f"- Rear: {s['camera']['rear']}",
        f"- Rear flash: {s['camera']['rear_flash']}",
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


def main() -> None:
    params = yaml.safe_load(CAD_PARAMS.read_text())

    spec = build_spec_sheet(params)
    (REVIEW / "e1-phone-spec-sheet.json").write_text(json.dumps(spec, indent=2) + "\n")
    (REVIEW / "e1-phone-spec-sheet.md").write_text(md_spec_sheet(spec))

    d = spec["mechanical"]["dimensions_mm"]
    bat = spec["battery"]
    print(
        f"Spec sheet: {d['width']} x {d['height']} x {d['thickness']} mm, "
        f"{spec['mechanical']['mass_g']:.2f} g reconciled "
        f"(CAD {spec['mechanical']['mass_cad_geometry_subtotal_g']:.2f} g + "
        f"{spec['mechanical']['mass_missing_items_subtotal_g']:.1f} g), "
        f"battery {bat['capacity_mAh']} mAh / {bat['energy_Wh']} Wh"
    )


if __name__ == "__main__":
    main()
