"""Leg feminization.

Measured dimensions:
  HIP_PITCH:   97.2 × 99.0 × 96.0    (roughly cubic, hip bracket)
  HIP_ROLL:    72.5 × 53.4 × 80.0    (smaller connector)
  HIP_YAW:    123.2 × 115.0 × 308.7  (thigh! very wide 123mm, long 309mm)
  KNEE:       128.4 × 100.9 × 369.6  (widest part 128mm, shin-length 370mm)
  ANKLE_A:     51.0 × 51.0 × 51.0    (small ankle pitch cube)
  ANKLE_B:    151.8 × 96.8 × 66.1    (wide ankle roll platform, 152mm wide!)
  TOE:         70.3 × 95.3 × 40.7    (foot toe)

Goals — "thigh gap" + armored knee look:
- HIP_PITCH: slim Y slightly (hip bracket). Armor-forward: keep Z, slim X 10%.
- HIP_ROLL: minimal change (functional connector). Slim X/Y 8%.
- HIP_YAW (thigh): biggest opportunity. Slim X from 123→95mm (-23%), slim Y 15%.
  The long Z dimension is the thigh length — preserve it.
  Upper 30% can stay slightly wider for muscular thigh armor look.
- KNEE: wide at 128mm. Slim X from 128→95mm (-26%). This makes a lean shin.
  Knee caps can be thicker (armored look), so add slight front bulge at knee level.
- ANKLE_A: very small, leave mostly unchanged. Slim X/Y by 8%.
- ANKLE_B (ankle roll): 152mm wide foot platform — slim X by 20% for narrower ankles.
  This also slims the heel-to-toe dimension slightly.
- TOE: slim Y (left-to-right) slightly by 12% for narrower foot.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from modify_mesh import modify

MESH_DIR   = Path(__file__).parent.parent / "originals"
OUTPUT_DIR = Path(__file__).parent.parent / "output/modified"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

SIDES = ["LEFT", "RIGHT"]

LEG_OPS = {
    "HIP_PITCH": [
        {"op": "scale", "sx": 0.90, "sy": 0.90, "sz": 1.0},
    ],
    "HIP_ROLL": [
        {"op": "thin_cross_section", "axis_primary": 2, "scale_x": 0.92, "scale_y": 0.92},
    ],
    "HIP_YAW": [
        # Thigh: dramatic thinning. Slim X (forward) more than Y (lateral) for elegant thigh.
        # MJCF local frame: Z is arm length (up in world), X=fwd, Y=lateral
        # The thigh hangs DOWN in world space, so local Z goes from hip (top) to knee (bottom)
        {"op": "thin_cross_section", "axis_primary": 2, "scale_x": 0.77, "scale_y": 0.80},
        # Upper 25% (hip ball) stays wider — creates the hip flare look on the thigh
        {"op": "scale_axis_range", "axis": 2, "scale": 1.08, "lo_frac": 0.75, "hi_frac": 1.0},
        # Add armored quad front bulge in upper-mid thigh (X=fwd)
        {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
         "up_frac_lo": 0.30, "up_frac_hi": 0.70, "bulge_max": 0.007, "falloff": 2.0},
    ],
    "KNEE": [
        # Shin + knee: slim X aggressively, keep Y (front-back for knee caps)
        {"op": "scale", "sx": 0.74, "sy": 0.90, "sz": 1.0},
        # Knee cap area: upper 15% can bulge forward slightly (armored knee plate)
        {"op": "add_bulge", "axis_fwd": 1, "axis_up": 2,
         "up_frac_lo": 0.80, "up_frac_hi": 1.0, "bulge_max": 0.007, "falloff": 1.5},
    ],
    "ANKLE_A": [
        {"op": "thin_cross_section", "axis_primary": 2, "scale_x": 0.92, "scale_y": 0.92},
    ],
    "ANKLE_B": [
        # Wide ankle platform: slim X (lateral width) significantly
        {"op": "scale", "sx": 0.80, "sy": 0.92, "sz": 1.0},
    ],
    "TOE": [
        # Narrow the foot slightly
        {"op": "scale", "sx": 0.92, "sy": 0.88, "sz": 1.0},
    ],
}


def run():
    results = {}
    for side in SIDES:
        for part, ops in LEG_OPS.items():
            filename = f"{side}_{part}.STL"
            results[filename] = modify(
                str(MESH_DIR / filename),
                str(OUTPUT_DIR / filename),
                ops
            )

    print("\n=== LEG MODIFICATIONS ===")
    for part, r in results.items():
        print(f"\n{part}:")
        print(f"  Before: X={r['before']['x']}mm  Y={r['before']['y']}mm  Z={r['before']['z']}mm")
        print(f"  After:  X={r['after']['x']}mm   Y={r['after']['y']}mm   Z={r['after']['z']}mm")
        print(f"  ΔX={r['delta_x_pct']:+.1f}%  ΔY={r['delta_y_pct']:+.1f}%")
    return results

if __name__ == "__main__":
    run()
