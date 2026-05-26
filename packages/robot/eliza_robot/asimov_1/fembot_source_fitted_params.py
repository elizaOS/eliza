"""Export inspectable source-fitted loft parameter manifests for ASIMOV fembot."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF, ASIMOV1_SOURCE_MESH_DIR
from eliza_robot.asimov_1.fembot_clearance_projection import (
    build_fembot_clearance_projection_proof,
)
from eliza_robot.asimov_1.fembot_generated_cad import (
    _link_specs_from_clearance,
    _source_fitted_controlled_loft_specs,
    build_fembot_generated_cad_envelope_proof,
)
from eliza_robot.asimov_1.parametric_inventory import (
    ASIMOV_FEMININE_CAD_ROOT,
    ASIMOV_PARAM_PROOFS,
)

FEMBOT_SOURCE_FITTED_PARAMS_SCHEMA = "asimov-fembot-source-fitted-params-v1"
DEFAULT_SOURCE_FITTED_PARAM_ROOT = (
    ASIMOV_FEMININE_CAD_ROOT / "param" / "source_fitted_parts"
)


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _generated_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(record.get("link", "")).upper(): record
        for record in report.get("link_steps", [])
        if record.get("link")
    }


def _interface_levels_for_link(link: str) -> list[float]:
    proof = _load_json(ASIMOV_PARAM_PROOFS / f"{link}.spline-fit.json") or {}
    levels = proof.get("interface_levels_m") or proof.get("reserved_levels_m") or []
    if not isinstance(levels, list):
        return []
    return [float(value) for value in levels if isinstance(value, int | float)]


def _manifest_path(root: Path, link: str) -> Path:
    return root / f"{link.lower()}.source-fitted-loft.json"


def _max_abs_delta(left: list[float], right: list[float]) -> float | None:
    if len(left) != len(right):
        return None
    return max((abs(float(a) - float(b)) for a, b in zip(left, right, strict=True)), default=0.0)


def _manifest_record(
    *,
    spec: dict[str, Any],
    generated: dict[str, Any] | None,
    output_root: Path,
) -> dict[str, Any]:
    link = str(spec["link"]).upper()
    source_extent = [float(value) for value in spec["source_mesh_bbox_extent_m"]]
    control_extent = [float(value) for value in spec["source_control_bbox_extent_m"]]
    reloaded_extent = [
        float(value)
        for value in (generated or {}).get(
            "reloaded_bbox_extent_m",
            spec["source_control_bbox_extent_m"],
        )
    ]
    source_control_delta = _max_abs_delta(source_extent, control_extent)
    source_reloaded_delta = _max_abs_delta(source_extent, reloaded_extent)
    path = _manifest_path(output_root, link)
    rings = spec["source_control_rings"]
    return {
        "schema": FEMBOT_SOURCE_FITTED_PARAMS_SCHEMA,
        "link": link,
        "group": spec.get("group"),
        "surface_intent": spec.get("surface_intent"),
        "manufacturing_intent": spec.get("manufacturing_intent"),
        "parametric_source": spec.get("parametric_source"),
        "source_mesh_path": spec.get("source_mesh_path"),
        "source_mesh_bbox_min_m": spec.get("source_mesh_bbox_min_m"),
        "source_mesh_bbox_max_m": spec.get("source_mesh_bbox_max_m"),
        "source_mesh_bbox_extent_m": source_extent,
        "control_axis": spec.get("source_control_axis"),
        "control_step_m": spec.get("source_control_step_m"),
        "control_ring_count": int(spec.get("source_control_ring_count") or 0),
        "control_points_per_ring": int(
            spec.get("source_control_points_per_ring") or 0
        ),
        "control_wire_mode": spec.get("source_control_wire_mode"),
        "control_spline_segments": spec.get("source_control_spline_segments"),
        "control_bbox_min_m": spec.get("source_control_bbox_min_m"),
        "control_bbox_max_m": spec.get("source_control_bbox_max_m"),
        "control_bbox_extent_m": control_extent,
        "control_rings": rings,
        "adjustable_parameters": {
            "global_scale_xyz": [1.0, 1.0, 1.0],
            "per_ring_radial_scale": [1.0 for _ in rings],
            "per_ring_center_offset_xyz_m": [[0.0, 0.0, 0.0] for _ in rings],
            "wall_thickness_m": spec.get("wall_thickness_m"),
            "minimum_plate_thickness_m": spec.get("minimum_plate_thickness_m"),
            "locked_interface_levels_m": _interface_levels_for_link(link),
            "keep_source_bbox_normalization": True,
        },
        "generated_step": {
            "path": (generated or {}).get("step_path"),
            "sha256": (generated or {}).get("step_sha256"),
            "export_ok": bool((generated or {}).get("export_ok")),
            "reload_ok": bool((generated or {}).get("reload_ok")),
            "reloaded_bbox_extent_m": reloaded_extent,
        },
        "fit_checks": {
            "source_control_bbox_max_abs_delta_m": source_control_delta,
            "source_reloaded_bbox_max_abs_delta_m": source_reloaded_delta,
            "source_control_bbox_preserved": bool(
                source_control_delta is not None and source_control_delta <= 1.0e-9
            ),
            "source_reloaded_bbox_preserved": bool(
                source_reloaded_delta is not None and source_reloaded_delta <= 0.005
            ),
            "ring_table_nonempty": bool(rings),
            "ring_table_rectangular": bool(
                rings and all(len(ring) == len(rings[0]) for ring in rings)
            ),
        },
        "manifest_path": str(path),
        "accepted": False,
    }


def build_fembot_source_fitted_params_proof(
    body_groups: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
    mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
    output_root: Path = DEFAULT_SOURCE_FITTED_PARAM_ROOT,
) -> dict[str, Any]:
    generated = (
        generated_cad_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json")
        or build_fembot_generated_cad_envelope_proof(
            body_groups,
            mesh_dir=mesh_dir,
            mjcf_path=mjcf_path,
        )
    )
    clearance = build_fembot_clearance_projection_proof(
        body_groups,
        mesh_dir=mesh_dir,
        mjcf_path=mjcf_path,
    )
    specs = _source_fitted_controlled_loft_specs(
        _link_specs_from_clearance(clearance, output_root),
        mesh_dir=mesh_dir,
    )
    generated_links = _generated_by_link(generated)
    requested_links = sorted(
        {
            str(link).upper()
            for group in body_groups
            for link in group.get("links", [])
        }
    )
    records = [
        _manifest_record(
            spec=spec,
            generated=generated_links.get(str(spec["link"]).upper()),
            output_root=output_root,
        )
        for spec in specs
    ]
    records_by_link = {record["link"]: record for record in records}
    missing_links = sorted(set(requested_links) - set(records_by_link))
    source_control_bbox_preserved = [
        record
        for record in records
        if record["fit_checks"]["source_control_bbox_preserved"]
    ]
    reloaded_envelope_preserved = [
        record
        for record in records
        if record["fit_checks"]["source_reloaded_bbox_preserved"]
    ]
    step_ready = [
        record
        for record in records
        if record["generated_step"]["export_ok"] and record["generated_step"]["reload_ok"]
    ]
    rectangular = [
        record for record in records if record["fit_checks"]["ring_table_rectangular"]
    ]
    accepted = bool(
        len(records) == len(requested_links) == 28
        and not missing_links
        and len(source_control_bbox_preserved) == len(records)
        and len(reloaded_envelope_preserved) == len(records)
        and len(step_ready) == len(records)
        and len(rectangular) == len(records)
    )
    return {
        "schema": FEMBOT_SOURCE_FITTED_PARAMS_SCHEMA,
        "ok": accepted,
        "accepted": accepted,
        "source": {
            "generated_cad_schema": generated.get("schema"),
            "mesh_dir": str(mesh_dir),
            "mjcf": str(mjcf_path),
            "output_root": str(output_root),
        },
        "summary": {
            "links": len(records),
            "requested_links": len(requested_links),
            "missing_links": missing_links,
            "manifest_links": sorted(records_by_link),
            "step_export_reload_links": len(step_ready),
            "source_control_bbox_preserved_links": len(source_control_bbox_preserved),
            "source_reloaded_envelope_preserved_links": len(
                reloaded_envelope_preserved
            ),
            "source_reloaded_envelope_tolerance_m": 0.005,
            "rectangular_control_ring_tables": len(rectangular),
            "minimum_control_ring_count": min(
                (int(record["control_ring_count"]) for record in records),
                default=0,
            ),
            "minimum_control_points_per_ring": min(
                (int(record["control_points_per_ring"]) for record in records),
                default=0,
            ),
            "max_source_reloaded_bbox_abs_delta_m": max(
                (
                    float(
                        record["fit_checks"]["source_reloaded_bbox_max_abs_delta_m"]
                        or 0.0
                    )
                    for record in records
                ),
                default=0.0,
            ),
            "accepted": accepted,
            "acceptance_blocker": None
            if accepted
            else "one or more source-fitted loft parameter manifests is missing, nonrectangular, or not tied to an exported/reloaded STEP",
        },
        "manifests": records,
    }


def write_fembot_source_fitted_params_manifests(
    report: dict[str, Any],
    *,
    output_root: Path = DEFAULT_SOURCE_FITTED_PARAM_ROOT,
) -> list[Path]:
    output_root.mkdir(parents=True, exist_ok=True)
    paths = []
    for record in report.get("manifests", []):
        path = Path(str(record["manifest_path"]))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        paths.append(path)
    return paths


def dump_fembot_source_fitted_params_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_source_fitted_params_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-source-fitted-params.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_source_fitted_params_proof_json(report),
        encoding="utf-8",
    )
    return output
