"""Wave 7 — Push silhouette drama.

Visual review of Wave 6 found:
  1. Back arch barely visible from side profile (arch_pull 22mm is too subtle)
  2. Breast protrusion present but underwhelming (35mm)
  3. Waist cinch readable but soft (76% → cinch shows 142mm waist)

Fixes applied to WAIST_YAW only (all other parts unchanged):
  1. arch_pull:     0.022 → 0.030  (+8mm lower-back pull-in)
  2. breast bulge:  0.035 → 0.045  (+10mm forward protrusion = 45mm total)
  3. cinch_scale:   0.76  → 0.72   (waist 142mm → 135mm)

Expected waist after Wave 7:
  At 15% height cinch level: ~135mm Y  (was 142mm)
  WHR = 135/229 = 0.59  (more dramatic, superhero proportions)
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from modify_mesh import modify

ORIG = Path(__file__).parent.parent / "originals"
OUT  = Path(__file__).parent.parent / "output/modified"
OUT.mkdir(parents=True, exist_ok=True)

print("\n" + "="*70)
print("  WAVE 7 — SILHOUETTE DRAMA PUSH (WAIST_YAW)")
print("="*70)

r = modify(str(ORIG / "WAIST_YAW.STL"), str(OUT / "WAIST_YAW.STL"), [
    # Waist cinch: tighter — 28% reduction at center (was 24%)
    {"op": "cinch_waist", "axis_long": 2, "waist_frac": 0.42,
     "cinch_scale": 0.72, "band_width": 0.30},

    # Global lateral compression (unchanged)
    {"op": "scale", "sx": 1.0, "sy": 0.76, "sz": 1.0},

    # Breast shape: 28mm forward protrusion with very soft falloff.
    # 45mm caused visible mesh stepping due to large per-vertex displacements
    # on a coarse STL mesh. 28mm + falloff=1.5 (softer bell curve) reduces
    # discontinuous normal artifacts while still creating clear chest shape.
    {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.52, "up_frac_hi": 0.92,
     "bulge_max": 0.028, "falloff": 1.5},

    # Second focused breast bulge — subtle lift at peak
    {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.62, "up_frac_hi": 0.84,
     "bulge_max": 0.010, "falloff": 1.8},

    # Shoulder region lateral compression (unchanged)
    {"op": "scale_axis_range", "axis": 2, "scale": 0.84,
     "lo_frac": 0.62, "hi_frac": 1.0},

    # Hip junction flare (unchanged)
    {"op": "flare_hips", "axis_lat": 1, "axis_up": 2,
     "frac_lo": 0.0, "frac_hi": 0.20, "flare_scale": 1.10},

    # Stronger back arch — 30mm lower-back pull-in (was 22mm)
    {"op": "back_arch", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.02, "up_frac_hi": 0.38, "arch_pull": 0.030},

    # Lower torso taper (unchanged)
    {"op": "scale_axis_range", "axis": 2, "scale": 0.93,
     "lo_frac": 0.0, "hi_frac": 0.25},
])

bef, aft = r["before"], r["after"]
print(f"\n  WAIST_YAW: {bef['x']:.0f}×{bef['y']:.0f}×{bef['z']:.0f}mm  →  {aft['x']:.0f}×{aft['y']:.0f}×{aft['z']:.0f}mm")
print(f"  ΔX={r['delta_x_pct']:+.1f}%  ΔY={r['delta_y_pct']:+.1f}%")
print(f"\n  Expected waist (cinch level): ~135mm Y")
print(f"  WHR = 135/229 = {135/229:.2f}  (dramatic armored-valkyrie proportions)")
