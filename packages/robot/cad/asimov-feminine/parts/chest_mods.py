"""Chest / torso feminization — the most impactful changes.

IMU_ORIGIN.STL  (pelvis at z=0.630): 131.9×135.0×183.8mm
WAIST_YAW.STL   (main torso at z=0.705): 218.8×250.0×381.7mm  ← key piece

Goals for WAIST_YAW (primary torso body):
- Waist cinch: compress the middle section laterally + front-to-back ~20-22%
- Breast shape: forward bulge on upper ~40% of torso (Y axis is forward in MJCF)
- Upper chest armor plates can be wider (keep top X broad for valkyrie shoulder-pauldron look)
- Back arch: slight taper at lower back (lower 30%, Y-negative side compressed)

Goals for IMU_ORIGIN (pelvis):
- Hip flare: widen X slightly at bottom 35% for feminine hip ratio
- Overall slim Y (front-to-back depth) by 10%

ASIMOV MJCF coordinate convention:
  X = lateral (left/right)
  Y = forward/backward
  Z = up

In WAIST_YAW.STL local frame (origin at joint position, Z=up by convention):
  Waist cinch operates on Z=up axis
  Breast bulge pushes along Y (forward)
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

    # IMU_ORIGIN (pelvis): lateral hip flare + forward slim
    # MJCF: X=forward, Y=lateral, Z=up → axis_lat=1 for lateral flare
    results["IMU_ORIGIN.STL"] = modify(
        str(MESH_DIR / "IMU_ORIGIN.STL"),
        str(OUTPUT_DIR / "IMU_ORIGIN.STL"),
        [
            # Slim front-to-back (X) slightly for lean pelvis
            {"op": "scale", "sx": 0.88, "sy": 1.0, "sz": 1.0},
            # Flare hips LATERALLY (Y axis) at bottom 40% — widens hips
            {"op": "flare_hips", "axis_lat": 1, "axis_up": 2,
             "frac_lo": 0.0, "frac_hi": 0.42, "flare_scale": 1.18},
        ]
    )

    # WAIST_YAW: the big one — full torso sculpt
    results["WAIST_YAW.STL"] = modify(
        str(MESH_DIR / "WAIST_YAW.STL"),
        str(OUTPUT_DIR / "WAIST_YAW.STL"),
        [
            # 1. Cinch the waist: compress mid-section (40-60% of height) in X and Y
            #    This creates the hourglass. cinch_scale=0.76 → 24% reduction at waist center
            {"op": "cinch_waist", "axis_long": 2, "waist_frac": 0.42,
             "cinch_scale": 0.76, "band_width": 0.30},

            # 2. Slim overall front-to-back (Y) — torso is 250mm deep, target ~190mm
            {"op": "scale", "sx": 1.0, "sy": 0.76, "sz": 1.0},

            # 3. Breast shape: push forward (+X) on upper 50-85% of torso height
            #    In MJCF frame: X=forward, Y=lateral, Z=up
            #    bulge_max=0.035m = 35mm forward — creates chest protrusion
            {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
             "up_frac_lo": 0.50, "up_frac_hi": 0.90,
             "bulge_max": 0.035, "falloff": 2.5},

            # 4. Keep upper chest/shoulder area broad (valkyrie armor plates)
            #    Top 15% stays full width — flare the upper section slightly
            {"op": "scale_axis_range", "axis": 2, "scale": 1.05,
             "lo_frac": 0.82, "hi_frac": 1.0},

            # 5. Lower torso taper in Y (lateral) — bottom 25% — hip junction slim
            {"op": "scale_axis_range", "axis": 2, "scale": 0.93,
             "lo_frac": 0.0, "hi_frac": 0.25},

            # 6. Back arch: pull lower-back vertices forward in the 0-35% height band
            #    X=forward, Z=up — pulls back (-X) side of lower torso inward
            {"op": "back_arch", "axis_fwd": 0, "axis_up": 2,
             "up_frac_lo": 0.02, "up_frac_hi": 0.38, "arch_pull": 0.022},
        ]
    )

    print("\n=== CHEST / TORSO MODIFICATIONS ===")
    for part, r in results.items():
        print(f"\n{part}:")
        print(f"  Before: X={r['before']['x']}mm  Y={r['before']['y']}mm  Z={r['before']['z']}mm")
        print(f"  After:  X={r['after']['x']}mm   Y={r['after']['y']}mm   Z={r['after']['z']}mm")
        print(f"  ΔX={r['delta_x_pct']:+.1f}%  ΔY={r['delta_y_pct']:+.1f}%")
    return results

if __name__ == "__main__":
    run()
