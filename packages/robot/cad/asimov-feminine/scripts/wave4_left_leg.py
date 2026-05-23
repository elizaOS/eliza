"""Wave 4 LEFT leg feminization — push toward minimum viable width.

Design intent: armored valkyrie leg armor aesthetic.
  - Thigh (HIP_YAW): slimmer cross-section + upper flare + quad armor bulge
  - Shin/Knee (KNEE): very slim shin, prominent knee-cap armor plate
  - Ankle (ANKLE_B): narrow and elegant
  - HIP_PITCH: overall -10% + mid-height cinch for waisted look
  - HIP_ROLL, ANKLE_A: functional joints, minimal -8%
  - TOE: narrower foot profile

All reads from originals/, all writes to output/modified/ (LEFT leg only).

Run with:
    uv run python cad/asimov-feminine/scripts/wave4_left_leg.py
"""
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from stl_utils import (
    read_stl, write_stl, recalc_normals, bbox,
    scale_mesh, scale_axis_range, add_bulge,
    thin_cross_section, cinch_waist,
)

ORIGINALS_DIR = SCRIPT_DIR.parent / "originals"
OUTPUT_DIR    = SCRIPT_DIR.parent / "output" / "modified"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def process(part_name: str, ops: list) -> dict:
    """Read originals/<part_name>, apply ops, write to output/modified/<part_name>."""
    src = str(ORIGINALS_DIR / part_name)
    dst = str(OUTPUT_DIR / part_name)

    normals, verts = read_stl(src)
    mn0, mx0 = bbox(verts)
    size0 = (mx0 - mn0) * 1000.0  # convert m -> mm

    for op in ops:
        name = op["op"]
        if name == "scale":
            verts = scale_mesh(verts, op["sx"], op["sy"], op.get("sz", 1.0))
        elif name == "thin_cross_section":
            verts = thin_cross_section(verts,
                axis_primary=op["axis_primary"],
                scale_x=op["scale_x"],
                scale_y=op["scale_y"])
        elif name == "cinch_waist":
            verts = cinch_waist(verts,
                axis_long=op["axis_long"],
                waist_frac=op["waist_frac"],
                cinch_scale=op["cinch_scale"],
                band_width=op["band_width"])
        elif name == "scale_axis_range":
            verts = scale_axis_range(verts,
                axis=op["axis"],
                scale=op["scale"],
                lo_frac=op["lo_frac"],
                hi_frac=op["hi_frac"])
        elif name == "add_bulge":
            verts = add_bulge(verts,
                axis_fwd=op["axis_fwd"],
                axis_up=op["axis_up"],
                up_frac_lo=op["up_frac_lo"],
                up_frac_hi=op["up_frac_hi"],
                bulge_max=op["bulge_max"],
                falloff=op.get("falloff", 2.0))
        else:
            raise ValueError(f"Unknown op: {name!r}")

    normals = recalc_normals(verts)
    write_stl(dst, normals, verts)

    mn1, mx1 = bbox(verts)
    size1 = (mx1 - mn1) * 1000.0

    return {
        "before": {"x": round(float(size0[0]), 1), "y": round(float(size0[1]), 1), "z": round(float(size0[2]), 1)},
        "after":  {"x": round(float(size1[0]), 1), "y": round(float(size1[1]), 1), "z": round(float(size1[2]), 1)},
    }


# ---------------------------------------------------------------------------
# Wave 4 operation pipelines (read from originals, NOT from wave-3 output)
# ---------------------------------------------------------------------------

LEFT_LEG_WAVE4 = {
    # --- HIP_PITCH ---
    # Overall -10% in X and Y (same as Wave 3), PLUS a mid-height cinch:
    # compress Z-middle 40%-60% by an additional 5% in X and Y.
    # cinch_waist: center at Z=50% (waist_frac=0.50), band spans 20% of height
    # (band_width=0.20 means the band half-width is 10% on each side of center,
    #  covering exactly 40%–60%). cinch_scale=0.95 gives the extra 5% compression.
    # The global scale is applied first (sets -10% baseline), then cinch on top.
    "LEFT_HIP_PITCH.STL": [
        {"op": "scale", "sx": 0.90, "sy": 0.90, "sz": 1.0},
        {"op": "cinch_waist", "axis_long": 2, "waist_frac": 0.50,
         "cinch_scale": 0.95, "band_width": 0.20},
    ],

    # --- HIP_ROLL ---
    # Small functional connector — keep Wave 3 -8%, no further change.
    "LEFT_HIP_ROLL.STL": [
        {"op": "thin_cross_section", "axis_primary": 2,
         "scale_x": 0.92, "scale_y": 0.92},
    ],

    # --- HIP_YAW (thigh) ---
    # Push cross-section slimmer: X→0.73, Y→0.76 (was 0.77/0.80)
    # Upper 25% wider: scale_axis_range at lo=0.75, hi=1.0, scale=1.07
    # Armored quad front protrusion: add_bulge on forward axis (X=0) in mid-thigh
    "LEFT_HIP_YAW.STL": [
        {"op": "thin_cross_section", "axis_primary": 2,
         "scale_x": 0.73, "scale_y": 0.76},
        {"op": "scale_axis_range", "axis": 2, "scale": 1.07,
         "lo_frac": 0.75, "hi_frac": 1.0},
        {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
         "up_frac_lo": 0.30, "up_frac_hi": 0.70, "bulge_max": 0.008, "falloff": 2.0},
    ],

    # --- KNEE (shin + knee cap) ---
    # Global scale: X→0.70 (even slimmer shin), Y→0.88 (was 0.74, 0.90)
    # Knee cap armor plate: add_bulge forward (X=0) at top 18% (82%–100%)
    "LEFT_KNEE.STL": [
        {"op": "scale", "sx": 0.70, "sy": 0.88, "sz": 1.0},
        {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
         "up_frac_lo": 0.82, "up_frac_hi": 1.0, "bulge_max": 0.008, "falloff": 2.0},
    ],

    # --- ANKLE_A ---
    # Small functional ankle pitch joint — keep Wave 3 -8%.
    "LEFT_ANKLE_A.STL": [
        {"op": "thin_cross_section", "axis_primary": 2,
         "scale_x": 0.92, "scale_y": 0.92},
    ],

    # --- ANKLE_B ---
    # Push lateral slim: X→0.75 (was 0.80), Y→0.90 (was 0.92)
    "LEFT_ANKLE_B.STL": [
        {"op": "scale", "sx": 0.75, "sy": 0.90, "sz": 1.0},
    ],

    # --- TOE ---
    # Narrower foot: X→0.88 (was 0.92), Y→0.82 (was 0.88)
    "LEFT_TOE.STL": [
        {"op": "scale", "sx": 0.88, "sy": 0.82, "sz": 1.0},
    ],
}


def run():
    print("=" * 60)
    print("ASIMOV-1 Wave 4 — LEFT LEG feminization")
    print("Reads: originals/  |  Writes: output/modified/")
    print("=" * 60)

    results = {}
    for filename, ops in LEFT_LEG_WAVE4.items():
        r = process(filename, ops)
        results[filename] = r

        part = filename.replace("LEFT_", "").replace(".STL", "")
        b, a = r["before"], r["after"]
        dx = (a["x"] - b["x"]) / b["x"] * 100
        dy = (a["y"] - b["y"]) / b["y"] * 100
        print(f"\n{part}:")
        print(f"  Before: X={b['x']:6.1f}mm  Y={b['y']:6.1f}mm  Z={b['z']:6.1f}mm")
        print(f"  After:  X={a['x']:6.1f}mm  Y={a['y']:6.1f}mm  Z={a['z']:6.1f}mm")
        print(f"  ΔX={dx:+.1f}%  ΔY={dy:+.1f}%")

    # --- Thigh cross-section check ---
    # HIP_YAW at 45% of height: a flat global thin_cross_section applies uniformly,
    # so the mid-thigh cross-section equals the overall bbox dimensions.
    # Upper flare (scale_axis_range at 0.75-1.0) does NOT affect the 45% zone.
    # Bulge adds up to bulge_max (0.008 m = 8 mm) only on the forward face.
    # Conservatively report the full-bbox X and Y as the cross-section bound.
    yaw = results["LEFT_HIP_YAW.STL"]
    thigh_x = yaw["after"]["x"]
    thigh_y = yaw["after"]["y"]
    under_100 = thigh_x < 100.0 and thigh_y < 100.0

    print("\n" + "-" * 60)
    print("THIGH (HIP_YAW) CROSS-SECTION CHECK @ ~45% height:")
    print(f"  X = {thigh_x:.1f}mm  {'< 100mm OK' if thigh_x < 100.0 else '>= 100mm NOT under target'}")
    print(f"  Y = {thigh_y:.1f}mm  {'< 100mm OK' if thigh_y < 100.0 else '>= 100mm NOT under target'}")
    print(f"  Both dimensions under 100mm: {'YES' if under_100 else 'NO'}")
    print("-" * 60)

    return results


if __name__ == "__main__":
    run()
