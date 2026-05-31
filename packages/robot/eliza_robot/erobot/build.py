"""End-to-end erobot generator.

Regenerates every artifact from the parametric spec, in dependency order:

    spec -> MJCF + scene -> URDF -> profile.yaml -> BOM -> mating -> proofs

Run with ``python -m eliza_robot.erobot.build`` (or ``--check`` to fail the
process if any proof fails — used by CI / the pytest shim).
"""

from __future__ import annotations

import argparse
import sys

from eliza_robot.erobot import bom, mating, mjcf, profile, urdf, validate
from eliza_robot.erobot.mass import compute_budget
from eliza_robot.erobot.spec import build_spec


def build_all() -> dict:
    spec = build_spec()
    budget = compute_budget(spec)

    models = mjcf.write_models(spec)
    urdf_path = urdf.write_urdf(spec)
    profile_path = profile.write_profile(spec)
    bom_paths = bom.write_bom_files(spec)
    mating_path = mating.write_mating_proof(spec)
    proofs = validate.run_all(spec)

    bom_data = bom.bom_json(spec)
    return {
        "spec": {
            "dof": spec.dof,
            "bodies": len(spec.bodies),
            "standing_height_m": round(spec.standing_height_m, 3),
            "total_mass_kg": round(budget.total_mass_kg, 2),
        },
        "artifacts": {
            "mjcf": str(models["robot"]),
            "scene": str(models["scene"]),
            "urdf": str(urdf_path),
            "profile": str(profile_path),
            "bom": {k: str(v) for k, v in bom_paths.items()},
            "mating": str(mating_path),
            "kinematic_tree": proofs["kinematic_tree"],
            "proofs": proofs["paths"],
        },
        "bom_totals": bom_data["totals"],
        "proofs_ok": proofs["proofs"],
        "ok": proofs["ok"],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate + validate erobot.")
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if any proof fails")
    args = ap.parse_args(argv)

    result = build_all()
    s = result["spec"]
    print(f"erobot — {s['dof']} DoF, {s['bodies']} bodies, "
          f"{s['standing_height_m']} m, {s['total_mass_kg']} kg")
    print(f"  BOM: ${result['bom_totals']['cost_qty1_usd']:,} @ qty1  /  "
          f"${result['bom_totals']['cost_qty1000_usd_per_unit']:,}/unit @ qty1000  "
          f"(+${result['bom_totals']['tooling_capex_usd']:,} tooling)")
    print("  proofs:")
    for name, ok in result["proofs_ok"].items():
        print(f"    [{'PASS' if ok else 'FAIL'}] {name}")
    print(f"  overall: {'PASS' if result['ok'] else 'FAIL'}")

    if args.check and not result["ok"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
