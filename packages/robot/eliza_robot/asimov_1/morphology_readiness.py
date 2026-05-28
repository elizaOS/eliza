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


def _accepted_source_assignments(proof_root: Path) -> tuple[set[str], set[str], set[str]]:
    proof_path = proof_root / "fembot-link-source-assignments.json"
    if not proof_path.is_file():
        return set(), set(), set()
    try:
        raw = json.loads(proof_path.read_text(encoding="utf-8"))
    except Exception:
        return set(), set(), set()
    if raw.get("schema") != "asimov-fembot-link-source-assignment-v1":
        return set(), set(), set()
    accepted: set[str] = set()
    controlled_loft: set[str] = set()
    exact_brep: set[str] = set()
    for record in raw.get("link_assignments", []):
        if not isinstance(record, dict):
            continue
        link = str(record.get("link", "")).upper()
        if not link:
            continue
        if record.get("accepted"):
            accepted.add(link)
        if record.get("controlled_loft_assigned"):
            controlled_loft.add(link)
        if record.get("exact_brep_body_assigned"):
            exact_brep.add(link)
    return accepted, controlled_loft, exact_brep


def _parametric_supplier_vendor_status(
    proof_root: Path,
) -> tuple[set[str], set[str], set[str]]:
    proof_path = proof_root / "fembot-parametric-constraints.json"
    if not proof_path.is_file():
        return set(), set(), set()
    try:
        raw = json.loads(proof_path.read_text(encoding="utf-8"))
    except Exception:
        return set(), set(), set()
    if raw.get("schema") != "asimov-fembot-parametric-constraints-v1":
        return set(), set(), set()
    blocked: set[str] = set()
    bbox_ready: set[str] = set()
    production_blocked: set[str] = set()
    for record in raw.get("links", []):
        if not isinstance(record, dict):
            continue
        link = str(record.get("link", "")).upper()
        if not link:
            continue
        for constraint in record.get("constraints", []):
            if (
                isinstance(constraint, dict)
                and constraint.get("name") == "supplier_vendor_keepout_growth"
            ):
                if constraint.get("verified"):
                    bbox_ready.add(link)
                else:
                    blocked.add(link)
                if constraint.get("production_blocker"):
                    production_blocked.add(link)
    return blocked, bbox_ready, production_blocked


def collect_morphology_parameter_proof_matrix(
    *,
    inventory: dict[str, Any] | None = None,
    proof_root: Path | None = None,
) -> dict[str, Any]:
    """Report whether each morphology parameter is safe to expose.

    A parameter is geometry-ready only when every affected link has the spline,
    interface, topology, and source/output surface-distance proofs. It is usable
    only after those geometry proofs, an accepted source assignment, and a MuJoCo
    load proof are present. Exact STEP/B-rep readiness is reported separately.
    """
    catalog = morphology_parameter_catalog()
    inventory = inventory or collect_asimov1_parametric_inventory()
    if proof_root is None:
        proof_root = ASIMOV_PARAM_PROOFS
    mujoco_links = _mujoco_load_proofs(proof_root)
    accepted_source_links, controlled_loft_links, exact_brep_links = _accepted_source_assignments(
        proof_root
    )
    (
        supplier_vendor_blocked_links,
        supplier_vendor_bbox_ready_links,
        supplier_vendor_production_blocked_links,
    ) = _parametric_supplier_vendor_status(proof_root)

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
                "accepted_source": link in accepted_source_links,
                "accepted_controlled_loft_source": link in controlled_loft_links,
                "exact_brep_body_assigned": link in exact_brep_links,
                "proven_against_step": bool(record and record.get("proven_against_step")),
                "supplier_vendor_keepout_growth": link in supplier_vendor_blocked_links,
                "supplier_vendor_bbox_preview_fit": link in supplier_vendor_bbox_ready_links,
                "supplier_vendor_exact_pocket_blocked": (
                    link in supplier_vendor_production_blocked_links
                ),
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
        source_ready = bool(link_evidence) and all(
            evidence["accepted_source"] for evidence in link_evidence
        )
        exact_brep_ready = bool(link_evidence) and all(
            evidence["exact_brep_body_assigned"] for evidence in link_evidence
        )
        missing_links = [evidence["link"] for evidence in link_evidence if not evidence["ok"]]
        supplier_vendor_blocked = [
            evidence["link"]
            for evidence in link_evidence
            if evidence["supplier_vendor_keepout_growth"]
        ]
        supplier_vendor_bbox_ready = [
            evidence["link"]
            for evidence in link_evidence
            if evidence["supplier_vendor_bbox_preview_fit"]
        ]
        supplier_vendor_production_blocked = [
            evidence["link"]
            for evidence in link_evidence
            if evidence["supplier_vendor_exact_pocket_blocked"]
        ]
        parameter_records.append(
            {
                "name": parameter["name"],
                "group": parameter["group"],
                "affected_link_count": len(affected_links),
                "geometry_ready": geometry_ready,
                "mujoco_ready": mujoco_ready,
                "source_ready": source_ready,
                "step_ready": step_ready,
                "exact_brep_ready": exact_brep_ready,
                "usable": bool(geometry_ready and mujoco_ready and source_ready),
                "supplier_vendor_ready": not supplier_vendor_blocked,
                "supplier_vendor_blocked_link_count": len(supplier_vendor_blocked),
                "supplier_vendor_blocked_links": supplier_vendor_blocked,
                "supplier_vendor_bbox_preview_ready_link_count": len(
                    supplier_vendor_bbox_ready
                ),
                "supplier_vendor_bbox_preview_ready_links": supplier_vendor_bbox_ready,
                "supplier_vendor_exact_pocket_ready": not supplier_vendor_production_blocked,
                "supplier_vendor_exact_pocket_blocked_link_count": len(
                    supplier_vendor_production_blocked
                ),
                "supplier_vendor_exact_pocket_blocked_links": (
                    supplier_vendor_production_blocked
                ),
                "usable_with_exact_brep_source": bool(
                    geometry_ready and mujoco_ready and exact_brep_ready
                ),
                "missing_link_count": len(missing_links),
                "missing_links": missing_links,
                "link_evidence": link_evidence,
            }
        )

    usable = sum(1 for record in parameter_records if record["usable"])
    usable_with_exact_brep = sum(
        1 for record in parameter_records if record["usable_with_exact_brep_source"]
    )
    geometry_ready = sum(1 for record in parameter_records if record["geometry_ready"])
    supplier_vendor_ready = sum(
        1 for record in parameter_records if record["supplier_vendor_ready"]
    )
    supplier_vendor_exact_pocket_ready = sum(
        1 for record in parameter_records if record["supplier_vendor_exact_pocket_ready"]
    )
    return {
        "schema": "asimov-1-morphology-parameter-proof-matrix-v1",
        "ok": usable == len(parameter_records) and bool(parameter_records),
        "counts": {
            "parameters": len(parameter_records),
            "geometry_ready": geometry_ready,
            "mujoco_ready": sum(1 for record in parameter_records if record["mujoco_ready"]),
            "source_ready": sum(1 for record in parameter_records if record["source_ready"]),
            "step_ready": sum(1 for record in parameter_records if record["step_ready"]),
            "exact_brep_ready": sum(1 for record in parameter_records if record["exact_brep_ready"]),
            "usable": usable,
            "supplier_vendor_ready": supplier_vendor_ready,
            "supplier_vendor_blocked": len(parameter_records) - supplier_vendor_ready,
            "supplier_vendor_exact_pocket_ready": supplier_vendor_exact_pocket_ready,
            "supplier_vendor_exact_pocket_blocked": (
                len(parameter_records) - supplier_vendor_exact_pocket_ready
            ),
            "usable_with_exact_brep_source": usable_with_exact_brep,
            "blocked": len(parameter_records) - usable,
        },
        "records": parameter_records,
    }


def dump_morphology_parameter_proof_matrix_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"
