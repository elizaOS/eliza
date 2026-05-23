"""Wave 4 RIGHT leg feminization.

Applies the same Wave 4 ops as the left leg, mirrored to the right side.
All ops are symmetric (no lateral reflection needed — the mesh coordinate
systems are already mirrored in the MJCF/URDF). The same parameter set
produces matching shapes on both sides.

Modifications vs baseline (legs_mods.py):
  RIGHT_HIP_PITCH:   thin_cross_section(0.90×0.90) + cinch_waist(mid, 0.95, 0.20)
  RIGHT_HIP_ROLL:    thin_cross_section(0.92×0.92)
  RIGHT_HIP_YAW:     thin_cross_section(0.73×0.76) + upper_flare(0.75-1.0, ×1.07) + quad_bulge
  RIGHT_KNEE:        scale(sx=0.70, sy=0.88) + knee_cap_bulge
  RIGHT_ANKLE_A:     thin_cross_section(0.92×0.92)
  RIGHT_ANKLE_B:     scale(sx=0.75, sy=0.90)
  RIGHT_TOE:         scale(sx=0.88, sy=0.82)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from modify_mesh import modify

BASE = Path(__file__).parent.parent
ORIG = BASE / "originals"
OUT  = BASE / "output/modified"
OUT.mkdir(parents=True, exist_ok=True)

RIGHT_LEG_OPS = {
    "RIGHT_HIP_PITCH": [
        # Slim cross-section 10% on both lateral axes (hip bracket)
        {"op": "thin_cross_section", "axis_primary": 2,
         "scale_x": 0.90, "scale_y": 0.90},
        # Mid cinch at 50% height — subtle waist definition on the hip bracket
        {"op": "cinch_waist", "axis_long": 2, "waist_frac": 0.50,
         "cinch_scale": 0.95, "band_width": 0.20},
    ],
    "RIGHT_HIP_ROLL": [
        # Functional connector — minimal 8% slim, no other changes
        {"op": "thin_cross_section", "axis_primary": 2,
         "scale_x": 0.92, "scale_y": 0.92},
    ],
    "RIGHT_HIP_YAW": [
        # Thigh: slim X (fwd) more than Y (lateral) for elegant thigh profile
        # X: 123mm → ~90mm (-27%), Y: 115mm → ~87mm (-24%)
        {"op": "thin_cross_section", "axis_primary": 2,
         "scale_x": 0.73, "scale_y": 0.76},
        # Upper 25% (hip ball) stays wider — creates hip flare on thigh top
        {"op": "scale_axis_range", "axis": 2, "scale": 1.07,
         "lo_frac": 0.75, "hi_frac": 1.0},
        # Armored quad front bulge in upper-mid thigh (X=fwd, 30-70% height)
        {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
         "up_frac_lo": 0.30, "up_frac_hi": 0.70,
         "bulge_max": 0.008, "falloff": 2.0},
    ],
    "RIGHT_KNEE": [
        # Shin + knee: slim X aggressively, preserve Y (front-back knee depth)
        # X: 128mm → ~90mm (-30%), Y: 101mm → ~89mm (-12%)
        {"op": "scale", "sx": 0.70, "sy": 0.88, "sz": 1.0},
        # Knee cap area: upper 18% bulges forward (armored knee plate)
        {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
         "up_frac_lo": 0.82, "up_frac_hi": 1.0,
         "bulge_max": 0.008, "falloff": 1.5},
    ],
    "RIGHT_ANKLE_A": [
        # Small ankle pitch cube — slim 8%, preserve geometry
        {"op": "thin_cross_section", "axis_primary": 2,
         "scale_x": 0.92, "scale_y": 0.92},
    ],
    "RIGHT_ANKLE_B": [
        # Wide ankle roll platform: slim X (lateral) 25%, Y (depth) 10%
        # X: 152mm → ~114mm, Y: 97mm → ~87mm
        {"op": "scale", "sx": 0.75, "sy": 0.90, "sz": 1.0},
    ],
    "RIGHT_TOE": [
        # Narrow the foot: X 12% slimmer, Y 18% slimmer
        {"op": "scale", "sx": 0.88, "sy": 0.82, "sz": 1.0},
    ],
}


def run():
    results = {}
    for part, ops in RIGHT_LEG_OPS.items():
        results[part] = modify(
            str(ORIG / f"{part}.STL"),
            str(OUT  / f"{part}.STL"),
            ops,
        )
    return results


if __name__ == "__main__":
    results = run()

    print()
    print("╔══════════════════════════════════════════════════════════════╗")
    print("║        WAVE 4 — RIGHT LEG MODIFICATIONS                     ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    print()
    print(f"  {'Part':<20}  {'Before (X×Y×Z mm)':>22}  {'After (X×Y×Z mm)':>22}  {'ΔX%':>6}  {'ΔY%':>6}")
    print("  " + "-" * 84)

    for part, r in results.items():
        bx, by, bz = r['before']['x'], r['before']['y'], r['before']['z']
        ax, ay, az = r['after']['x'],  r['after']['y'],  r['after']['z']
        dx, dy     = r['delta_x_pct'], r['delta_y_pct']
        print(f"  {part:<20}  {bx:>6.1f}×{by:>5.1f}×{bz:>5.1f}       "
              f"{ax:>6.1f}×{ay:>5.1f}×{az:>5.1f}   {dx:>+6.1f}  {dy:>+6.1f}")

    print()
