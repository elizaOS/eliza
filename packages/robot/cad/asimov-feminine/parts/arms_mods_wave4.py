"""Wave 4 arm feminization — valkyrie armored arms.

Builds on Wave 3 proportions (all ops applied from originals):
  LEFT_SHOULDER_PITCH:  87×117mm  → target: slim X+Y for cleaner pauldron mount
  LEFT_SHOULDER_ROLL:   75×100mm  → upper arm with distal taper (shoulder→elbow)
  LEFT_SHOULDER_YAW:    68×64mm   → pushed slightly slimmer at -22%
  LEFT_ELBOW:          141×74mm   → forearm, slim Y further to -18% total
  LEFT_WRIST_YAW:       38×38mm   → slender wrist at -15%

Right arm is symmetric (identical ops, different filenames).

Coordinate notes (MJCF):  X=forward, Y=lateral, Z=up / arm-long-axis
  thin_cross_section(axis_primary=2) compresses X and Y, preserving Z length.
  scale_axis_range taper: axis=2 (Z), lo_frac/hi_frac selects the lower 40%
    of the arm length, scale applies to the perpendicular (X,Y) axes only.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from modify_mesh import modify

MESH_DIR   = Path(__file__).parent.parent / "originals"
OUTPUT_DIR = Path(__file__).parent.parent / "output/modified"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

SIDES = ["LEFT", "RIGHT"]

# Wave 4 ops — all applied from originals (not stacked on Wave 3 output).
ARM_OPS = {
    # SHOULDER_PITCH — structural bracket, short.
    # Wave 3: sy=0.80 only.  Wave 4: also slim X by 8% (sx=0.92).
    "SHOULDER_PITCH": [
        {"op": "scale", "sx": 0.92, "sy": 0.80, "sz": 1.0},
    ],

    # SHOULDER_ROLL — upper arm segment, 183mm long (Z axis).
    # Wave 3: thin_cross_section -22%.  Wave 4: same thin, PLUS forearm-style
    # taper: lower 40% of Z (toward elbow) compressed a further 8% in XY.
    "SHOULDER_ROLL": [
        {"op": "thin_cross_section", "axis_primary": 2, "scale_x": 0.78, "scale_y": 0.78},
        {"op": "scale_axis_range", "axis": 2, "scale": 0.92, "lo_frac": 0.0, "hi_frac": 0.40},
    ],

    # SHOULDER_YAW — mid-arm connector.
    # Wave 3: thin -20%.  Wave 4: push to -22%.
    "SHOULDER_YAW": [
        {"op": "thin_cross_section", "axis_primary": 2, "scale_x": 0.78, "scale_y": 0.78},
    ],

    # ELBOW — forearm segment, 132mm long, very wide X=141mm.
    # Wave 3: sx=0.74 (-26%), sy=0.88 (-12%).  Wave 4: push sy to 0.82 (-18%).
    "ELBOW": [
        {"op": "scale", "sx": 0.74, "sy": 0.82, "sz": 1.0},
    ],

    # WRIST_YAW — small joint.
    # Wave 3: thin -10%.  Wave 4: push to -15%.
    "WRIST_YAW": [
        {"op": "thin_cross_section", "axis_primary": 2, "scale_x": 0.85, "scale_y": 0.85},
    ],
}


def run():
    results = {}
    for side in SIDES:
        for part, ops in ARM_OPS.items():
            filename = f"{side}_{part}.STL"
            results[filename] = modify(
                str(MESH_DIR / filename),
                str(OUTPUT_DIR / filename),
                ops,
            )

    print("\n=== ARM MODIFICATIONS — WAVE 4 ===")
    header = f"{'Part':<35} {'Before X×Y×Z':>18} {'After X×Y×Z':>18}  {'ΔX%':>6}  {'ΔY%':>6}"
    print(header)
    print("-" * len(header))
    for filename, r in results.items():
        b, a = r["before"], r["after"]
        print(
            f"  {filename:<33} "
            f"{b['x']:>5.0f}×{b['y']:>4.0f}×{b['z']:>4.0f}  "
            f"{a['x']:>5.0f}×{a['y']:>4.0f}×{a['z']:>4.0f}  "
            f"{r['delta_x_pct']:>+5.1f}%  {r['delta_y_pct']:>+5.1f}%"
        )
    return results


if __name__ == "__main__":
    run()
