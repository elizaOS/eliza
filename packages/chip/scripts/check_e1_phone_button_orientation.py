#!/usr/bin/env python3
"""
E1 phone button + aperture orientation validation.

For each named feature, determine its exposed-face normal from the part's
bounding box position relative to the enclosure's bounding box. The exposed
face is whichever face of the part's AABB is closest to the corresponding
enclosure outer face, or whichever face protrudes furthest along the
expected axis.

Writes:
  review/button-orientation-validation.json
  review/button-orientation-validation.md
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.STEPControl import STEPControl_Reader

ROOT = Path("/home/shaw/milady/eliza/packages/chip")
OUT_DIR = ROOT / "mechanical/e1-phone/out"
REVIEW_DIR = ROOT / "mechanical/e1-phone/review"
DATE = "2026-05-20"
REVIEWER = "automated_orientation_check"

# Expected outward-normal direction for each feature.
EXPECTATIONS = [
    # buttons
    {"part": "power_button_cap", "expected_normal": "+X", "kind": "button"},
    {"part": "volume_button_cap", "expected_normal": "-X", "kind": "button"},
    # USB-C aperture: bottom face of phone (-Y)
    {"part": "usb_c_external_aperture", "expected_normal": "-Y", "kind": "aperture"},
    # Earpiece: front face (+Z) near top (+Y)
    {
        "part": "earpiece_receiver",
        "expected_normal": "+Z",
        "expected_side": "+Y",
        "kind": "earpiece",
    },
    {
        "part": "handset_acoustic_slot",
        "expected_normal": "+Z",
        "expected_side": "+Y",
        "kind": "earpiece_slot",
    },
    # Bottom mics: -Y face
    {"part": "bottom_microphone_port_1", "expected_normal": "-Y", "kind": "mic_port"},
    {"part": "bottom_microphone_port_2", "expected_normal": "-Y", "kind": "mic_port"},
    # Top mic: +Y face (uses the molded port, not the internal MEMS body)
    {"part": "top_microphone_port", "expected_normal": "+Y", "kind": "mic_port"},
    # Speaker grille opens at -Y face (uses one of the molded grille slots)
    {"part": "bottom_speaker_grille_slot_1", "expected_normal": "-Y", "kind": "speaker_grille"},
    {"part": "bottom_speaker_grille_slot_3", "expected_normal": "-Y", "kind": "speaker_grille"},
    # Rear camera: -Z face (back)
    {"part": "rear_camera_lens_window", "expected_normal": "-Z", "kind": "camera_lens"},
    {"part": "rear_camera_module", "expected_normal": "-Z", "kind": "camera_module"},
    # Rear torch / flash: window faces -Z (back)
    {"part": "rear_flash_led_window", "expected_normal": "-Z", "kind": "flash_window"},
    # Front camera: +Z face (front), top
    {
        "part": "front_camera_under_glass",
        "expected_normal": "+Z",
        "expected_side": "+Y",
        "kind": "front_camera",
    },
    {
        "part": "front_camera_module",
        "expected_normal": "+Z",
        "expected_side": "+Y",
        "kind": "front_camera_module",
    },
]

# Button cap <-> switch dome co-axiality (Z = button press axis is perpendicular
# to enclosure side wall: for ±X buttons, the centroid of the cap and the dome
# must be co-linear along Y and Z, with X along the press direction).
# Switch dome alignment uses the elastomer gasket as the actuator-path proxy
# (the tactile switch dome is co-axial with the gasket center by design).
SWITCH_AXES = [
    {"cap": "power_button_cap", "switch": "power_button_elastomer_gasket", "press_axis": "X"},
    {"cap": "volume_button_cap", "switch": "volume_button_elastomer_gasket", "press_axis": "X"},
]


def load_bbox_and_centroid(name: str) -> dict | None:
    step_file = OUT_DIR / f"{name}.step"
    if not step_file.exists():
        return None
    r = STEPControl_Reader()
    if r.ReadFile(str(step_file)) != 1:
        return None
    r.TransferRoots()
    shape = r.OneShape()
    if shape is None or shape.IsNull():
        return None
    b = Bnd_Box()
    BRepBndLib.Add_s(shape, b)
    if b.IsVoid():
        return None
    xmn, ymn, zmn, xmx, ymx, zmx = b.Get()
    # centroid by volume props (fall back to bbox center if volume is zero)
    props = GProp_GProps()
    try:
        BRepGProp.VolumeProperties_s(shape, props)
        m = props.Mass()
        if m > 1e-9:
            c = props.CentreOfMass()
            cx, cy, cz = c.X(), c.Y(), c.Z()
        else:
            cx, cy, cz = (xmn + xmx) / 2, (ymn + ymx) / 2, (zmn + zmx) / 2
    except Exception:
        cx, cy, cz = (xmn + xmx) / 2, (ymn + ymx) / 2, (zmn + zmx) / 2
    return {
        "name": name,
        "bbox": [xmn, ymn, zmn, xmx, ymx, zmx],
        "centroid": [cx, cy, cz],
        "extent": [xmx - xmn, ymx - ymn, zmx - zmn],
    }


def measured_outward_normal(box_part: list[float], box_enc: list[float]) -> str:
    """Determine which face of the enclosure is closest to the part."""
    pxmn, pymn, pzmn, pxmx, pymx, pzmx = box_part
    exmn, eymn, ezmn, exmx, eymx, ezmx = box_enc
    candidates = {
        "+X": exmx - pxmx,
        "-X": pxmn - exmn,
        "+Y": eymx - pymx,
        "-Y": pymn - eymn,
        "+Z": ezmx - pzmx,
        "-Z": pzmn - ezmn,
    }
    # smallest absolute remaining distance to enclosure outer face = outward normal
    return min(candidates, key=lambda k: abs(candidates[k]))


def side_of_phone(centroid_y: float, enc_box: list[float]) -> str:
    """+Y if part is in the top half, -Y if bottom half."""
    mid = (enc_box[1] + enc_box[4]) / 2
    return "+Y" if centroid_y >= mid else "-Y"


def axis_letter(s: str) -> str:
    return s[-1]


def main() -> int:
    enclosure_a = load_bbox_and_centroid("orange_side_frame")
    enclosure_b = load_bbox_and_centroid("orange_back_shell")
    if enclosure_a is None:
        print("orange_side_frame.step missing", file=sys.stderr)
        return 2
    # union bbox of the two enclosure halves
    ea = enclosure_a["bbox"]
    eb = enclosure_b["bbox"] if enclosure_b else ea
    enc_bbox = [
        min(ea[0], eb[0]),
        min(ea[1], eb[1]),
        min(ea[2], eb[2]),
        max(ea[3], eb[3]),
        max(ea[4], eb[4]),
        max(ea[5], eb[5]),
    ]

    results: list[dict] = []
    for exp in EXPECTATIONS:
        part = load_bbox_and_centroid(exp["part"])
        if part is None:
            results.append(
                {
                    "part": exp["part"],
                    "kind": exp["kind"],
                    "expected_normal": exp["expected_normal"],
                    "measured_normal": None,
                    "pass": False,
                    "note": "part STEP not found",
                }
            )
            continue
        measured = measured_outward_normal(part["bbox"], enc_bbox)
        ok = measured == exp["expected_normal"]
        # side-of-phone check (for earpiece / front camera)
        side_ok = True
        side_measured = side_of_phone(part["centroid"][1], enc_bbox)
        if "expected_side" in exp:
            side_ok = side_measured == exp["expected_side"]
        results.append(
            {
                "part": exp["part"],
                "kind": exp["kind"],
                "expected_normal": exp["expected_normal"],
                "measured_normal": measured,
                "expected_side": exp.get("expected_side"),
                "measured_side": side_measured,
                "centroid_mm": [round(c, 3) for c in part["centroid"]],
                "bbox_mm": [round(v, 3) for v in part["bbox"]],
                "pass": ok and side_ok,
            }
        )

    # Switch coaxiality
    switch_results: list[dict] = []
    for axdef in SWITCH_AXES:
        cap = load_bbox_and_centroid(axdef["cap"])
        sw = load_bbox_and_centroid(axdef["switch"])
        if cap is None or sw is None:
            switch_results.append(
                {
                    "cap": axdef["cap"],
                    "switch": axdef["switch"],
                    "press_axis": axdef["press_axis"],
                    "pass": False,
                    "note": "part missing",
                }
            )
            continue
        # for press_axis = X, the perpendicular axes Y and Z must align
        cx, cy, cz = cap["centroid"]
        sx, sy, sz = sw["centroid"]
        dy = abs(cy - sy)
        dz = abs(cz - sz)
        coax_tol_mm = 0.5
        ok = dy <= coax_tol_mm and dz <= coax_tol_mm
        switch_results.append(
            {
                "cap": axdef["cap"],
                "switch": axdef["switch"],
                "press_axis": axdef["press_axis"],
                "dy_mm": round(dy, 3),
                "dz_mm": round(dz, 3),
                "coax_tol_mm": coax_tol_mm,
                "pass": ok,
            }
        )

    overall_pass = all(r["pass"] for r in results) and all(r["pass"] for r in switch_results)

    out = {
        "schema": "eliza.e1_phone_button_orientation.v1",
        "evidence_class": "concept_envelope_bbox_orientation_result",
        "date": DATE,
        "reviewer": REVIEWER,
        "enclosure_bbox_mm": [round(v, 3) for v in enc_bbox],
        "feature_orientation": results,
        "switch_cap_coaxiality": switch_results,
        "overall_status": "pass" if overall_pass else "fail",
    }
    json_path = REVIEW_DIR / "button-orientation-validation.json"
    json_path.write_text(json.dumps(out, indent=2))
    print(f"wrote {json_path}", file=sys.stderr)

    md = [
        "# E1 Phone Button + Aperture Orientation Validation",
        "",
        f"Status: {'PASS' if overall_pass else 'FAIL'}.",
        f"Date: {DATE}. Reviewer: `{REVIEWER}`.",
        "",
        "## Feature outward normals",
        "",
        "| Part | Kind | Expected | Measured | Side expected | Side measured | Status |",
        "|------|------|----------|----------|---------------|---------------|--------|",
    ]
    for r in results:
        md.append(
            f"| `{r['part']}` | {r['kind']} | {r['expected_normal']} | "
            f"{r['measured_normal']} | "
            f"{r.get('expected_side', '-')} | {r.get('measured_side', '-')} | "
            f"{'PASS' if r['pass'] else 'FAIL'} |"
        )
    md += [
        "",
        "## Switch / cap coaxiality",
        "",
        "| Cap | Switch | Press axis | dy (mm) | dz (mm) | Tol (mm) | Status |",
        "|-----|--------|------------|---------|---------|----------|--------|",
    ]
    for r in switch_results:
        md.append(
            f"| `{r['cap']}` | `{r['switch']}` | {r['press_axis']} | "
            f"{r.get('dy_mm', '-')} | {r.get('dz_mm', '-')} | "
            f"{r.get('coax_tol_mm', '-')} | "
            f"{'PASS' if r['pass'] else 'FAIL'} |"
        )
    md += [""]
    md_path = REVIEW_DIR / "button-orientation-validation.md"
    md_path.write_text("\n".join(md))
    print(f"wrote {md_path}", file=sys.stderr)
    return 0 if overall_pass else 1


if __name__ == "__main__":
    sys.exit(main())
