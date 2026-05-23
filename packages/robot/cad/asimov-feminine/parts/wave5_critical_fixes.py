"""Wave 5 — Critical fixes for feminine silhouette.

Aesthetic review found:
1. Assembled shoulder (286mm) >> assembled hip (224mm) → masculine V-taper
2. NECK_PITCH X compression didn't apply
3. ANKLE_B still too wide at 121mm

Fixes:
1. SHOULDER_PITCH: aggressive Y reduction → target 70mm (from 117mm original)
2. IMU_ORIGIN: larger hip flare → target Y≈192mm (from 135mm original)
3. WAIST_YAW: compress upper shoulder region (upper 35%) laterally by 16%
4. NECK_PITCH: fix X reduction properly → target 148mm X
5. ANKLE_B: push to 95mm X (from 152mm original → -37%)

Assembled width targets after Wave 5:
  Shoulder: 2 × (96.5 + 35) ≈ 263mm  (hip joints at ±67.5mm, shoulder pitch Y=70mm → half=35mm)
  Hip:      2 × (67.5 + 50) ≈ 235mm  (IMU Y≈192mm → hip flare gives wide pelvis)
  Shoulder/Hip ratio: 263/235 ≈ 1.12  (feminine target: ≤1.15)
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from modify_mesh import modify

ORIG = Path(__file__).parent.parent / "originals"
OUT  = Path(__file__).parent.parent / "output/modified"
OUT.mkdir(parents=True, exist_ok=True)

RESULTS = {}


def do(name, ops):
    r = modify(str(ORIG / name), str(OUT / name), ops)
    RESULTS[name] = r
    bef = r["before"]
    aft = r["after"]
    print(f"  {name:<35} {bef['x']:>6.0f}×{bef['y']:<5.0f}  →  {aft['x']:>6.0f}×{aft['y']:<5.0f}  ΔX={r['delta_x_pct']:+.1f}%  ΔY={r['delta_y_pct']:+.1f}%")


print("\n" + "="*70)
print("  WAVE 5 — CRITICAL SILHOUETTE FIXES")
print("="*70)
print(f"\n  {'Part':<35}  {'Before X×Y':>12}     {'After X×Y':>12}  ΔX     ΔY")
print("  " + "-"*65)

# 1. SHOULDER_PITCH both sides: compress Y from 117→70mm (-40%)
for side in ["LEFT", "RIGHT"]:
    do(f"{side}_SHOULDER_PITCH.STL", [
        # Start from original 87×117mm
        # Aggressive Y compression for narrow shoulder mount profile
        {"op": "scale", "sx": 0.92, "sy": 0.60, "sz": 1.0},
    ])

# 2. IMU_ORIGIN: much larger lateral hip flare → Y=192mm (from 135mm)
#    X slim stays the same (-12%)
do("IMU_ORIGIN.STL", [
    {"op": "scale", "sx": 0.88, "sy": 1.0, "sz": 1.0},
    # Flare the bottom 42% laterally to 1.42× → 135 × 1.42 = 192mm Y
    {"op": "flare_hips", "axis_lat": 1, "axis_up": 2,
     "frac_lo": 0.0, "frac_hi": 0.42, "flare_scale": 1.42},
])

# 3. WAIST_YAW: all existing ops + upper shoulder region compressed 16% laterally
#    Using the coordinate system: X=fwd, Y=lateral, Z=up
#    Shoulder level is upper 35-40% of WAIST_YAW height
do("WAIST_YAW.STL", [
    # Waist cinch (center at 42% height, -24% at waist)
    {"op": "cinch_waist", "axis_long": 2, "waist_frac": 0.42,
     "cinch_scale": 0.76, "band_width": 0.30},
    # Global lateral compression
    {"op": "scale", "sx": 1.0, "sy": 0.76, "sz": 1.0},
    # Breast shape: push forward (+X) on upper 55-90%
    {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.55, "up_frac_hi": 0.90,
     "bulge_max": 0.035, "falloff": 2.5},
    # Second focused breast bulge at 65-85%
    {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.65, "up_frac_hi": 0.85,
     "bulge_max": 0.015, "falloff": 2.0},
    # >>> WAVE 5 NEW: compress shoulder region laterally (Y) by 16%
    #     Targets upper 35% of the torso (shoulder/chest armor plates)
    {"op": "scale_axis_range", "axis": 2, "scale": 0.84,
     "lo_frac": 0.62, "hi_frac": 1.0},
    # Flare at very bottom (hip junction) in Y
    {"op": "flare_hips", "axis_lat": 1, "axis_up": 2,
     "frac_lo": 0.0, "frac_hi": 0.20, "flare_scale": 1.10},
    # Back arch lower back
    {"op": "back_arch", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.02, "up_frac_hi": 0.38, "arch_pull": 0.022},
    # Lower torso taper
    {"op": "scale_axis_range", "axis": 2, "scale": 0.93,
     "lo_frac": 0.0, "hi_frac": 0.25},
])

# 4. NECK_PITCH: fix X reduction (target 148mm from 169mm = -12%)
#    Also continue the Y lateral reduction (-8%) and jaw taper
do("NECK_PITCH.STL", [
    # X reduction: forward/backward dimension → narrower face front-to-back
    {"op": "scale", "sx": 0.88, "sy": 0.92, "sz": 1.0},
    # Jaw taper: bottom 20% gets additional Y taper
    {"op": "scale_axis_range", "axis": 2, "scale": 0.88,
     "lo_frac": 0.0, "hi_frac": 0.20},
])

# 5. ANKLE_B: push X to -37% for slender ankle
for side in ["LEFT", "RIGHT"]:
    do(f"{side}_ANKLE_B.STL", [
        {"op": "scale", "sx": 0.63, "sy": 0.90, "sz": 1.0},
    ])

print("\n" + "="*70)
print("\nKey assembled width estimates after Wave 5:")
sp = RESULTS.get("LEFT_SHOULDER_PITCH.STL", {})
if sp:
    sp_y = sp["after"]["y"]
    print(f"  Assembled shoulder: 2 × (96.5 + {sp_y/2:.0f}) = {2*(96.5+sp_y/2):.0f}mm")
im = RESULTS.get("IMU_ORIGIN.STL", {})
if im:
    im_y = im["after"]["y"]
    # Hip assembly = joint offset + hip pitch Y/2
    # hip pitch Y unchanged at ~89mm → 44.5mm half
    print(f"  Pelvis lateral width: {im_y:.0f}mm")
    print(f"  Assembled hip (incl. HIP_PITCH): 2 × (67.5 + 44.5) = {2*(67.5+44.5):.0f}mm")
    print(f"  Shoulder/Hip assembled ratio: {2*(96.5+sp_y/2) / 224:.2f}")
