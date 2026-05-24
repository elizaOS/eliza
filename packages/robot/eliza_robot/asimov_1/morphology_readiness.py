"""Proof readiness matrix for ASIMOV-1 morphology parameters."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.morphology_parameters import morphology_parameter_catalog
from eliza_robot.asimov_1.parametric_inventory import (
    ASIMOV_PARAM_PROOFS,
    collect_asimov1_parametric_inventory,
)


def _mujoco_load_proofs(proof_root: Path) -> set[str]:
    proof_path = proof_root / "mujoco-load.json"
    if not proof_path.is_file():
        return set()
    try:
        raw = json.loads(proof_path.read_text(encoding="utf-8"))
    except Exception:
        return set()
    if raw.get("schema") != "asimov-1-mujoco-load-proof-v1" or not raw.get("ok"):
        return set()
    links = raw.get("links")
    if not isinstance(links, list):
        return set()
    return {str(link).upper() for link in links}


def collect_morphology_parameter_proof_matrix(
    *,
    inventory: dict[str, Any] | None = None,
    proof_root: Path | None = None,
) -> dict[str, Any]:
    """Report whether each morphology parameter is safe to expose.

    A parameter is geometry-ready only when every affected link has the spline,
    interface, topology, and source/output surface-distance proofs. It is usable
    only after those geometry proofs and a MuJoCo load proof are both present.
    """
    catalog = morphology_parameter_catalog()
    inventory = inventory or collect_asimov1_parametric_inventory()
    if proof_root is None:
        proof_root = ASIMOV_PARAM_PROOFS
    mujoco_links = _mujoco_load_proofs(proof_root)

    link_records = {
        str(record.get("link", "")).upper(): record
        for record in inventory.get("records", [])
        if isinstance(record, dict)
    }
    parameter_records: list[dict[str, Any]] = []
    for parameter in catalog["parameters"]:
        affected_links = [str(link).upper() for link in parameter["affected_links"]]
        link_evidence = []
        for link in affected_links:
            record = link_records.get(link)
            proof = {
                "link": link,
                "known_link": bool(record),
                "spline_fit": bool(record and record.get("spline_fit_proven")),
                "interface_preservation": bool(record and record.get("interface_proven")),
                "topology": bool(record and record.get("topology_proven")),
                "surface_distance": bool(record and record.get("surface_distance_proven")),
                "mujoco_load": link in mujoco_links,
                "proven_against_step": bool(record and record.get("proven_against_step")),
            }
            missing = [
                name
                for name in parameter["proof_requirements"]
                if not proof.get(name, False)
            ]
            proof["missing"] = missing
            proof["ok"] = not missing
            link_evidence.append(proof)

        geometry_ready = bool(link_evidence) and all(
            evidence["spline_fit"]
            and evidence["interface_preservation"]
            and evidence["topology"]
            and evidence["surface_distance"]
            for evidence in link_evidence
        )
        mujoco_ready = bool(link_evidence) and all(
            evidence["mujoco_load"] for evidence in link_evidence
        )
        step_ready = bool(link_evidence) and all(
            evidence["proven_against_step"] for evidence in link_evidence
        )
        missing_links = [evidence["link"] for evidence in link_evidence if not evidence["ok"]]
        parameter_records.append(
            {
                "name": parameter["name"],
                "group": parameter["group"],
                "affected_link_count": len(affected_links),
                "geometry_ready": geometry_ready,
                "mujoco_ready": mujoco_ready,
                "step_ready": step_ready,
                "usable": bool(geometry_ready and mujoco_ready and step_ready),
                "missing_link_count": len(missing_links),
                "missing_links": missing_links,
                "link_evidence": link_evidence,
            }
        )

    usable = sum(1 for record in parameter_records if record["usable"])
    geometry_ready = sum(1 for record in parameter_records if record["geometry_ready"])
    return {
        "schema": "asimov-1-morphology-parameter-proof-matrix-v1",
        "ok": usable == len(parameter_records) and bool(parameter_records),
        "counts": {
            "parameters": len(parameter_records),
            "geometry_ready": geometry_ready,
            "mujoco_ready": sum(1 for record in parameter_records if record["mujoco_ready"]),
            "step_ready": sum(1 for record in parameter_records if record["step_ready"]),
            "usable": usable,
            "blocked": len(parameter_records) - usable,
        },
        "records": parameter_records,
    }


def dump_morphology_parameter_proof_matrix_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"
