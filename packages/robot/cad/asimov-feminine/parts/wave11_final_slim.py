"""Wave 11 — Final slimming push.

After 10 waves:
  - Torso/chest: excellent (hourglass 1.70×, breast +40.9mm, arch 40mm)
  - Arms: well slimmed (22-44% reductions)
  - Shoulders: armored pauldrons ✓
  - Hip plates: wider than original ✓ (armor)
  - Ankles: very slim (-26%) ✓

Remaining opportunities:
  - HIP_YAW: only -11.1% Y — the thigh is the largest leg segment and
    should be leaner for a more gracile leg silhouette (-8% more → total -18%)
  - TOE: X only -17% (front-to-back foot dimension) — slim -12% more
  - ANKLE_B: Y at -28%, X at -50% — push Y further (-10%)
  - IMU_ORIGIN: fine as-is (intentional hip flare)
  - SHOULDER_PITCH: already at -44% Y — do not push further (structural)
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from modify_mesh import modify

CURR = Path(__file__).resolve().parent.parent.parent.parent / "assets/profiles/asimov-1/meshes"
OUT  = Path(__file__).parent.parent / "output/modified"
OUT.mkdir(parents=True, exist_ok=True)

print("\n" + "="*70)
print("  WAVE 11 — FINAL SLIMMING PUSH")
print("="*70)

# ── 1. HIP_YAW thigh: -8% more lateral (thinner, gracile thighs) ─────────
print("\n[1] HIP_YAW — lean thighs (-8% lateral)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_HIP_YAW.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 1.0, "sy": 0.92, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 2. TOE: slim X (foot length front-to-back) ────────────────────────────
print("\n[2] TOE — slender foot (-12% X, -8% Y)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_TOE.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 0.88, "sy": 0.92, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 3. ANKLE_B: -10% Y (lateral slim) ────────────────────────────────────
print("\n[3] ANKLE_B — slimmer lateral (-10%)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_ANKLE_B.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 1.0, "sy": 0.90, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 4. ELBOW: -8% more (already good but can push slightly) ──────────────
print("\n[4] ELBOW — additional -8%")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_ELBOW.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 0.92, "sy": 0.92, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

print("\n" + "="*70)
print("  Wave 11 done.")
print("="*70)
