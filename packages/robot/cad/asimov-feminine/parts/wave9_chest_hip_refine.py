"""Wave 9 — Chest front-view visibility + hip/thigh refinement.

Visual review after Wave 8:
  ✓ Side profile: excellent breast protrusion (+38mm), visible arch, cinched waist
  ✓ Front profile: hourglass readable (waist 122mm vs chest 148mm)
  ✗ Front view chest: breast zone is only 2cm wider than waist — not dramatic enough
  ✗ Hip/thigh: straight column, no taper from hip to knee
  ✗ Assembled hip width: could be wider for more dramatic WHR

Wave 9 changes:
  1. WAIST_YAW (from originals):
       - Waist cinch: 0.62× (tighter, was 0.65)
       - Breast forward: 55mm main split bulge (was 50mm)
       - Breast lateral swell: flare_hips at 52–88%, 1.12× Y → chest wider from front
       - Back arch: 40mm (was 38mm)
  2. HIP_YAW (incremental): thigh taper — top 40% expand 1.15×, bottom 35% compress 0.90×
  3. HIP_PITCH (from originals): expand Y to 1.05× for wider assembled hip
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from modify_mesh import modify

ORIG   = Path(__file__).parent.parent / "originals"
CURR   = Path(__file__).resolve().parent.parent.parent.parent / "assets/profiles/asimov-1/meshes"
OUT    = Path(__file__).parent.parent / "output/modified"
OUT.mkdir(parents=True, exist_ok=True)

print("\n" + "="*70)
print("  WAVE 9 — CHEST FRONT-VIEW + HIP/THIGH REFINEMENT")
print("="*70)

# ── 1. WAIST_YAW — from originals, full op list ────────────────────────────
print("\n[1] WAIST_YAW — from originals (full rebuild)")
r = modify(str(ORIG / "WAIST_YAW.STL"), str(OUT / "WAIST_YAW.STL"), [
    # Waist cinch: tighter (0.62 from 0.65), band narrowed slightly
    {"op": "cinch_waist", "axis_long": 2, "waist_frac": 0.42,
     "cinch_scale": 0.62, "band_width": 0.25},

    # Global lateral compression
    {"op": "scale", "sx": 1.0, "sy": 0.72, "sz": 1.0},

    # Breast forward protrusion: split dual mounds, 55mm (was 50mm)
    {"op": "add_split_bulge", "axis_fwd": 0, "axis_up": 2, "axis_lat": 1,
     "up_frac_lo": 0.52, "up_frac_hi": 0.88,
     "lat_offset": 0.032, "lat_sigma": 0.036,
     "bulge_max": 0.055, "falloff": 2.0},

    # Background chest roundness
    {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.55, "up_frac_hi": 0.85,
     "bulge_max": 0.020, "falloff": 2.5},

    # Concentrated breast apex
    {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.63, "up_frac_hi": 0.80,
     "bulge_max": 0.012, "falloff": 1.8},

    # Shoulder region lateral compression (upper 38%, armor plate fit)
    {"op": "scale_axis_range", "axis": 2, "scale": 0.82,
     "lo_frac": 0.62, "hi_frac": 1.0},

    # BREAST LATERAL SWELL — NEW: expand Y at breast zone, making chest
    # appear visibly wider than waist from the front view.
    # Applied AFTER shoulder compression so it restores some width at breast
    # level while shoulders stay narrower (armored plate aesthetic).
    {"op": "flare_hips", "axis_lat": 1, "axis_up": 2,
     "frac_lo": 0.52, "frac_hi": 0.87, "flare_scale": 1.12},

    # Hip junction flare (bottom 20%)
    {"op": "flare_hips", "axis_lat": 1, "axis_up": 2,
     "frac_lo": 0.0, "frac_hi": 0.20, "flare_scale": 1.14},

    # Back arch: 40mm (slightly stronger)
    {"op": "back_arch", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.02, "up_frac_hi": 0.42, "arch_pull": 0.040},

    # Lower torso taper
    {"op": "scale_axis_range", "axis": 2, "scale": 0.93,
     "lo_frac": 0.0, "hi_frac": 0.25},
])
bef, aft = r["before"], r["after"]
print(f"  {bef['x']:.0f}×{bef['y']:.0f}×{bef['z']:.0f}mm  →  {aft['x']:.0f}×{aft['y']:.0f}×{aft['z']:.0f}mm")
print(f"  ΔX={r['delta_x_pct']:+.1f}%  ΔY={r['delta_y_pct']:+.1f}%")

# ── 2. HIP_YAW — thigh taper (incremental on current modified) ────────────
print("\n[2] HIP_YAW — thigh taper (wide at hip, narrower at knee)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_HIP_YAW.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        # Top 40% (hip end): expand laterally 15% → wider thigh at hip
        {"op": "flare_hips", "axis_lat": 1, "axis_up": 2,
         "frac_lo": 0.60, "frac_hi": 1.0, "flare_scale": 1.15},
        # Bottom 35% (knee approach): compress 10% → narrower below-knee
        {"op": "flare_hips", "axis_lat": 1, "axis_up": 2,
         "frac_lo": 0.0, "frac_hi": 0.35, "flare_scale": 0.90},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f}mm → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 3. HIP_PITCH — wider for assembled hip flare ─────────────────────────
print("\n[3] HIP_PITCH — +5% Y for wider assembled hips")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_HIP_PITCH.STL"
    # Read from originals to avoid stacking issues — HIP_PITCH was minimally
    # modified (only -5.1% Y from wave 6). Rebuild from original + precise target.
    r = modify(str(ORIG / name), str(OUT / name), [
        {"op": "scale", "sx": 0.90, "sy": 0.98, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f}mm → {aft['x']:.0f}×{aft['y']:.0f}mm")

print("\n" + "="*70)
print("  Wave 9 output written to output/modified/")
print("="*70)
