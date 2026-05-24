"""Wave 10 — Armor details + limb slimming.

Visual review after Wave 9:
  ✓ Front hourglass: excellent (WHR 0.59)
  ✓ Side breast+arch: matches Saffron Sentinel closely
  ✗ Ankles barely slimmed (-8-10%), still look blocky
  ✗ HIP_ROLL barely changed (-8%), needs thinning
  ✗ KNEE: plain boxy shape, no armored kneecap character
  ✗ HIP_PITCH: -2% only, misses opportunity for hip armor plate styling

Wave 10 changes:
  1. Ankles: -20% more (ANKLE_A, ANKLE_B) — slender ankle joints
  2. HIP_ROLL: -14% more — lean hip roll housings
  3. KNEE: add kneecap forward protrusion (+10mm armor plate)
     + -8% further lateral slim
  4. HIP_PITCH: add lateral "hip plate" flare on outer half → armored hip look
     (expand lateral outer extent for assembled hip width visual)
  5. NECK_PITCH: -8% more
  6. SHOULDER_PITCH: add slight forward "pauldron forward edge" protrusion
     for armored shoulder character

All ops incremental from current modified meshes.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from modify_mesh import modify

ORIG = Path(__file__).parent.parent / "originals"
CURR = Path(__file__).resolve().parent.parent.parent.parent / "assets/profiles/asimov-1/meshes"
OUT  = Path(__file__).parent.parent / "output/modified"
OUT.mkdir(parents=True, exist_ok=True)

print("\n" + "="*70)
print("  WAVE 10 — ARMOR DETAILS + LIMB SLIMMING")
print("="*70)

# ── 1. Ankle joints: -20% XY (from current) ───────────────────────────────
print("\n[1] Ankles — slender (-20% XY)")
for side in ["LEFT", "RIGHT"]:
    for part in ["ANKLE_A", "ANKLE_B"]:
        name = f"{side}_{part}.STL"
        r = modify(str(CURR / name), str(OUT / name), [
            {"op": "scale", "sx": 0.80, "sy": 0.80, "sz": 1.0},
        ])
        bef, aft = r["before"], r["after"]
        print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 2. HIP_ROLL: -14% XY (from current) ───────────────────────────────────
print("\n[2] HIP_ROLL — lean hip roll housing (-14%)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_HIP_ROLL.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 0.86, "sy": 0.86, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 3. KNEE: armored kneecap + lateral slim ────────────────────────────────
print("\n[3] KNEES — kneecap armor plate + -8% lateral")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_KNEE.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        # Slim lateral (Y) further
        {"op": "scale", "sx": 1.0, "sy": 0.92, "sz": 1.0},
        # Add kneecap: forward protrusion (+10mm) at mid-height of knee joint
        # KNEE part Z runs ~370mm (full upper-leg). The kneecap is at ~50-70% height.
        {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
         "up_frac_lo": 0.40, "up_frac_hi": 0.65,
         "bulge_max": 0.010, "falloff": 2.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f}×{bef['z']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}×{aft['z']:.0f}mm")

# ── 4. HIP_PITCH: hip armor plate styling ─────────────────────────────────
# HIP_PITCH sits at ±116mm from robot center (lateral position).
# Expanding its Y (already at 97mm) gives a wider hip armor plate silhouette.
# Rebuild from originals with X compression + Y armor plate expansion.
print("\n[4] HIP_PITCH — hip armor plate (wider Y, slimmer X)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_HIP_PITCH.STL"
    r = modify(str(ORIG / name), str(OUT / name), [
        # Slim front-to-back (X) for lean profile
        {"op": "scale", "sx": 0.85, "sy": 1.0, "sz": 1.0},
        # Expand lateral Y by 8% → armored hip plate silhouette
        {"op": "scale", "sx": 1.0, "sy": 1.08, "sz": 1.0},
        # Armor plate forward edge: small protrusion on outer face
        {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
         "up_frac_lo": 0.20, "up_frac_hi": 0.80,
         "bulge_max": 0.006, "falloff": 2.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 5. NECK_PITCH: slimmer (-8% more) ─────────────────────────────────────
print("\n[5] NECK_PITCH — slimmer (-8%)")
r = modify(str(CURR / "NECK_PITCH.STL"), str(OUT / "NECK_PITCH.STL"), [
    {"op": "scale", "sx": 0.92, "sy": 0.92, "sz": 1.0},
])
bef, aft = r["before"], r["after"]
print(f"  NECK_PITCH: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 6. SHOULDER_PITCH: forward pauldron edge protrusion ──────────────────
# The shoulder pitch is the largest shoulder piece. Adding a slight forward
# protrusion gives the "armored pauldron" character visible from the side.
print("\n[6] SHOULDER_PITCH — pauldron forward edge (+6mm)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_SHOULDER_PITCH.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        # Slight forward protrusion on upper 60% (shoulder plate face)
        {"op": "add_bulge", "axis_fwd": 0, "axis_up": 2,
         "up_frac_lo": 0.35, "up_frac_hi": 0.95,
         "bulge_max": 0.006, "falloff": 2.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

print("\n" + "="*70)
print("  Wave 10 done. Promote: cp output/modified/*.STL assets/.../meshes/")
print("="*70)
