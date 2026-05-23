"""Apply a named modification pipeline to an STL file.

Usage:
    python modify_mesh.py --input <stl> --output <stl> [--ops <json>]

ops JSON example:
    [
        {"op": "thin_cross_section", "axis_primary": 2, "scale_x": 0.78, "scale_y": 0.78},
        {"op": "cinch_waist",  "axis_long": 2, "waist_frac": 0.45, "cinch_scale": 0.80},
        {"op": "scale",        "sx": 1.0, "sy": 0.9, "sz": 1.0},
        {"op": "add_bulge",    "axis_fwd": 1, "axis_up": 2, "up_frac_lo": 0.55,
                               "up_frac_hi": 0.95, "bulge_max": 0.025},
        {"op": "flare_hips",   "axis_lat": 0, "axis_up": 2, "frac_lo": 0.0,
                               "frac_hi": 0.35, "flare_scale": 1.12}
    ]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from stl_utils import (read_stl, write_stl, recalc_normals, bbox,
                        scale_mesh, scale_axis_range, add_bulge,
                        thin_cross_section, cinch_waist, flare_hips, back_arch)


def apply_op(verts, op: dict):
    name = op["op"]
    if name == "thin_cross_section":
        return thin_cross_section(verts,
            axis_primary=op.get("axis_primary", 2),
            scale_x=op.get("scale_x", 0.8),
            scale_y=op.get("scale_y", 0.8))
    if name == "cinch_waist":
        return cinch_waist(verts,
            axis_long=op.get("axis_long", 2),
            waist_frac=op.get("waist_frac", 0.45),
            cinch_scale=op.get("cinch_scale", 0.78),
            band_width=op.get("band_width", 0.25))
    if name == "scale":
        return scale_mesh(verts,
            sx=op.get("sx", 1.0), sy=op.get("sy", 1.0), sz=op.get("sz", 1.0))
    if name == "scale_axis_range":
        return scale_axis_range(verts,
            axis=op.get("axis", 2),
            scale=op.get("scale", 0.8),
            lo_frac=op.get("lo_frac", 0.0),
            hi_frac=op.get("hi_frac", 1.0))
    if name == "add_bulge":
        return add_bulge(verts,
            axis_fwd=op.get("axis_fwd", 1),
            axis_up=op.get("axis_up", 2),
            up_frac_lo=op.get("up_frac_lo", 0.55),
            up_frac_hi=op.get("up_frac_hi", 0.95),
            bulge_max=op.get("bulge_max", 0.02),
            falloff=op.get("falloff", 2.0))
    if name == "flare_hips":
        return flare_hips(verts,
            axis_lat=op.get("axis_lat", 0),
            axis_up=op.get("axis_up", 2),
            frac_lo=op.get("frac_lo", 0.0),
            frac_hi=op.get("frac_hi", 0.35),
            flare_scale=op.get("flare_scale", 1.12))
    if name == "back_arch":
        return back_arch(verts,
            axis_fwd=op.get("axis_fwd", 0),
            axis_up=op.get("axis_up", 2),
            up_frac_lo=op.get("up_frac_lo", 0.0),
            up_frac_hi=op.get("up_frac_hi", 0.35),
            arch_pull=op.get("arch_pull", 0.020))
    raise ValueError(f"Unknown op: {name}")


def modify(input_path: str, output_path: str, ops: list[dict]) -> dict:
    normals, verts = read_stl(input_path)
    mn0, mx0 = bbox(verts)
    size0 = (mx0 - mn0) * 1000

    for op in ops:
        verts = apply_op(verts, op)

    normals = recalc_normals(verts)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    write_stl(output_path, normals, verts)

    mn1, mx1 = bbox(verts)
    size1 = (mx1 - mn1) * 1000
    return {
        "before": {"x": round(float(size0[0]),1), "y": round(float(size0[1]),1), "z": round(float(size0[2]),1)},
        "after":  {"x": round(float(size1[0]),1), "y": round(float(size1[1]),1), "z": round(float(size1[2]),1)},
        "delta_x_pct": round(float((size1[0]-size0[0])/size0[0]*100), 1),
        "delta_y_pct": round(float((size1[1]-size0[1])/size0[1]*100), 1),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ops", default="[]", help="JSON array of op dicts")
    args = parser.parse_args()

    ops = json.loads(args.ops)
    result = modify(args.input, args.output, ops)
    print(f"Before: X={result['before']['x']}mm Y={result['before']['y']}mm Z={result['before']['z']}mm")
    print(f"After:  X={result['after']['x']}mm  Y={result['after']['y']}mm  Z={result['after']['z']}mm")
    print(f"ΔX={result['delta_x_pct']:+.1f}%  ΔY={result['delta_y_pct']:+.1f}%")
