"""Wave 6 — Shoulder/hip ratio fix.

Current state after Wave 5:
  Assembled shoulder: 2 × (96.5 + 35.0) = 263mm
  Assembled hip:      2 × (67.5 + 44.4) = 224mm
  S/H ratio:          1.175  (target ≤1.15)

Two changes:
  1. SHOULDER_PITCH Y: 117mm original → 65mm  (sy=0.557, was 0.60 → 70mm)
     Assembled shoulder: 2 × (96.5 + 32.5) = 258mm
  2. HIP_PITCH Y: 99mm original → 94mm  (sy=0.949, was 0.90 → 89mm)
     Assembled hip: 2 × (67.5 + 47.0) = 229mm

After Wave 6:
  S/H ratio: 258 / 229 = 1.126  ✓ (target ≤1.15)
  Wider hips also improve WHR from the pelvis view.
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
print("  WAVE 6 — SHOULDER/HIP RATIO FIX")
print("="*70)
print(f"\n  {'Part':<35}  {'Before X×Y':>12}     {'After X×Y':>12}  ΔX     ΔY")
print("  " + "-"*65)

# 1. SHOULDER_PITCH: further Y reduction to 65mm (sy=0.557 from 117mm original)
#    Wave 5 was sy=0.60 → 70mm. Now push to 65mm to narrow assembled shoulder.
for side in ["LEFT", "RIGHT"]:
    do(f"{side}_SHOULDER_PITCH.STL", [
        {"op": "scale", "sx": 0.92, "sy": 0.557, "sz": 1.0},
    ])

# 2. HIP_PITCH: restore Y to 94mm (sy=0.949 from 99mm original)
#    Wave 4 over-slimmed to 89mm (sy=0.90). Wider hips = more feminine.
for side in ["LEFT", "RIGHT"]:
    do(f"{side}_HIP_PITCH.STL", [
        {"op": "scale", "sx": 0.90, "sy": 0.949, "sz": 1.0},
    ])

print("\n" + "="*70)
print("\nAssembled width estimates after Wave 6:")
sp = RESULTS.get("LEFT_SHOULDER_PITCH.STL", {})
hp = RESULTS.get("LEFT_HIP_PITCH.STL", {})
if sp and hp:
    sp_y = sp["after"]["y"]
    hp_y = hp["after"]["y"]
    shoulder = 2 * (96.5 + sp_y / 2)
    hip = 2 * (67.5 + hp_y / 2)
    print(f"  Assembled shoulder: 2 × (96.5 + {sp_y/2:.1f}) = {shoulder:.0f}mm")
    print(f"  Assembled hip:      2 × (67.5 + {hp_y/2:.1f}) = {hip:.0f}mm")
    print(f"  S/H ratio:          {shoulder/hip:.3f}  (target ≤1.15)")
