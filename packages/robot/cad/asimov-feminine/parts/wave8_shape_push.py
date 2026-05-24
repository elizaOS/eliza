"""Wave 8 — Dramatic shape push.

Assessment after Wave 7:
  - Breast protrusion: only +18mm at peak (target: 45–55mm)
  - add_bulge pushes whole chest forward uniformly — no distinct mounds
  - Waist cinch at 42%: Y dropped 236→138mm (good), X also dropped 98→73mm (helps side profile)
  - Back arch: 30mm (needs 35mm)
  - Limbs: can go another round of slimming

Wave 8 changes:
  1. WAIST_YAW: rebuild from originals with:
       - Deeper waist cinch (0.65 scale, more pinch)
       - add_split_bulge: two 50mm breast mounds at ±32mm lateral offset
       - add_bulge: 20mm background chest roundness
       - back_arch: 38mm
       - hip flare: 1.14× (slightly more)
       - upper taper: 0.82× shoulder (tighter)
  2. Arms (from current): SHOULDER_ROLL/YAW -8% more lateral
  3. NECK_PITCH: -6% more
  4. KNEE: -6% more lateral
  5. WRIST_YAW: -8% more

All limb ops are applied to the CURRENT modified mesh (incremental).
WAIST_YAW is rebuilt from originals (idempotent, full op list).
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
print("  WAVE 8 — DRAMATIC SHAPE PUSH")
print("="*70)

# ── 1. WAIST_YAW — complete rebuild from originals ─────────────────────────
print("\n[1] WAIST_YAW — from originals")
r = modify(str(ORIG / "WAIST_YAW.STL"), str(OUT / "WAIST_YAW.STL"), [
    # Waist cinch: lateral + depth pinch (side silhouette drama)
    # Tighter than Wave 7 (was 0.72), band slightly narrower (cleaner waist)
    {"op": "cinch_waist", "axis_long": 2, "waist_frac": 0.42,
     "cinch_scale": 0.65, "band_width": 0.26},

    # Global lateral compression (slightly tighter than Wave 7's 0.76)
    {"op": "scale", "sx": 1.0, "sy": 0.72, "sz": 1.0},

    # PRIMARY breast shape: split dual mounds, 50mm protrusion
    # After global scale: WAIST_YAW Y span ≈ 180mm → ±90mm.
    # Mounds centered at ±32mm from lateral center, 36mm sigma each.
    # Height band: 52–88% of torso height (≈ 195–332mm above pelvis).
    {"op": "add_split_bulge", "axis_fwd": 0, "axis_up": 2, "axis_lat": 1,
     "up_frac_lo": 0.52, "up_frac_hi": 0.88,
     "lat_offset": 0.032, "lat_sigma": 0.036,
     "bulge_max": 0.050, "falloff": 2.0},

    # SECONDARY: background chest roundness (whole front chest pushed forward)
    # This fills in the valley between the mounds and adds depth to the chest plate.
    {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.55, "up_frac_hi": 0.85,
     "bulge_max": 0.020, "falloff": 2.5},

    # TERTIARY: concentrated peak at 65–80% (breast apex, tighter band)
    {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.63, "up_frac_hi": 0.80,
     "bulge_max": 0.012, "falloff": 1.8},

    # Shoulder region lateral compression (upper 38%)
    {"op": "scale_axis_range", "axis": 2, "scale": 0.82,
     "lo_frac": 0.62, "hi_frac": 1.0},

    # Hip junction flare (bottom 20%): 1.14× → wider pelvis connection
    {"op": "flare_hips", "axis_lat": 1, "axis_up": 2,
     "frac_lo": 0.0, "frac_hi": 0.20, "flare_scale": 1.14},

    # Back arch: 38mm lordotic pull (stronger than Wave 7's 30mm)
    {"op": "back_arch", "axis_fwd": 0, "axis_up": 2,
     "up_frac_lo": 0.02, "up_frac_hi": 0.42, "arch_pull": 0.038},

    # Lower torso taper
    {"op": "scale_axis_range", "axis": 2, "scale": 0.93,
     "lo_frac": 0.0, "hi_frac": 0.25},
])
bef, aft = r["before"], r["after"]
print(f"  {bef['x']:.0f}×{bef['y']:.0f}×{bef['z']:.0f}mm  →  {aft['x']:.0f}×{aft['y']:.0f}×{aft['z']:.0f}mm")
print(f"  ΔX={r['delta_x_pct']:+.1f}%  ΔY={r['delta_y_pct']:+.1f}%")

# ── 2. IMU_ORIGIN — keep wave5 result (hip flare intentional) ──────────────
# Already at 191.7mm Y (pelvis wider than waist). No further changes needed.

# ── 3. Arms: additional -8% lateral from current modified state ───────────
print("\n[3] Arms — incremental -8% lateral")
for side in ["LEFT", "RIGHT"]:
    for part in ["SHOULDER_ROLL", "SHOULDER_YAW"]:
        name = f"{side}_{part}.STL"
        r = modify(str(CURR / name), str(OUT / name), [
            {"op": "scale", "sx": 0.92, "sy": 0.92, "sz": 1.0},
        ])
        bef, aft = r["before"], r["after"]
        print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# Elbows: additional -6% lateral
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_ELBOW.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 0.94, "sy": 0.94, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# Wrists: additional -8%
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_WRIST_YAW.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 0.92, "sy": 0.92, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 4. NECK_PITCH — additional -6% ────────────────────────────────────────
print("\n[4] Neck — incremental -6%")
r = modify(str(CURR / "NECK_PITCH.STL"), str(OUT / "NECK_PITCH.STL"), [
    {"op": "scale", "sx": 0.94, "sy": 0.94, "sz": 1.0},
])
bef, aft = r["before"], r["after"]
print(f"  NECK_PITCH: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 5. KNEE — additional -6% lateral ─────────────────────────────────────
print("\n[5] Knees — incremental -6% lateral")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_KNEE.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 0.94, "sy": 0.94, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 6. TOE — additional -6% (slender feet) ───────────────────────────────
print("\n[6] Toes — incremental -6%")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_TOE.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 0.94, "sy": 0.94, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

print("\n" + "="*70)
print("  Wave 8 output written to output/modified/")
print("  Run promote step: cp output/modified/*.STL assets/profiles/asimov-1/meshes/")
print("="*70)
