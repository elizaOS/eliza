"""Generated STEP mesh topology proof for ASIMOV fembot links."""

from __future__ import annotations

import json
import subprocess
import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.fembot_cad_toolchain import FEMBOT_CAD_ENV_VENV
from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.fembot_surface_quality import _load_stl_triangles
from eliza_robot.asimov_1.fembot_waist_yaw_no_cutout import build_waist_yaw_no_cutout_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_FEMININE_CAD_ROOT, ASIMOV_PARAM_PROOFS
from eliza_robot.asimov_1.spline_fit_proof import _prove_topology

FEMBOT_TOPOLOGY_SCHEMA = "asimov-fembot-topology-proof-v1"
DEFAULT_TOPOLOGY_MERGE_TOLERANCE_M = 1e-6
DEFAULT_REPAIR_ENVELOPE_TOLERANCE_M = 1e-6
DEFAULT_TOPOLOGY_REPAIR_OUTPUT_ROOT = (
    ASIMOV_FEMININE_CAD_ROOT / "output" / "generated-cad" / "topology-repair-preview-step"
)


def _cad_python(venv: Path = FEMBOT_CAD_ENV_VENV) -> Path:
    return venv / "bin" / "python"


def _export_generated_step_meshes(
    records: list[dict[str, Any]],
    *,
    output_dir: Path,
    cad_python: Path,
    timeout_s: int,
) -> dict[str, Any]:
    if not cad_python.is_file():
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": "isolated CAD python executable not found"}],
        }
    requests = [
        {
            "link": str(record["link"]).upper(),
            "group": str(record["group"]),
            "step_path": str(record["step_path"]),
            "stl_path": str(output_dir / f"{str(record['link']).lower()}.stl"),
        }
        for record in records
        if record.get("step_path")
    ]
    code = r'''
from __future__ import annotations

import json
from pathlib import Path
import sys

import cadquery as cq

payload = json.loads(sys.stdin.read())
records = []
failures = []
for request in payload["requests"]:
    stl_path = Path(request["stl_path"])
    try:
        step_path = Path(request["step_path"])
        stl_path.parent.mkdir(parents=True, exist_ok=True)
        shape = cq.importers.importStep(str(step_path))
        cq.exporters.export(shape, str(stl_path))
        records.append(
            {
                "link": request["link"],
                "group": request["group"],
                "step_path": str(step_path),
                "stl_path": str(stl_path),
                "export_ok": stl_path.is_file() and stl_path.stat().st_size > 0,
            }
        )
    except Exception as exc:
        failures.append(
            {
                "link": request.get("link"),
                "group": request.get("group"),
                "step_path": request.get("step_path"),
                "stl_path": str(stl_path),
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
print(json.dumps({"records": records, "failures": failures}, sort_keys=True))
'''
    try:
        proc = subprocess.run(
            [str(cad_python), "-c", code],
            input=json.dumps({"requests": requests}),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_s,
        )
    except Exception as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"{type(exc).__name__}: {exc}"}],
        }
    if proc.returncode != 0:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": proc.stderr.strip() or proc.stdout.strip()}],
        }
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"JSONDecodeError: {exc}", "stdout": proc.stdout}],
        }
    return {
        "ok": not parsed.get("failures"),
        "backend": "cadquery",
        "python": str(cad_python),
        "records": parsed.get("records", []),
        "failures": parsed.get("failures", []),
    }


def _safe_filename(value: str) -> str:
    return "".join(char.lower() if char.isalnum() else "_" for char in value).strip("_")


def _export_topology_repair_previews(
    records: list[dict[str, Any]],
    *,
    repair_root: Path,
    cad_python: Path,
    timeout_s: int,
) -> dict[str, Any]:
    if not records:
        return {
            "ok": True,
            "backend": "cadquery",
            "python": str(cad_python),
            "repair_root": str(repair_root),
            "records": [],
            "failures": [],
        }
    if not cad_python.is_file():
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "repair_root": str(repair_root),
            "records": [],
            "failures": [{"error": "isolated CAD python executable not found"}],
        }
    requests = [
        {
            "link": str(record["link"]).upper(),
            "group": str(record["group"]),
            "center_m": [float(value) for value in record["requested_center_m"]],
            "extent_m": [float(value) for value in record["requested_extent_m"]],
            "wall_thickness_m": float(record.get("wall_thickness_m") or 0.0012),
            "source_volume_m3": float(record.get("reloaded_volume_m3") or 0.0),
            "step_path": str(repair_root / f"{_safe_filename(str(record['link']))}.step"),
        }
        for record in records
    ]
    code = r'''
from __future__ import annotations

import json
from pathlib import Path
import sys

import cadquery as cq

payload = json.loads(sys.stdin.read())
records = []
failures = []
for request in payload["requests"]:
    step_path = Path(request["step_path"])
    try:
        step_path.parent.mkdir(parents=True, exist_ok=True)
        extents = [float(value) for value in request["extent_m"]]
        center = [float(value) for value in request["center_m"]]
        wall = float(request["wall_thickness_m"])
        radius = min(extents[0], extents[1]) * 0.5
        height = extents[2]
        inner_radius = max(radius - wall, radius * 0.2)
        inner_height = max(height - 2.0 * wall, height * 0.5)
        outer = cq.Workplane("XY").cylinder(height, radius)
        inner = cq.Workplane("XY").cylinder(inner_height, inner_radius)
        repaired = outer.cut(inner).translate(tuple(center))
        cq.exporters.export(repaired, str(step_path))
        imported = cq.importers.importStep(str(step_path))
        bbox = imported.val().BoundingBox()
        records.append(
            {
                "link": request["link"],
                "group": request["group"],
                "step_path": str(step_path),
                "requested_extent_m": extents,
                "requested_center_m": center,
                "wall_thickness_m": wall,
                "source_volume_m3": float(request["source_volume_m3"]),
                "repair_family": "sealed_hollow_cylindrical_topology_reference",
                "reloaded_bbox_min_m": [bbox.xmin, bbox.ymin, bbox.zmin],
                "reloaded_bbox_max_m": [bbox.xmax, bbox.ymax, bbox.zmax],
                "reloaded_bbox_extent_m": [bbox.xlen, bbox.ylen, bbox.zlen],
                "reloaded_bbox_center_m": [
                    (bbox.xmin + bbox.xmax) * 0.5,
                    (bbox.ymin + bbox.ymax) * 0.5,
                    (bbox.zmin + bbox.zmax) * 0.5,
                ],
                "reloaded_volume_m3": imported.val().Volume(),
                "solid_count": len(imported.solids().vals()),
                "export_ok": step_path.is_file() and step_path.stat().st_size > 0,
                "reload_ok": True,
            }
        )
    except Exception as exc:
        failures.append(
            {
                "link": request.get("link"),
                "group": request.get("group"),
                "step_path": str(step_path),
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
print(json.dumps({"records": records, "failures": failures}, sort_keys=True))
'''
    try:
        proc = subprocess.run(
            [str(cad_python), "-c", code],
            input=json.dumps({"requests": requests}),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_s,
        )
    except Exception as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "repair_root": str(repair_root),
            "records": [],
            "failures": [{"error": f"{type(exc).__name__}: {exc}"}],
        }
    if proc.returncode != 0:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "repair_root": str(repair_root),
            "records": [],
            "failures": [{"error": proc.stderr.strip() or proc.stdout.strip()}],
        }
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "repair_root": str(repair_root),
            "records": [],
            "failures": [{"error": f"JSONDecodeError: {exc}", "stdout": proc.stdout}],
        }
    records_out = []
    for record in parsed.get("records", []):
        step_path = Path(record["step_path"])
        records_out.append(
            {
                **record,
                "step_sha256": sha256_file(step_path) if step_path.is_file() else None,
                "step_size_bytes": step_path.stat().st_size if step_path.is_file() else 0,
            }
        )
    return {
        "ok": not parsed.get("failures"),
        "backend": "cadquery",
        "python": str(cad_python),
        "repair_root": str(repair_root),
        "records": records_out,
        "failures": parsed.get("failures", []),
    }


def _repair_delta_record(record: dict[str, Any]) -> dict[str, Any]:
    requested_extent = [float(value) for value in record.get("requested_extent_m", [])]
    reloaded_extent = [float(value) for value in record.get("reloaded_bbox_extent_m", [])]
    requested_center = [float(value) for value in record.get("requested_center_m", [])]
    reloaded_center = [float(value) for value in record.get("reloaded_bbox_center_m", [])]
    extent_delta = [
        abs(got - requested)
        for requested, got in zip(requested_extent, reloaded_extent, strict=True)
    ]
    center_delta = [
        abs(got - requested)
        for requested, got in zip(requested_center, reloaded_center, strict=True)
    ]
    source_volume = float(record.get("source_volume_m3") or 0.0)
    repair_volume = float(record.get("reloaded_volume_m3") or 0.0)
    volume_delta = repair_volume - source_volume
    return {
        "extent_abs_error_m": extent_delta,
        "extent_max_abs_error_m": max(extent_delta, default=None),
        "height_abs_error_m": extent_delta[2] if len(extent_delta) >= 3 else None,
        "center_abs_error_m": center_delta,
        "center_max_abs_error_m": max(center_delta, default=None),
        "source_volume_m3": source_volume,
        "repair_volume_m3": repair_volume,
        "volume_delta_m3": volume_delta,
        "volume_delta_fraction": (
            volume_delta / source_volume if source_volume > 0.0 else None
        ),
    }


def build_fembot_topology_proof(
    *,
    generated_cad_report: dict[str, Any] | None = None,
    waist_yaw_no_cutout_report: dict[str, Any] | None = None,
    repair_root: Path = DEFAULT_TOPOLOGY_REPAIR_OUTPUT_ROOT,
    merge_tolerance_m: float = DEFAULT_TOPOLOGY_MERGE_TOLERANCE_M,
    export_timeout_s: int = 180,
) -> dict[str, Any]:
    if generated_cad_report is None:
        generated_cad_report = build_fembot_generated_cad_envelope_proof()
    if waist_yaw_no_cutout_report is None:
        try:
            waist_yaw_no_cutout_report = build_waist_yaw_no_cutout_proof()
        except Exception as exc:
            waist_yaw_no_cutout_report = {
                "accepted": False,
                "error": f"{type(exc).__name__}: {exc}",
            }

    generated_records = [
        record
        for record in generated_cad_report.get("link_steps", [])
        if isinstance(record, dict)
    ]
    records_by_link = {str(record.get("link", "")).upper(): record for record in generated_records}
    link_records: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="asimov-fembot-topology-") as tmp:
        mesh_exports = _export_generated_step_meshes(
            generated_records,
            output_dir=Path(tmp),
            cad_python=_cad_python(),
            timeout_s=export_timeout_s,
        )
        for export in mesh_exports.get("records", []):
            link = str(export.get("link", "")).upper()
            source = records_by_link.get(link, {})
            stl_path = Path(str(export.get("stl_path")))
            record: dict[str, Any] = {
                "link": link,
                "group": export.get("group"),
                "source_step": export.get("step_path"),
                "source_step_sha256": (
                    sha256_file(Path(str(export["step_path"])))
                    if Path(str(export["step_path"])).is_file()
                    else None
                ),
                "source_step_reload_ok": bool(source.get("reload_ok")),
                "source_step_solid_count": int(source.get("solid_count") or 0),
                "expected_component_count": (
                    2 if source.get("internal_cavity", {}).get("required") else 1
                ),
                "mesh_exported": bool(export.get("export_ok")),
                "mesh_sha256": sha256_file(stl_path) if stl_path.is_file() else None,
                "merge_tolerance_m": float(merge_tolerance_m),
            }
            if not export.get("export_ok") or not stl_path.is_file():
                record.update(
                    {
                        "boundary_edges": -1,
                        "nonmanifold_edges": -1,
                        "degenerate_faces": -1,
                        "component_count": -1,
                        "watertight": False,
                        "accepted": False,
                        "blocking_reason": "generated STEP mesh export failed",
                    }
                )
                link_records.append(record)
                continue
            topology = _prove_topology(
                _load_stl_triangles(stl_path),
                merge_tolerance_m=merge_tolerance_m,
            )
            topology_data = asdict(topology)
            accepted = bool(
                topology.ok
                and int(source.get("solid_count") or 0) == 1
                and int(topology.manifold_component_count)
                == int(record["expected_component_count"])
                and bool(source.get("reload_ok"))
            )
            waist_single_shell_no_cutout_accepted = bool(
                link == "WAIST_YAW"
                and source.get("smooth_chest_no_cutout_loft")
                and waist_yaw_no_cutout_report.get("accepted")
                and waist_yaw_no_cutout_report.get("generated_sections_ok")
                and topology.ok
                and int(topology.manifold_component_count) == 1
                and int(source.get("solid_count") or 0) == 1
                and bool(source.get("reload_ok"))
            )
            if waist_single_shell_no_cutout_accepted:
                accepted = True
            record.update(
                {
                    "triangle_count": topology_data["triangle_count"],
                    "unique_vertex_count": topology_data["unique_vertex_count"],
                    "boundary_edges": topology_data["boundary_edges"],
                    "nonmanifold_edges": topology_data["nonmanifold_edges"],
                    "degenerate_faces": topology_data["degenerate_faces"],
                    "component_count": topology_data["manifold_component_count"],
                    "largest_component_faces": topology_data[
                        "largest_manifold_component_faces"
                    ],
                    "watertight": topology_data["watertight"],
                    "waist_single_shell_no_cutout_accepted": waist_single_shell_no_cutout_accepted,
                    "accepted": accepted,
                    "blocking_reason": None
                    if accepted
                    else (
                        "generated mesh topology is not a closed reloadable "
                        "reference with expected shell components"
                    ),
                }
            )
            link_records.append(record)

    failed_exports = [failure for failure in mesh_exports.get("failures", [])]
    accepted_records = [record for record in link_records if record.get("accepted")]
    topology_failures = [
        record
        for record in link_records
        if not record.get("accepted")
    ]
    repair_source_records = [
        records_by_link[str(record["link"])]
        for record in topology_failures
        if str(record["link"]) in records_by_link
    ]
    repair_result = _export_topology_repair_previews(
        repair_source_records,
        repair_root=repair_root,
        cad_python=_cad_python(),
        timeout_s=export_timeout_s,
    )
    repair_topology_records: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="asimov-fembot-topology-repair-") as tmp:
        repair_mesh_exports = _export_generated_step_meshes(
            repair_result.get("records", []),
            output_dir=Path(tmp),
            cad_python=_cad_python(),
            timeout_s=export_timeout_s,
        )
        repair_by_link = {
            str(record.get("link", "")).upper(): record
            for record in repair_result.get("records", [])
        }
        for export in repair_mesh_exports.get("records", []):
            link = str(export.get("link", "")).upper()
            source = repair_by_link.get(link, {})
            stl_path = Path(str(export.get("stl_path")))
            record = {
                "link": link,
                "group": export.get("group"),
                "repair_step": export.get("step_path"),
                "repair_step_sha256": (
                    sha256_file(Path(str(export["step_path"])))
                    if Path(str(export["step_path"])).is_file()
                    else None
                ),
                "repair_step_reload_ok": bool(source.get("reload_ok")),
                "repair_step_solid_count": int(source.get("solid_count") or 0),
                "expected_component_count": 2,
                "mesh_exported": bool(export.get("export_ok")),
                "mesh_sha256": sha256_file(stl_path) if stl_path.is_file() else None,
                "merge_tolerance_m": float(merge_tolerance_m),
            }
            if not export.get("export_ok") or not stl_path.is_file():
                record.update(
                    {
                        "boundary_edges": -1,
                        "nonmanifold_edges": -1,
                        "degenerate_faces": -1,
                        "component_count": -1,
                        "watertight": False,
                        "accepted": False,
                        "blocking_reason": "topology repair mesh export failed",
                    }
                )
                repair_topology_records.append(record)
                continue
            topology = _prove_topology(
                _load_stl_triangles(stl_path),
                merge_tolerance_m=merge_tolerance_m,
            )
            topology_data = asdict(topology)
            accepted_repair = bool(
                topology.ok
                and int(topology.manifold_component_count) == 2
                and bool(source.get("reload_ok"))
                and int(source.get("solid_count") or 0) == 1
            )
            record.update(
                {
                    "triangle_count": topology_data["triangle_count"],
                    "unique_vertex_count": topology_data["unique_vertex_count"],
                    "boundary_edges": topology_data["boundary_edges"],
                    "nonmanifold_edges": topology_data["nonmanifold_edges"],
                    "degenerate_faces": topology_data["degenerate_faces"],
                    "component_count": topology_data["manifold_component_count"],
                    "largest_component_faces": topology_data[
                        "largest_manifold_component_faces"
                    ],
                    "watertight": topology_data["watertight"],
                    "accepted": accepted_repair,
                    "blocking_reason": None
                    if accepted_repair
                    else "topology repair preview is not a closed two-shell mesh",
                }
            )
            repair_topology_records.append(record)

    accepted_repair_records = [
        record for record in repair_topology_records if record.get("accepted")
    ]
    repair_delta_records: list[dict[str, Any]] = []
    for record in repair_result.get("records", []):
        delta_record = _repair_delta_record(record)
        repair_delta_records.append(
            {
                "link": str(record.get("link", "")).upper(),
                "group": record.get("group"),
                "repair_step": record.get("step_path"),
                "repair_family": record.get("repair_family"),
                "wall_thickness_m": record.get("wall_thickness_m"),
                **delta_record,
                "envelope_preserved": bool(
                    (delta_record["extent_max_abs_error_m"] or 0.0)
                    <= DEFAULT_REPAIR_ENVELOPE_TOLERANCE_M
                    and (delta_record["center_max_abs_error_m"] or 0.0)
                    <= DEFAULT_REPAIR_ENVELOPE_TOLERANCE_M
                ),
                "height_preserved": bool(
                    (delta_record["height_abs_error_m"] or 0.0)
                    <= DEFAULT_REPAIR_ENVELOPE_TOLERANCE_M
                ),
            }
        )
    repair_deltas_by_link = {
        str(record["link"]).upper(): record for record in repair_delta_records
    }
    for topology_record in repair_topology_records:
        delta = repair_deltas_by_link.get(str(topology_record.get("link", "")).upper())
        if delta:
            topology_record.update(
                {
                    "extent_max_abs_error_m": delta["extent_max_abs_error_m"],
                    "height_abs_error_m": delta["height_abs_error_m"],
                    "center_max_abs_error_m": delta["center_max_abs_error_m"],
                    "volume_delta_fraction": delta["volume_delta_fraction"],
                    "envelope_preserved": delta["envelope_preserved"],
                    "height_preserved": delta["height_preserved"],
                }
            )
    repair_promotion_ready = bool(
        repair_topology_records
        and len(accepted_repair_records) == len(repair_topology_records)
        and all(record["envelope_preserved"] for record in repair_delta_records)
        and all(record["height_preserved"] for record in repair_delta_records)
    )
    envelope_preserved_repair_links = {
        str(record["link"]).upper()
        for record in repair_delta_records
        if record["envelope_preserved"] and record["height_preserved"]
    }
    accepted_repair_links = {
        str(record["link"]).upper()
        for record in accepted_repair_records
    }
    promotable_repair_links = sorted(
        accepted_repair_links & envelope_preserved_repair_links
    )
    unresolved_links = sorted(
        str(record["link"]).upper()
        for record in topology_failures
        if str(record["link"]).upper() not in set(promotable_repair_links)
    )
    resolved_links = {
        str(record["link"]).upper()
        for record in accepted_records
    } | set(promotable_repair_links)
    ok = bool(len(link_records) == 28 and not failed_exports)
    accepted = ok and len(accepted_records) == len(link_records)
    return {
        "schema": FEMBOT_TOPOLOGY_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "generated_cad_schema": generated_cad_report.get("schema"),
            "cad_backend": "cadquery",
            "cad_python": str(_cad_python()),
            "repair_root": str(repair_root),
            "merge_tolerance_m": float(merge_tolerance_m),
            "export_timeout_s": int(export_timeout_s),
        },
        "summary": {
            "links": len(link_records),
            "mesh_exports": sum(1 for record in link_records if record["mesh_exported"]),
            "single_solid_source_steps": sum(
                1 for record in link_records if record["source_step_solid_count"] == 1
            ),
            "watertight_meshes": sum(1 for record in link_records if record["watertight"]),
            "expected_component_count_matches": sum(
                1
                for record in link_records
                if record["component_count"] == record["expected_component_count"]
            ),
            "waist_single_shell_no_cutout_topology_links": sum(
                1
                for record in link_records
                if record.get("waist_single_shell_no_cutout_accepted")
            ),
            "accepted_topologies": len(accepted_records),
            "topology_failure_links": len(topology_failures),
            "repair_preview_candidates": len(repair_source_records),
            "repair_preview_exports": sum(
                1 for record in repair_result.get("records", []) if record["export_ok"]
            ),
            "repair_preview_reloads": sum(
                1 for record in repair_result.get("records", []) if record["reload_ok"]
            ),
            "repair_preview_mesh_exports": sum(
                1 for record in repair_topology_records if record["mesh_exported"]
            ),
            "repair_preview_accepted_topologies": len(accepted_repair_records),
            "repair_preview_failure_links": (
                len(repair_topology_records) - len(accepted_repair_records)
            ),
            "repair_preview_envelope_preserved_links": sum(
                1 for record in repair_delta_records if record["envelope_preserved"]
            ),
            "repair_preview_height_preserved_links": sum(
                1 for record in repair_delta_records if record["height_preserved"]
            ),
            "repair_preview_max_extent_abs_error_m": max(
                (
                    float(record["extent_max_abs_error_m"])
                    for record in repair_delta_records
                    if record["extent_max_abs_error_m"] is not None
                ),
                default=None,
            ),
            "repair_preview_max_height_abs_error_m": max(
                (
                    float(record["height_abs_error_m"])
                    for record in repair_delta_records
                    if record["height_abs_error_m"] is not None
                ),
                default=None,
            ),
            "repair_preview_max_center_abs_error_m": max(
                (
                    float(record["center_max_abs_error_m"])
                    for record in repair_delta_records
                    if record["center_max_abs_error_m"] is not None
                ),
                default=None,
            ),
            "repair_preview_max_abs_volume_delta_fraction": max(
                (
                    abs(float(record["volume_delta_fraction"]))
                    for record in repair_delta_records
                    if record["volume_delta_fraction"] is not None
                ),
                default=None,
            ),
            "repair_preview_promotable_by_topology_and_envelope": repair_promotion_ready,
            "topology_resolved_links": len(resolved_links),
            "topology_resolved_by_original_export_links": len(accepted_records),
            "topology_resolved_by_repair_preview_links": len(promotable_repair_links),
            "topology_unresolved_links": len(unresolved_links),
            "topology_unresolved_link_names": unresolved_links,
            "export_failures": len(failed_exports),
            "max_boundary_edges": max(
                (int(record["boundary_edges"]) for record in link_records),
                default=None,
            ),
            "max_nonmanifold_edges": max(
                (int(record["nonmanifold_edges"]) for record in link_records),
                default=None,
            ),
            "max_degenerate_faces": max(
                (int(record["degenerate_faces"]) for record in link_records),
                default=None,
            ),
            "max_component_count": max(
                (int(record["component_count"]) for record in link_records),
                default=None,
            ),
            "accepted": accepted,
            "acceptance_blocker": None
            if accepted
            else (
                "one or more generated STEP mesh exports are not closed meshes "
                "with the expected shell component count"
            ),
        },
        "mesh_export": mesh_exports,
        "repair_preview_generation": repair_result,
        "repair_preview_deltas": sorted(
            repair_delta_records,
            key=lambda record: record["link"],
        ),
        "repair_preview_topology": sorted(
            repair_topology_records,
            key=lambda record: record["link"],
        ),
        "link_topology": sorted(link_records, key=lambda record: record["link"]),
    }


def dump_fembot_topology_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_topology_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-topology.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_topology_proof_json(report), encoding="utf-8")
    return output
