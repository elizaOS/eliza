"""Detailed mechanism subsystems for erobot.

Each module (`feet`, `knee`, `hips`, `waist`, `shoulders`) builds a
:class:`~eliza_robot.erobot.subsystems.base.Subsystem` of named mechanical parts
+ mates + DOFs and proves it (manifold + mate consistency + rotation without
collision). :func:`prove_all` aggregates them for the build orchestrator.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

SUBSYSTEM_MODULES = ("feet", "knee", "hips", "waist", "shoulders")
PROOFS_ROOT = Path(__file__).resolve().parents[3] / "cad" / "erobot" / "proofs"


def prove_all() -> dict:
    results: dict[str, dict] = {}
    for name in SUBSYSTEM_MODULES:
        try:
            mod = importlib.import_module(f"eliza_robot.erobot.subsystems.{name}")
            results[name] = mod.proof()
        except Exception as exc:  # missing/broken subsystem must surface, not crash the build
            results[name] = {"ok": False, "subsystem": name,
                             "error": f"{type(exc).__name__}: {exc}"}
    total_parts = sum(r.get("part_count", 0) for r in results.values())
    total_mates = sum(r.get("mate_count", 0) for r in results.values())
    total_dofs = sum(r.get("dof_count", 0) for r in results.values())
    return {
        "schema": "erobot-subsystems-v1",
        "ok": all(r.get("ok") for r in results.values()),
        "total_unique_parts": total_parts,
        "total_mates": total_mates,
        "total_articulated_dofs": total_dofs,
        "subsystems": results,
    }


def write_proof() -> Path:
    PROOFS_ROOT.mkdir(parents=True, exist_ok=True)
    out = PROOFS_ROOT / "subsystems.json"
    out.write_text(json.dumps(prove_all(), indent=2) + "\n", encoding="utf-8")
    return out


if __name__ == "__main__":
    p = prove_all()
    print(f"subsystems ok={p['ok']}  parts={p['total_unique_parts']} "
          f"mates={p['total_mates']} dofs={p['total_articulated_dofs']}")
    for name, r in p["subsystems"].items():
        if "error" in r:
            print(f"  [ERR ] {name}: {r['error']}")
        else:
            rot = ",".join(str(x.get("collision_free_fraction")) for x in r.get("rotation", []))
            print(f"  [{'PASS' if r['ok'] else 'FAIL'}] {name}: "
                  f"{r.get('unique_parts')} parts, {r.get('mate_count')} mates, "
                  f"{r.get('dof_count')} DOF, rot-free=[{rot}]")
