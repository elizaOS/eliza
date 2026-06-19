"""End-to-end erobot generator.

Regenerates every artifact from the parametric spec, in dependency order:

    spec -> MJCF + scene -> URDF -> profile.yaml -> BOM -> components
         -> geometry/mate/mechanical/physical proofs -> visual renders

Run with ``python -m eliza_robot.erobot.build`` (``--check`` fails the process
if any proof fails; ``--no-visual`` skips the GL renders for headless CI).
"""

from __future__ import annotations

import argparse
import sys

from eliza_robot.erobot import (
    analysis,
    assembly,
    bom,
    mating,
    mjcf,
    profile,
    transmission,
    urdf,
    validate,
)
from eliza_robot.erobot.mass import compute_budget
from eliza_robot.erobot.spec import build_spec


def build_all(*, visual: bool = True) -> dict:
    spec = build_spec()
    budget = compute_budget(spec)

    models = mjcf.write_models(spec)
    urdf_path = urdf.write_urdf(spec)
    profile_path = profile.write_profile(spec)
    bom.write_bom_files(spec)
    mating.write_mating_proof(spec)

    # geometry + mate + mechanical proofs
    manifold = assembly.manifold_proof(spec)
    internal = assembly.internal_proof(spec)
    assembly.write_proofs(spec)
    mate = mating.build_mate_verification(spec)
    mating.write_mate_verification(spec)
    mech = analysis.mechanical_analysis(spec)
    analysis.write_analysis(spec)
    trans = transmission.transmission_proof(spec)
    transmission.write_proof(spec)

    # detailed mechanism subsystems (feet/knee/hips/waist/shoulders): named parts,
    # mates, and proven rotation
    import json as _json

    from eliza_robot.erobot.subsystems import PROOFS_ROOT as _SUB_ROOT
    from eliza_robot.erobot.subsystems import prove_all as _subsystems_prove_all
    subs = _subsystems_prove_all()
    _SUB_ROOT.mkdir(parents=True, exist_ok=True)
    (_SUB_ROOT / "subsystems.json").write_text(_json.dumps(subs, indent=2) + "\n", encoding="utf-8")

    # physical (MuJoCo) proofs + kinematic tree
    physical = validate.run_all(spec)

    proofs_ok = {
        "manifold": manifold["ok"],
        "internal-collision": internal["ok"],
        "mate-verification": mate["ok"],
        "mechanical-analysis": mech["ok"],
        "transmission": trans["ok"],
        "subsystems": subs["ok"],
        **physical["proofs"],
    }

    visual_paths: dict[str, str] = {}
    if visual:
        try:
            from eliza_robot.erobot import render
            visual_paths = {k: str(v) for k, v in render.render_all(spec).items()}
        except Exception as exc:  # rendering needs a GL context; never gates the build
            visual_paths = {"error": f"{type(exc).__name__}: {exc}"}

    bom_data = bom.bom_json(spec)
    return {
        "spec": {
            "dof": spec.dof,
            "bodies": len(spec.bodies),
            "parts_checked": manifold["parts_checked"],
            "components": internal["components"],
            "standing_height_m": round(spec.standing_height_m, 3),
            "total_mass_kg": round(budget.total_mass_kg, 2),
        },
        "artifacts": {
            "mjcf": str(models["robot"]),
            "scene": str(models["scene"]),
            "urdf": str(urdf_path),
            "profile": str(profile_path),
            "kinematic_tree": physical["kinematic_tree"],
            "visual": visual_paths,
        },
        "bom_totals": bom_data["totals"],
        "subsystem_totals": {
            "unique_parts": subs.get("total_unique_parts", 0),
            "mates": subs.get("total_mates", 0),
            "articulated_dofs": subs.get("total_articulated_dofs", 0),
        },
        "proofs_ok": proofs_ok,
        "ok": all(proofs_ok.values()),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate + validate erobot.")
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if any proof fails")
    ap.add_argument("--no-visual", action="store_true",
                    help="skip the GL renders (headless CI)")
    args = ap.parse_args(argv)

    result = build_all(visual=not args.no_visual)
    s = result["spec"]
    print(f"erobot — {s['dof']} DoF, {s['bodies']} bodies, {s['parts_checked']} parts, "
          f"{s['components']} internal components, {s['standing_height_m']} m, {s['total_mass_kg']} kg")
    print(f"  BOM: ${result['bom_totals']['cost_qty1_usd']:,} @ qty1  /  "
          f"${result['bom_totals']['cost_qty1000_usd_per_unit']:,}/unit @ qty1000  "
          f"(+${result['bom_totals']['tooling_capex_usd']:,} tooling)")
    st = result["subsystem_totals"]
    print(f"  subsystems: {st['unique_parts']} named mechanism parts, {st['mates']} mates, "
          f"{st['articulated_dofs']} proven-rotation DOFs")
    print("  proofs:")
    for name, ok in result["proofs_ok"].items():
        print(f"    [{'PASS' if ok else 'FAIL'}] {name}")
    print(f"  overall: {'PASS' if result['ok'] else 'FAIL'}")

    if args.check and not result["ok"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
