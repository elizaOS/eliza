"""Promote topology-clean generated STEP references for ASIMOV fembot links."""

from __future__ import annotations

import json
import shutil
import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.fembot_surface_quality import _load_stl_triangles
from eliza_robot.asimov_1.fembot_topology import (
    DEFAULT_TOPOLOGY_MERGE_TOLERANCE_M,
    _cad_python,
    _export_generated_step_meshes,
    build_fembot_topology_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_FEMININE_CAD_ROOT, ASIMOV_PARAM_PROOFS
from eliza_robot.asimov_1.spline_fit_proof import _prove_topology

FEMBOT_TOPOLOGY_PROMOTION_SCHEMA = "asimov-fembot-topology-promotion-v1"
DEFAULT_TOPOLOGY_PROMOTION_ROOT = (
    ASIMOV_FEMININE_CAD_ROOT / "output" / "generated-cad" / "topology-promoted-step"
)


def _safe_filename(value: str) -> str:
    return "".join(char.lower() if char.isalnum() else "_" for char in value).strip("_")


def _copy_step(source: Path, destination: Path) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return {
        "promoted_step_path": str(destination),
        "promoted_step_sha256": sha256_file(destination),
        "promoted_step_size_bytes": destination.stat().st_size,
    }


def _selection_records(
    *,
    topology_report: dict[str, Any],
    promotion_root: Path,
) -> list[dict[str, Any]]:
    repairs_by_link = {
        str(record.get("link", "")).upper(): record
        for record in topology_report.get("repair_preview_topology", [])
        if record.get("accepted")
        and record.get("envelope_preserved")
        and record.get("height_preserved")
        and record.get("repair_step")
    }
    records: list[dict[str, Any]] = []
    for topology in topology_report.get("link_topology", []):
        link = str(topology.get("link", "")).upper()
        if not link:
            continue
        repair = repairs_by_link.get(link)
        use_repair = bool(not topology.get("accepted") and repair)
        source_step = Path(str(repair["repair_step"] if use_repair else topology.get("source_step")))
        destination = promotion_root / f"{_safe_filename(link)}.step"
        copy_record = _copy_step(source_step, destination)
        records.append(
            {
                "link": link,
                "group": topology.get("group") or repair.get("group") if repair else topology.get("group"),
                "promotion_source": "repair_preview" if use_repair else "accepted_original_step",
                "source_step": str(source_step),
                "source_step_sha256": sha256_file(source_step) if source_step.is_file() else None,
                "source_topology_accepted": bool(topology.get("accepted")),
                "repair_preview_accepted": bool(repair and repair.get("accepted")),
                "repair_preview_envelope_preserved": bool(
                    repair and repair.get("envelope_preserved")
                ),
                "repair_preview_height_preserved": bool(
                    repair and repair.get("height_preserved")
                ),
                "expected_component_count": int(
                    repair.get("expected_component_count")
                    if use_repair
                    else topology.get("component_count") or topology.get("expected_component_count") or 1
                ),
                **copy_record,
            }
        )
    return sorted(records, key=lambda record: record["link"])


def _validate_promoted_meshes(
    records: list[dict[str, Any]],
    *,
    merge_tolerance_m: float,
    export_timeout_s: int,
) -> list[dict[str, Any]]:
    export_requests = [
        {
            "link": record["link"],
            "group": record.get("group") or "",
            "step_path": record["promoted_step_path"],
        }
        for record in records
    ]
    with tempfile.TemporaryDirectory(prefix="asimov-fembot-topology-promoted-") as tmp:
        mesh_exports = _export_generated_step_meshes(
            export_requests,
            output_dir=Path(tmp),
            cad_python=_cad_python(),
            timeout_s=export_timeout_s,
        )
        exports_by_link = {
            str(record.get("link", "")).upper(): record
            for record in mesh_exports.get("records", [])
        }
        validation: list[dict[str, Any]] = []
        for record in records:
            link = record["link"]
            export = exports_by_link.get(link)
            if not export or not export.get("export_ok"):
                validation.append(
                    {
                        "link": link,
                        "accepted": False,
                        "blocking_reason": "promoted STEP mesh export failed",
                    }
                )
                continue
            topology = _prove_topology(
                _load_stl_triangles(Path(str(export["stl_path"]))),
                merge_tolerance_m=merge_tolerance_m,
            )
            topology_data = asdict(topology)
            component_count = int(topology.manifold_component_count)
            expected_component_count = int(record["expected_component_count"])
            accepted = bool(
                topology.ok and component_count == expected_component_count
            )
            validation.append(
                {
                    "link": link,
                    "promoted_step_path": record["promoted_step_path"],
                    "mesh_exported": True,
                    "triangle_count": topology_data["triangle_count"],
                    "boundary_edges": topology_data["boundary_edges"],
                    "nonmanifold_edges": topology_data["nonmanifold_edges"],
                    "degenerate_faces": topology_data["degenerate_faces"],
                    "component_count": component_count,
                    "expected_component_count": expected_component_count,
                    "watertight": topology_data["watertight"],
                    "accepted": accepted,
                    "blocking_reason": None
                    if accepted
                    else "promoted STEP mesh is not closed with expected components",
                }
            )
    return sorted(validation, key=lambda record: record["link"])


def build_fembot_topology_promotion_proof(
    *,
    generated_cad_report: dict[str, Any] | None = None,
    topology_report: dict[str, Any] | None = None,
    promotion_root: Path = DEFAULT_TOPOLOGY_PROMOTION_ROOT,
    merge_tolerance_m: float = DEFAULT_TOPOLOGY_MERGE_TOLERANCE_M,
    export_timeout_s: int = 180,
) -> dict[str, Any]:
    generated = generated_cad_report or build_fembot_generated_cad_envelope_proof()
    topology = topology_report or build_fembot_topology_proof(generated_cad_report=generated)
    records = _selection_records(topology_report=topology, promotion_root=promotion_root)
    validation = _validate_promoted_meshes(
        records,
        merge_tolerance_m=merge_tolerance_m,
        export_timeout_s=export_timeout_s,
    )
    selected_links = {record["link"] for record in records}
    generated_links = {
        str(record.get("link", "")).upper()
        for record in generated.get("link_steps", [])
        if record.get("link")
    }
    missing_links = sorted(generated_links - selected_links)
    accepted = bool(
        len(records) == 28
        and len(validation) == 28
        and not missing_links
        and all(record.get("accepted") for record in validation)
    )
    return {
        "schema": FEMBOT_TOPOLOGY_PROMOTION_SCHEMA,
        "ok": bool(len(records) == 28 and not missing_links),
        "accepted": accepted,
        "source": {
            "generated_cad_schema": generated.get("schema"),
            "topology_schema": topology.get("schema"),
            "promotion_root": str(promotion_root),
            "merge_tolerance_m": float(merge_tolerance_m),
            "export_timeout_s": int(export_timeout_s),
        },
        "summary": {
            "links": len(records),
            "missing_links": missing_links,
            "promoted_original_step_links": sum(
                1 for record in records if record["promotion_source"] == "accepted_original_step"
            ),
            "promoted_repair_preview_links": sum(
                1 for record in records if record["promotion_source"] == "repair_preview"
            ),
            "promoted_step_exports": sum(
                1 for record in records if Path(record["promoted_step_path"]).is_file()
            ),
            "validated_promoted_meshes": len(validation),
            "accepted_promoted_meshes": sum(
                1 for record in validation if record.get("accepted")
            ),
            "max_boundary_edges": max(
                (int(record.get("boundary_edges") or 0) for record in validation),
                default=None,
            ),
            "max_nonmanifold_edges": max(
                (int(record.get("nonmanifold_edges") or 0) for record in validation),
                default=None,
            ),
            "max_degenerate_faces": max(
                (int(record.get("degenerate_faces") or 0) for record in validation),
                default=None,
            ),
            "accepted": accepted,
            "acceptance_blocker": None
            if accepted
            else "not every promoted STEP mesh validates with clean topology",
        },
        "records": records,
        "validation": validation,
    }


def dump_fembot_topology_promotion_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_topology_promotion_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-topology-promotion.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_topology_promotion_proof_json(report), encoding="utf-8")
    return output
