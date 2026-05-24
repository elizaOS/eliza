"""Wave 13 — Structural minimum push on leg joints.

After Wave 12 (arm/neck refined to match Saffron Sentinel):
  - Torso: excellent, arms: excellent
  - HIP_YAW: 89mm Y (-22%) — thigh housing can reach -27% safely
  - KNEE: 77mm Y (-24%) — can reach -29% (matches elbow at -29%)
  - HIP_ROLL: 42mm Y (-21%) — can reach -26% (matches ankle level)
  - SHOULDER_YAW: 46mm Y (-28%) — fine as-is
  - SHOULDER_ROLL: 65mm Y (-35%) — fine as-is

Target: push leg joints to structural minimum ~28-30% reduction,
consistent with what the arm joints already achieve.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from modify_mesh import modify

CURR = Path(__file__).resolve().parent.parent.parent.parent / "assets/profiles/asimov-1/meshes"
OUT  = Path(__file__).parent.parent / "output/modified"
OUT.mkdir(parents=True, exist_ok=True)

print("\n" + "="*70)
print("  WAVE 13 — STRUCTURAL MINIMUM — LEG JOINTS")
print("="*70)

# ── 1. HIP_YAW: -5% Y (thigh housing: 89 → ~85mm, total -26%) ────────────
print("\n[1] HIP_YAW — thigh to structural min (-5% lateral)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_HIP_YAW.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 1.0, "sy": 0.95, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 2. KNEE: -5% Y (knee housing: 77 → ~73mm, total -28%) ────────────────
print("\n[2] KNEE — slim knee housing (-5% lateral)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_KNEE.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 1.0, "sy": 0.95, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 3. HIP_ROLL: -5% XY (hip roll housing: 57×42 → ~54×40mm, total -24%) ─
print("\n[3] HIP_ROLL — slim hip roll joint (-5% XY)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_HIP_ROLL.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 0.95, "sy": 0.95, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

# ── 4. ANKLE_A: -5% XY (already very slim but -5% more to match B) ───────
print("\n[4] ANKLE_A — match ankle B slimness (-5% XY)")
for side in ["LEFT", "RIGHT"]:
    name = f"{side}_ANKLE_A.STL"
    r = modify(str(CURR / name), str(OUT / name), [
        {"op": "scale", "sx": 0.95, "sy": 0.95, "sz": 1.0},
    ])
    bef, aft = r["before"], r["after"]
    print(f"  {name}: {bef['x']:.0f}×{bef['y']:.0f} → {aft['x']:.0f}×{aft['y']:.0f}mm")

print("\n" + "="*70)
print("  Wave 13 done.")
print("="*70)
