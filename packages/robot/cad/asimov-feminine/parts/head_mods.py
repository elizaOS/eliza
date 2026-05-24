"""Head & neck feminization.

NECK_YAW.STL  (joint link at z=1.083): 70.7×60.5×74.7mm
NECK_PITCH.STL (head assembly at z=1.120): 168.8×131.4×184.0mm

Goals:
- Neck: thinner, more graceful. Compress XY cross-section ~22%.
- Head: slightly narrower face/sides (compress X 12%), preserve frontal depth.
  Give slight chin-taper by scaling lower portion smaller.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from modify_mesh import modify

MESH_DIR   = Path(__file__).parent.parent / "originals"
OUTPUT_DIR = Path(__file__).parent.parent / "output/modified"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

def run():
    results = {}

    # NECK_YAW: the rotating neck joint — thin it significantly
    results["NECK_YAW.STL"] = modify(
        str(MESH_DIR / "NECK_YAW.STL"),
        str(OUTPUT_DIR / "NECK_YAW.STL"),
        [
            # Compress XY cross section (vertical axis is Z)
            {"op": "thin_cross_section", "axis_primary": 2, "scale_x": 0.78, "scale_y": 0.78},
        ]
    )

    # NECK_PITCH: the head assembly — narrow laterally, preserve height and depth
    results["NECK_PITCH.STL"] = modify(
        str(MESH_DIR / "NECK_PITCH.STL"),
        str(OUTPUT_DIR / "NECK_PITCH.STL"),
        [
            # Narrow the head X (lateral) to give a more oval face shape
            {"op": "scale", "sx": 0.88, "sy": 1.0, "sz": 1.0},
            # Taper the lower chin area (bottom 20%) narrower in X for feminine jaw
            {"op": "scale_axis_range", "axis": 2, "scale": 0.90, "lo_frac": 0.0, "hi_frac": 0.20},
        ]
    )

    print("\n=== HEAD MODIFICATIONS ===")
    for part, r in results.items():
        print(f"\n{part}:")
        print(f"  Before: X={r['before']['x']}mm  Y={r['before']['y']}mm  Z={r['before']['z']}mm")
        print(f"  After:  X={r['after']['x']}mm   Y={r['after']['y']}mm   Z={r['after']['z']}mm")
        print(f"  ΔX={r['delta_x_pct']:+.1f}%  ΔY={r['delta_y_pct']:+.1f}%")
    return results

if __name__ == "__main__":
    run()
