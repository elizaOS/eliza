#!/usr/bin/env python3
"""Measure the internal unfilled (void) volume of the e1-phone enclosure.

Cavity = volume enclosed by the orange side-frame inner wall in XY, bounded in
Z by the back shell inner face (top of orange_back_shell) and the cover glass
inner face (bottom of screen_cover_glass). Filled = sum of solid component mesh
volumes that fall inside that cavity. Void = cavity - filled, broken down by
region so the empty space is localized.

Evidence class: cad_estimate_for_evt_planning, not_measured_hardware.
The numbers are derived from the generated CAD meshes + params, not hardware.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import trimesh
import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "mechanical/e1-phone/out"
REVIEW_DIR = ROOT / "mechanical/e1-phone/review"
PARAMS = ROOT / "mechanical/e1-phone/cad/e1_phone_params.yaml"
MANIFEST = OUT_DIR / "assembly-manifest.json"

MM3_PER_CM3 = 1000.0

# Parts that are enclosure walls / windows / external visual aids, not interior
# fill. They either form the cavity boundary or sit outside it.
NON_FILL_ROLES = {"molded enclosure", "tooling clearance"}
NON_FILL_NAMES = {
    "orange_back_shell",
    "orange_side_frame",
    "screen_cover_glass",
    "usb_c_external_aperture",
    "rear_camera_shell_aperture",
    "rear_camera_lens_window",
    "rear_flash_led_window",
    "front_camera_under_glass",
    "handset_acoustic_slot",
}


def rounded_rect_area_mm2(width: float, height: float, radius: float) -> float:
    """Area of a rounded rectangle: full rect minus four corner squares plus
    the four quarter-circles that round those corners."""
    radius = max(0.0, min(radius, min(width, height) / 2.0))
    return width * height - (4.0 - np.pi) * radius * radius


def load_params() -> dict[str, Any]:
    return yaml.safe_load(PARAMS.read_text())


def load_manifest() -> list[dict[str, Any]]:
    return json.loads(MANIFEST.read_text())


def mesh_volume_cm3(stl_path: Path) -> float:
    mesh = trimesh.load(stl_path, force="mesh")
    assert isinstance(mesh, trimesh.Trimesh)
    vol = abs(float(mesh.volume))
    return vol / MM3_PER_CM3


def bounds_volume_cm3(bounds: list[list[float]]) -> float:
    lo, hi = np.array(bounds[0]), np.array(bounds[1])
    return float(np.prod(hi - lo)) / MM3_PER_CM3


def main() -> None:
    params = load_params()
    manifest = load_manifest()
    dev = params["device"]
    width, height, depth = (float(v) for v in dev["envelope_mm"])
    wall = float(dev["wall_thickness_mm"])
    corner_radius = float(dev["corner_radius_mm"])

    # Cavity Z bounds: top of back shell (inner back face) to bottom of cover glass.
    by_name = {p["name"]: p for p in manifest}
    back_inner_z = by_name["orange_back_shell"]["bounds_mm"][1][2]
    cover_inner_z = by_name["screen_cover_glass"]["bounds_mm"][0][2]

    inner_w = width - 2.0 * wall
    inner_h = height - 2.0 * wall
    inner_r = max(corner_radius - wall, 0.1)
    slab_area_mm2 = rounded_rect_area_mm2(inner_w, inner_h, inner_r)
    cavity_cm3 = slab_area_mm2 * (cover_inner_z - back_inner_z) / MM3_PER_CM3

    # Sum filled solid volumes (interior components only).
    filled_cm3 = 0.0
    fill_parts: list[dict[str, Any]] = []
    for part in manifest:
        name = part["name"]
        role = part.get("role", "")
        if name in NON_FILL_NAMES or role in NON_FILL_ROLES:
            continue
        stl = ROOT / part["stl"]
        vol = mesh_volume_cm3(stl) if stl.exists() else bounds_volume_cm3(part["bounds_mm"])
        # Clip volume contribution to the part of the mesh inside the cavity Z band.
        lo_z, hi_z = part["bounds_mm"][0][2], part["bounds_mm"][1][2]
        if hi_z <= back_inner_z or lo_z >= cover_inner_z:
            continue
        filled_cm3 += vol
        fill_parts.append(
            {
                "name": name,
                "role": role,
                "volume_cm3": round(vol, 4),
                "z": [round(lo_z, 3), round(hi_z, 3)],
            }
        )

    void_cm3 = cavity_cm3 - filled_cm3
    void_pct = 100.0 * void_cm3 / cavity_cm3 if cavity_cm3 else 0.0

    # Regional breakdown by Z band + named voids.
    cover_z = cover_inner_z  # +5.65
    lcm_top = by_name["display_lcm"]["bounds_mm"][1][2]  # display module top
    pcb_bottom = by_name["main_pcb"]["bounds_mm"][0][2]

    def slab_void_cm3(z_lo: float, z_hi: float) -> float:
        """Empty volume in a Z slab = slab cavity volume minus filled parts in it."""
        slab_cav = slab_area_mm2 * (z_hi - z_lo) / MM3_PER_CM3
        occupied = 0.0
        for part in manifest:
            name = part["name"]
            role = part.get("role", "")
            if name in NON_FILL_NAMES or role in NON_FILL_ROLES:
                continue
            b = part["bounds_mm"]
            plo, phi = b[0][2], b[1][2]
            overlap = max(0.0, min(phi, z_hi) - max(plo, z_lo))
            if overlap <= 0:
                continue
            stl = ROOT / part["stl"]
            full = mesh_volume_cm3(stl) if stl.exists() else bounds_volume_cm3(b)
            frac = overlap / (phi - plo) if phi > plo else 0.0
            occupied += full * frac
        return max(0.0, slab_cav - occupied)

    regions: dict[str, dict[str, Any]] = {
        "front_display_gap": {
            "z": [round(lcm_top, 3), round(cover_z, 3)],
            "void_cm3": round(slab_void_cm3(lcm_top, cover_z), 4),
            "note": "between display module top and cover-glass inner face",
        },
        "mid_pcb_band": {
            "z": [round(pcb_bottom, 3), round(lcm_top, 3)],
            "void_cm3": round(slab_void_cm3(pcb_bottom, lcm_top), 4),
            "note": "around-PCB / battery front margins",
        },
        "back_band": {
            "z": [round(back_inner_z, 3), round(pcb_bottom, 3)],
            "void_cm3": round(slab_void_cm3(back_inner_z, pcb_bottom), 4),
            "note": "battery swell void + camera/flash burial + bottom-edge margins",
        },
    }

    result = {
        "evidence_class": "cad_estimate_for_evt_planning, not_measured_hardware",
        "cavity": {
            "z_band_mm": [round(back_inner_z, 3), round(cover_inner_z, 3)],
            "inner_xy_mm": [round(inner_w, 3), round(inner_h, 3)],
            "inner_corner_radius_mm": round(inner_r, 3),
            "volume_cm3": round(cavity_cm3, 3),
        },
        "filled_volume_cm3": round(filled_cm3, 3),
        "void_volume_cm3": round(void_cm3, 3),
        "void_pct_of_cavity": round(void_pct, 2),
        "regions": regions,
        "fill_parts_count": len(fill_parts),
        "fill_parts": sorted(fill_parts, key=lambda p: -p["volume_cm3"])[:25],
    }

    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    (REVIEW_DIR / "void-volume.json").write_text(json.dumps(result, indent=2) + "\n")

    md = [
        "# e1-phone internal void volume",
        "",
        f"evidence_class: `{result['evidence_class']}`",
        "",
        f"- Cavity volume: **{cavity_cm3:.2f} cm3** "
        f"(Z {back_inner_z:.2f}..{cover_inner_z:.2f} mm, inner XY "
        f"{inner_w:.1f} x {inner_h:.1f} mm, r={inner_r:.2f})",
        f"- Filled (component solids): **{filled_cm3:.2f} cm3**",
        f"- Void: **{void_cm3:.2f} cm3** = **{void_pct:.1f}%** of cavity",
        "",
        "## Void by region",
        "",
        "| region | Z band (mm) | void cm3 | note |",
        "|---|---|---|---|",
    ]
    for rname, r in regions.items():
        md.append(f"| {rname} | {r['z'][0]}..{r['z'][1]} | {r['void_cm3']} | {r['note']} |")
    md += ["", "## Top filled parts", "", "| part | role | cm3 | Z (mm) |", "|---|---|---|---|"]
    for p in result["fill_parts"]:
        md.append(f"| {p['name']} | {p['role']} | {p['volume_cm3']} | {p['z'][0]}..{p['z'][1]} |")
    md.append("")
    (REVIEW_DIR / "void-volume.md").write_text("\n".join(md))

    print(
        f"cavity={cavity_cm3:.2f} cm3  filled={filled_cm3:.2f} cm3  "
        f"void={void_cm3:.2f} cm3 ({void_pct:.1f}%)"
    )
    for rname, r in regions.items():
        print(f"  {rname}: {r['void_cm3']} cm3  Z{r['z']}")


if __name__ == "__main__":
    main()
