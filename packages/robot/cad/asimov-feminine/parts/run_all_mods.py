"""Run all part modification scripts and produce a comprehensive report."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

def run_all():
    results = {}

    print("=" * 60)
    print("  ASIMOV-1 FEMININE MODIFICATION PIPELINE")
    print("=" * 60)

    import head_mods
    results.update(head_mods.run())

    import chest_mods
    results.update(chest_mods.run())

    import arms_mods
    results.update(arms_mods.run())

    import legs_mods
    results.update(legs_mods.run())

    print("\n" + "=" * 60)
    print("  SUMMARY: ALL MODIFICATIONS")
    print("=" * 60)
    print(f"\n{'Part':<35} {'Before X×Y':>14} {'After X×Y':>14} {'ΔX%':>6} {'ΔY%':>6}")
    print("-" * 80)

    for part, r in sorted(results.items()):
        bx, by = r['before']['x'], r['before']['y']
        ax, ay = r['after']['x'], r['after']['y']
        dx, dy = r['delta_x_pct'], r['delta_y_pct']
        print(f"  {part:<33} {bx:>6.0f}×{by:<6.0f}  {ax:>6.0f}×{ay:<6.0f}  {dx:>+5.1f}  {dy:>+5.1f}")

    # Write report
    report_path = Path(__file__).parent.parent / "reports/modifications_v1.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(results, indent=2))
    print(f"\nReport written → {report_path}")
    print("\nNext: open viewer.html to review, then run promote_modifications.py --apply")
    return results

if __name__ == "__main__":
    # Parts scripts expect to be imported from their own dir
    parts_dir = Path(__file__).parent
    sys.path.insert(0, str(parts_dir))
    run_all()
