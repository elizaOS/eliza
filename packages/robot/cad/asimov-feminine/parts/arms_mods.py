"""Arm feminization.

Measured dimensions (all in mm):
  LEFT_SHOULDER_PITCH:   86.6 × 116.7 × 66.7    (wide Y = 117mm)
  LEFT_SHOULDER_ROLL:    74.6 × 100.0 × 183.4    (long Z = 183mm)
  LEFT_SHOULDER_YAW:     68.5 ×  64.5 × 135.1    (long Z = 135mm)
  LEFT_ELBOW:           141.4 ×  73.5 × 132.1    (wide X = 141mm!)
  LEFT_WRIST_YAW:        38.0 ×  37.6 ×  40.3    (small joint)

Goals (valkyrie armored arms):
- SHOULDER_PITCH: slim the 117mm Y dimension (structural part) → ~90mm target.
  Keep X broad for pauldron/armor look. Target: XY cross-section thin by ~20% in Y only.
- SHOULDER_ROLL: this is the upper arm segment (183mm long). Thin XY cross-section 22%.
- SHOULDER_YAW: mid-arm connector. Thin XY cross-section 20%.
- ELBOW: the 141mm X is very wide. Thin X by 25%. Keep structural integrity.
  This is also a moving joint — minimize changes to joint interface areas.
- WRIST_YAW: already tiny. Thin slightly (10%) for elegance.

MJCF arm convention: Z is roughly the arm's long axis in most link frames.
  Primary axis for thin_cross_section = 2 (Z) for shoulder_roll, shoulder_yaw, elbow.
  For shoulder_pitch, primary axis may be different based on how it mounts.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from modify_mesh import modify

MESH_DIR   = Path(__file__).parent.parent / "originals"
OUTPUT_DIR = Path(__file__).parent.parent / "output/modified"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

SIDES = ["LEFT", "RIGHT"]

ARM_OPS = {
    "SHOULDER_PITCH": [
        # Slim Y (the wide dimension) — keep X for shoulder armor
        {"op": "scale", "sx": 1.0, "sy": 0.80, "sz": 1.0},
    ],
    "SHOULDER_ROLL": [
        # Upper arm — thin XY cross-section, Z is the long axis
        {"op": "thin_cross_section", "axis_primary": 2, "scale_x": 0.78, "scale_y": 0.78},
    ],
    "SHOULDER_YAW": [
        # Mid-arm connector
        {"op": "thin_cross_section", "axis_primary": 2, "scale_x": 0.80, "scale_y": 0.80},
    ],
    "ELBOW": [
        # Wide elbow — compress X significantly, slim Y moderately
        # Z is the long axis of the forearm segment
        {"op": "scale", "sx": 0.74, "sy": 0.88, "sz": 1.0},
    ],
    "WRIST_YAW": [
        # Slight elegance taper
        {"op": "thin_cross_section", "axis_primary": 2, "scale_x": 0.90, "scale_y": 0.90},
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
                ops
            )

    print("\n=== ARM MODIFICATIONS ===")
    for part, r in results.items():
        print(f"\n{part}:")
        print(f"  Before: X={r['before']['x']}mm  Y={r['before']['y']}mm  Z={r['before']['z']}mm")
        print(f"  After:  X={r['after']['x']}mm   Y={r['after']['y']}mm   Z={r['after']['z']}mm")
        print(f"  ΔX={r['delta_x_pct']:+.1f}%  ΔY={r['delta_y_pct']:+.1f}%")
    return results

if __name__ == "__main__":
    run()
