"""Wave 4 chest/torso feminization.

Changes vs Wave 3:
  WAIST_YAW:
    - All Wave 3 ops retained (cinch 0.76, scale sy=0.76, breast bulge X+ 50-90%,
      upper flare, lower taper, back arch)
    + Second focused breast bulge at 65-85% height, +0.015m extra protrusion
    + Deepened waist cinch at bottom 0-15% (scale_axis_range lateral 0.72)
    + Hip flare at bottom 20% of WAIST_YAW (Y lateral scale 1.10)

  IMU_ORIGIN:
    - Identical to Wave 3 (scale sx=0.88, flare_hips axis_lat=1 scale=1.18)
"""
import sys
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from stl_utils import read_stl, write_stl, recalc_normals, bbox
from modify_mesh import modify

BASE   = Path(__file__).parent.parent
ORIG   = BASE / "originals"
OUT    = BASE / "output/modified"
OUT.mkdir(parents=True, exist_ok=True)


# ── WAIST_YAW (torso) ────────────────────────────────────────────────────────

waist_ops = [
    # 1. Primary waist cinch: compress mid-section ~24% at center (Wave 3)
    {"op": "cinch_waist", "axis_long": 2, "waist_frac": 0.42,
     "cinch_scale": 0.76, "band_width": 0.30},

    # 2. Slim overall front-to-back (Y) — 250mm → ~190mm (Wave 3)
    {"op": "scale", "sx": 1.0, "sy": 0.76, "sz": 1.0},

    # 3. Primary breast bulge — 50-90% height, +35mm forward (Wave 3)
    {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.50, "up_frac_hi": 0.90,
     "bulge_max": 0.035, "falloff": 2.5},

    # 4. WAVE 4: Second focused breast bulge — 65-85% height, extra +15mm
    #    More concentrated falloff (3.5) keeps protrusion tight/anatomical
    {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.65, "up_frac_hi": 0.85,
     "bulge_max": 0.015, "falloff": 3.5},

    # 5. Upper chest/shoulder broad — top 15-18% flared (Wave 3)
    {"op": "scale_axis_range", "axis": 2, "scale": 1.05,
     "lo_frac": 0.82, "hi_frac": 1.0},

    # 6. Lower torso Y taper — bottom 25% hip junction slim (Wave 3)
    {"op": "scale_axis_range", "axis": 2, "scale": 0.93,
     "lo_frac": 0.0, "hi_frac": 0.25},

    # 7. WAVE 4: Deepened waist cinch at very bottom 0-15%
    #    Scales lateral (Y) axis by 0.72 at lower torso/waist junction
    {"op": "scale_axis_range", "axis": 2, "scale": 0.72,
     "lo_frac": 0.0, "hi_frac": 0.15},

    # 8. WAVE 4: Hip flare at bottom 20% — waist-hip junction (Y lateral scale 1.10)
    {"op": "flare_hips", "axis_lat": 1, "axis_up": 2,
     "frac_lo": 0.0, "frac_hi": 0.20, "flare_scale": 1.10},

    # 9. Back arch: lower-back lordotic curve (Wave 3)
    {"op": "back_arch", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.02, "up_frac_hi": 0.38, "arch_pull": 0.022},
]

r_waist = modify(
    str(ORIG / "WAIST_YAW.STL"),
    str(OUT  / "WAIST_YAW.STL"),
    waist_ops,
)

# ── IMU_ORIGIN (pelvis) ───────────────────────────────────────────────────────

pelvis_ops = [
    {"op": "scale", "sx": 0.88, "sy": 1.0, "sz": 1.0},
    {"op": "flare_hips", "axis_lat": 1, "axis_up": 2,
     "frac_lo": 0.0, "frac_hi": 0.42, "flare_scale": 1.18},
]

r_pelvis = modify(
    str(ORIG / "IMU_ORIGIN.STL"),
    str(OUT  / "IMU_ORIGIN.STL"),
    pelvis_ops,
)

# ── Summary ───────────────────────────────────────────────────────────────────

print("\n╔══════════════════════════════════════════════════════╗")
print("║         WAVE 4 — CHEST/TORSO MODIFICATIONS          ║")
print("╚══════════════════════════════════════════════════════╝")

for name, r in [("WAIST_YAW.STL", r_waist), ("IMU_ORIGIN.STL", r_pelvis)]:
    print(f"\n  {name}:")
    print(f"    Before : X={r['before']['x']}mm  Y={r['before']['y']}mm  Z={r['before']['z']}mm")
    print(f"    After  : X={r['after']['x']}mm  Y={r['after']['y']}mm  Z={r['after']['z']}mm")
    print(f"    ΔX={r['delta_x_pct']:+.1f}%   ΔY={r['delta_y_pct']:+.1f}%")

# ── Cross-section analysis of WAIST_YAW ──────────────────────────────────────

print("\n╔══════════════════════════════════════════════════════╗")
print("║    WAIST_YAW CROSS-SECTIONS  (axis 0=X fwd, 1=Y lat)║")
print("╚══════════════════════════════════════════════════════╝")

_, verts = read_stl(str(OUT / "WAIST_YAW.STL"))
all_v = verts.reshape(-1, 3)
z_min, z_max = all_v[:, 2].min(), all_v[:, 2].max()
z_span = z_max - z_min

target_fracs = [0.15, 0.45, 0.65, 0.85]
section_dims = {}

for frac in target_fracs:
    z = z_min + z_span * frac
    thickness = 0.006  # 6mm slab
    tris = verts
    pts = []
    for i in range(len(tris)):
        v = tris[i, :, 2]
        if v.min() <= z + thickness and v.max() >= z - thickness:
            for j in range(3):
                pts.append(tris[i, j])
    if not pts:
        print(f"  {frac*100:.0f}% — no geometry found")
        continue
    pts = np.array(pts)
    # X=fwd (axis 0), Y=lat (axis 1)
    x_span = (pts[:, 0].max() - pts[:, 0].min()) * 1000  # depth (fwd/back)
    y_span = (pts[:, 1].max() - pts[:, 1].min()) * 1000  # width (lateral)
    section_dims[frac] = {"width_mm": y_span, "depth_mm": x_span}
    print(f"\n  {frac*100:.0f}% height  (Z={z*1000:.0f}mm)")
    print(f"    Width (Y lateral) : {y_span:.1f}mm")
    print(f"    Depth (X fwd/back): {x_span:.1f}mm")

# ── Waist-to-chest ratio ──────────────────────────────────────────────────────

print("\n╔══════════════════════════════════════════════════════╗")
print("║              WAIST-TO-CHEST RATIO ANALYSIS          ║")
print("╚══════════════════════════════════════════════════════╝")

if 0.15 in section_dims and 0.65 in section_dims:
    waist_w  = section_dims[0.15]["width_mm"]
    chest_w  = section_dims[0.65]["width_mm"]
    ratio    = waist_w / chest_w
    print(f"\n  Waist width  (15% height) : {waist_w:.1f}mm")
    print(f"  Chest width  (65% height) : {chest_w:.1f}mm")
    print(f"  Waist-to-chest ratio      : {ratio:.3f}")
    if ratio < 0.70:
        verdict = "DRAMATIC — hourglass more pronounced than athletic"
    elif ratio <= 0.80:
        verdict = "GOOD — athletic feminine build (target 0.70-0.80)"
    else:
        verdict = "MILD — ratio above target; waist cinch could be deeper"
    print(f"  Verdict: {verdict}")
else:
    print("  (could not compute ratio — missing slice data)")

print()
