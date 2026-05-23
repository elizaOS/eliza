"""Wave 12 — Arm, neck, and thigh finishing pass.

After Wave 11 full-body review vs Saffron Sentinel GLB:
  ✓ Torso/chest: excellent — matches Sentinel side profile closely
  ✓ Ankles: very slim
  ✓ Elbow/wrist: good
  ✗ SHOULDER_ROLL: 72mm Y — largest remaining arm bulk, visible from front
  ✗ NECK_PITCH: 128×105mm — wide neck-chest transition
  ✗ NECK_YAW: 55×47mm — can trim further
  ✗ HIP_YAW: 94mm — -5% more for slightly more gracile thigh
  ✗ WRIST_YAW: 29mm — trim to delicate wrist

All ops incremental from current live meshes (CURR).
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from modify_mesh import modify

CURR = Path(__file__).resolve().parent.parent.parent.parent / "assets/profiles/asimov-1/meshes"
OUT  = Path(__file__).parent.parent / "output/modified"
OUT.mkdir(parents=True, exist_ok=True)

print("\n" + "="*70)
print("  WAVE 12 — ARM / NECK / THIGH FINISHING")
print("="*70)

# ── 1. SHOULDER_ROLL: -10% XY (upper arm housing, most visible arm bulk) ──
print("\n[1] SHOULDER_ROLL — slim upper arm (-10% XY)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_SHOULDER_ROLL.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 0.90, "sy": 0.90, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 2. NECK_PITCH: -8% XY (wide neck-chest transition) ───────────────────
print("\n[2] NECK_PITCH — slimmer neck-chest joint (-8% XY)")
r = modify(str(CURR / "NECK_PITCH.STL"), str(OUT / "NECK_PITCH.STL"), [
    {"op": "scale", "sx": 0.92, "sy": 0.92, "sz": 1.0},
])
bef, aft = r["before"], r["after"]
print(f"  NECK_PITCH: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 3. NECK_YAW: -8% XY (slim neck joint) ────────────────────────────────
print("\n[3] NECK_YAW — slim neck (-8% XY)")
r = modify(str(CURR / "NECK_YAW.STL"), str(OUT / "NECK_YAW.STL"), [
    {"op": "scale", "sx": 0.92, "sy": 0.92, "sz": 1.0},
])
bef, aft = r["before"], r["after"]
print(f"  NECK_YAW: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 4. HIP_YAW: -5% Y (slightly more gracile thigh) ─────────────────────
print("\n[4] HIP_YAW — gracile thigh (-5% lateral)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_HIP_YAW.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 1.0, "sy": 0.95, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 5. WRIST_YAW: -8% XY (delicate wrist) ────────────────────────────────
print("\n[5] WRIST_YAW — delicate wrist (-8% XY)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_WRIST_YAW.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 0.92, "sy": 0.92, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

print("\n" + "="*70)
print("  Wave 12 done.")
print("="*70)
