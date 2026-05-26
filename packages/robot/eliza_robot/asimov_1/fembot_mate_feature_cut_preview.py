"""Subtractive mate-feature tooling STEP previews for ASIMOV fembot."""

from __future__ import annotations

import json
import subprocess
from copy import deepcopy
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.fembot_cad_toolchain import FEMBOT_CAD_ENV_VENV
from eliza_robot.asimov_1.fembot_mate_feature_specs import (
    build_fembot_mate_feature_specs_proof,
)
from eliza_robot.asimov_1.fembot_wrist_fastener_redesign import (
    build_fembot_wrist_fastener_redesign_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_FEMININE_CAD_ROOT, ASIMOV_PARAM_PROOFS

FEMBOT_MATE_FEATURE_CUT_PREVIEW_SCHEMA = "asimov-fembot-mate-feature-cut-preview-v1"
DEFAULT_MATE_FEATURE_CUT_PREVIEW_ROOT = (
    ASIMOV_FEMININE_CAD_ROOT
    / "output"
    / "generated-cad"
    / "mate-feature-cut-tooling-step"
)
DEFAULT_MATE_FEATURE_SOURCE_CUT_PREVIEW_ROOT = (
    ASIMOV_FEMININE_CAD_ROOT
    / "output"
    / "generated-cad"
    / "mate-feature-source-cut-step"
)
DEFAULT_CAD_PYTHON = FEMBOT_CAD_ENV_VENV / "bin" / "python"


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _safe_filename(link: str) -> str:
    return "".join(char if char.isalnum() or char in {"_", "-"} else "_" for char in link)


def _cut_requests(
    mate_feature_specs_report: dict[str, Any],
    *,
    tooling_output_root: Path,
    source_cut_output_root: Path,
    wrist_fastener_redesign_report: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    redesigns = {
        (str(record.get("link")).upper(), str(record.get("joint_name"))): record
        for record in (wrist_fastener_redesign_report or {}).get("redesigns", [])
        if record.get("fits_current_envelope_after_redesign")
    }
    requests = []
    for record in mate_feature_specs_report.get("links", []):
        joint_specs = []
        for joint_spec in record.get("joint_feature_specs") or []:
            revised = deepcopy(joint_spec)
            link = str(record["link"]).upper()
            redesign = redesigns.get((link, str(joint_spec.get("joint_name"))))
            if redesign:
                revised["fastener_pattern"]["fastener_diameter_m"] = redesign[
                    "revised_fastener_diameter_m"
                ]
                revised["fastener_pattern"]["bolt_circle_diameter_m"] = redesign[
                    "revised_bolt_circle_diameter_m"
                ]
                revised["fastener_pattern"]["minimum_edge_distance_m"] = redesign[
                    "minimum_edge_distance_m"
                ]
                revised["fastener_pattern"]["wrist_fastener_redesign_applied"] = True
                revised["fastener_pattern"]["redesign_strategy"] = redesign[
                    "redesign_strategy"
                ]
            joint_specs.append(revised)
        if not joint_specs:
            continue
        link = str(record["link"]).upper()
        requests.append(
            {
                "link": link,
                "group": record.get("group"),
                "source_step_path": record.get("generated_step_path"),
                "tool_step_path": str(tooling_output_root / f"{_safe_filename(link)}.step"),
                "cut_step_path": str(source_cut_output_root / f"{_safe_filename(link)}.step"),
                "joint_feature_specs": joint_specs,
            }
        )
    return requests


def _cadquery_export_feature_cut_tooling(
    *,
    requests: list[dict[str, Any]],
    cad_python: Path = DEFAULT_CAD_PYTHON,
    timeout_s: int = 180,
) -> dict[str, Any]:
    if not cad_python.is_file():
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": "isolated CAD python executable not found"}],
        }
    code = r'''
from __future__ import annotations

import json
from pathlib import Path
import sys

import cadquery as cq


def vector(values):
    return cq.Vector(float(values[0]), float(values[1]), float(values[2]))


def cylinder_cut(center_values, axis_values, radius, length):
    axis = vector(axis_values)
    if axis.Length <= 0:
        axis = cq.Vector(0, 0, 1)
    axis = axis.normalized()
    center = vector(center_values)
    start = center - axis.multiply(float(length) * 0.5)
    return cq.Solid.makeCylinder(float(radius), float(length), start, axis)


def offset_center(center_values, unit_offset, diameter):
    center = [float(value) for value in center_values]
    scale = float(diameter) * 0.5
    return [
        center[0] + float(unit_offset["x"]) * scale,
        center[1] + float(unit_offset["y"]) * scale,
        center[2] + float(unit_offset["z"]) * scale,
    ]


def checked_cut(source_shape, cutters):
    tool = cq.Compound.makeCompound(cutters)
    cut_shape = source_shape.cut(tool)
    volume = cut_shape.Volume()
    bbox = cut_shape.BoundingBox()
    if volume <= 0 or max(bbox.xlen, bbox.ylen, bbox.zlen) <= 0:
        raise ValueError("cut result has no positive reloadable body")
    return cut_shape


payload = json.loads(sys.stdin.read())
records = []
failures = []
for request in payload["requests"]:
    tool_step_path = Path(request["tool_step_path"])
    cut_step_path = Path(request["cut_step_path"])
    try:
        source_step_path = Path(request["source_step_path"])
        tool_step_path.parent.mkdir(parents=True, exist_ok=True)
        cut_step_path.parent.mkdir(parents=True, exist_ok=True)
        shape = cq.importers.importStep(str(source_step_path))
        original_volume = shape.val().Volume()
        bbox = shape.val().BoundingBox()
        max_extent = max(bbox.xlen, bbox.ylen, bbox.zlen)
        cut_count = 0
        cutter_records = []
        for spec in request["joint_feature_specs"]:
            axis = spec["axis_unit_vector"]
            center = spec["local_center_m"]
            cut_length = max_extent * 2.2
            bore = spec["bore"]
            cutter_records.append(
                {
                    "role": "through_bore",
                    "shape": cylinder_cut(
                        center,
                        axis,
                        float(bore["diameter_m"]) * 0.5,
                        cut_length,
                    ),
                }
            )
            cut_count += 1
            seat = spec["bearing_seat"]
            seat_length = max(float(seat["width_m"]), 0.001)
            cutter_records.append(
                {
                    "role": "bearing_seat",
                    "shape": cylinder_cut(
                        center,
                        axis,
                        float(seat["outer_diameter_m"]) * 0.5,
                        seat_length,
                    ),
                }
            )
            cut_count += 1
            retainer = spec["retention_feature"]
            relief_radius = (
                float(seat["outer_diameter_m"]) * 0.5
                + float(retainer["radial_clearance_m"])
            )
            cutter_records.append(
                {
                    "role": "retainer_relief",
                    "shape": cylinder_cut(center, axis, relief_radius, seat_length * 0.42),
                }
            )
            cut_count += 1
            fastener = spec["fastener_pattern"]
            for unit_offset in fastener["unit_offsets"]:
                hole_center = offset_center(
                    center,
                    unit_offset,
                    float(fastener["bolt_circle_diameter_m"]),
                )
                cutter_records.append(
                    {
                        "role": "fastener_hole",
                        "shape": cylinder_cut(
                            hole_center,
                            axis,
                            float(fastener["fastener_diameter_m"]) * 0.5,
                            cut_length,
                        ),
                    }
                )
                cut_count += 1
        cutters = [record["shape"] for record in cutter_records]
        if cutters:
            tool = cq.Compound.makeCompound(cutters)
        else:
            tool = cq.Compound.makeCompound([])
        source_cut_fallback_strategy = None
        source_cut_boolean_recovery_strategy = None
        source_cut_feature_count = cut_count
        try:
            cut_shape = checked_cut(shape.val(), cutters) if cutters else shape.val()
        except Exception:
            bearing_seat_cutters = [
                record["shape"]
                for record in cutter_records
                if record["role"] == "bearing_seat"
            ]
            non_bearing_seat_cutters = [
                record["shape"]
                for record in cutter_records
                if record["role"] != "bearing_seat"
            ]
            recovered_shape = checked_cut(shape.val(), bearing_seat_cutters)
            cut_shape = checked_cut(recovered_shape, non_bearing_seat_cutters)
            source_cut_boolean_recovery_strategy = "segmented_counterbore_boolean"
        cq.exporters.export(tool, str(tool_step_path))
        cq.exporters.export(cut_shape, str(cut_step_path))
        imported_tool = cq.importers.importStep(str(tool_step_path))
        imported_cut = cq.importers.importStep(str(cut_step_path))
        tool_bbox = imported_tool.val().BoundingBox()
        cut_bbox = imported_cut.val().BoundingBox()
        tool_volume = imported_tool.val().Volume()
        cut_volume = imported_cut.val().Volume()
        removed_volume = original_volume - cut_volume
        records.append(
            {
                "link": request["link"],
                "group": request["group"],
                "source_step_path": str(source_step_path),
                "tool_step_path": str(tool_step_path),
                "cut_step_path": str(cut_step_path),
                "joint_feature_spec_count": len(request["joint_feature_specs"]),
                "cut_feature_count": cut_count,
                "source_cut_feature_count": source_cut_feature_count,
                "source_cut_fallback_strategy": source_cut_fallback_strategy,
                "source_cut_boolean_recovery_strategy": source_cut_boolean_recovery_strategy,
                "source_volume_m3": original_volume,
                "tool_volume_m3": tool_volume,
                "tool_to_source_volume_fraction": tool_volume / original_volume
                if original_volume > 0
                else None,
                "cut_volume_m3": cut_volume,
                "removed_volume_m3": removed_volume,
                "removed_to_source_volume_fraction": removed_volume / original_volume
                if original_volume > 0
                else None,
                "tool_reloaded_bbox_extent_m": [tool_bbox.xlen, tool_bbox.ylen, tool_bbox.zlen],
                "cut_reloaded_bbox_extent_m": [cut_bbox.xlen, cut_bbox.ylen, cut_bbox.zlen],
                "tool_solid_count": len(imported_tool.solids().vals()),
                "cut_solid_count": len(imported_cut.solids().vals()),
                "tool_export_ok": tool_step_path.is_file() and tool_step_path.stat().st_size > 0,
                "tool_reload_ok": True,
                "cut_export_ok": cut_step_path.is_file() and cut_step_path.stat().st_size > 0,
                "cut_reload_ok": True,
            }
        )
    except Exception as exc:
        failures.append(
            {
                "link": request.get("link"),
                "source_step_path": request.get("source_step_path"),
                "tool_step_path": str(tool_step_path),
                "cut_step_path": str(cut_step_path),
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


def build_fembot_mate_feature_cut_preview_proof(
    body_groups: list[dict[str, Any]],
    *,
    mate_feature_specs_report: dict[str, Any] | None = None,
    wrist_fastener_redesign_report: dict[str, Any] | None = None,
    output_root: Path = DEFAULT_MATE_FEATURE_CUT_PREVIEW_ROOT,
    source_cut_output_root: Path = DEFAULT_MATE_FEATURE_SOURCE_CUT_PREVIEW_ROOT,
    cad_python: Path = DEFAULT_CAD_PYTHON,
) -> dict[str, Any]:
    mate_feature_specs = (
        mate_feature_specs_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-mate-feature-specs.json")
        or build_fembot_mate_feature_specs_proof(body_groups)
    )
    wrist_fastener_redesign = (
        wrist_fastener_redesign_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-wrist-fastener-redesign.json")
        or build_fembot_wrist_fastener_redesign_proof(body_groups)
    )
    requests = _cut_requests(
        mate_feature_specs,
        tooling_output_root=output_root,
        source_cut_output_root=source_cut_output_root,
        wrist_fastener_redesign_report=wrist_fastener_redesign,
    )
    result = _cadquery_export_feature_cut_tooling(
        requests=requests,
        cad_python=cad_python,
    )
    records = result.get("records", [])
    for record in records:
        tool_path = Path(str(record["tool_step_path"]))
        cut_path = Path(str(record["cut_step_path"]))
        record["tool_step_sha256"] = sha256_file(tool_path) if tool_path.is_file() else None
        record["cut_step_sha256"] = sha256_file(cut_path) if cut_path.is_file() else None
        matching_request = next(
            (
                request
                for request in requests
                if str(request.get("link")).upper() == str(record.get("link")).upper()
            ),
            {},
        )
        record["wrist_fastener_redesign_applied"] = any(
            spec.get("fastener_pattern", {}).get("wrist_fastener_redesign_applied")
            for spec in matching_request.get("joint_feature_specs", [])
        )
        record["step_path"] = record["tool_step_path"]
        record["step_sha256"] = record["tool_step_sha256"]
        record["export_ok"] = bool(record.get("tool_export_ok"))
        record["reload_ok"] = bool(record.get("tool_reload_ok"))
        record["accepted"] = False
        record["blocking_reason"] = (
            "subtractive mate-feature tooling and source-body cut STEP previews "
            "reload, but post-cut collision, structural, manufacturing, and "
            "measured hardware fit validation are still required"
        )
    failure_links = sorted(
        str(record.get("link"))
        for record in result.get("failures", [])
        if record.get("link")
    )
    exported_links = {
        str(record.get("link")).upper()
        for record in records
        if record.get("tool_export_ok")
    }
    reloaded_links = {
        str(record.get("link")).upper()
        for record in records
        if record.get("tool_reload_ok")
    }
    source_cut_exported_links = {
        str(record.get("link")).upper()
        for record in records
        if record.get("cut_export_ok")
    }
    source_cut_reloaded_links = {
        str(record.get("link")).upper()
        for record in records
        if record.get("cut_reload_ok")
    }
    negative_or_zero_tool_volume = [
        str(record.get("link"))
        for record in records
        if float(record.get("tool_volume_m3") or 0.0) <= 0.0
    ]
    excessive_tool_volume = [
        str(record.get("link"))
        for record in records
        if float(record.get("tool_to_source_volume_fraction") or 0.0) > 0.35
    ]
    negative_or_zero_cut_volume = [
        str(record.get("link"))
        for record in records
        if float(record.get("cut_volume_m3") or 0.0) <= 0.0
    ]
    source_cut_non_decreasing_volume = [
        str(record.get("link"))
        for record in records
        if float(record.get("removed_volume_m3") or 0.0) <= 0.0
    ]
    source_cut_fallback_links = [
        str(record.get("link"))
        for record in records
        if record.get("source_cut_fallback_strategy")
    ]
    source_cut_boolean_recovery_links = [
        str(record.get("link"))
        for record in records
        if record.get("source_cut_boolean_recovery_strategy")
    ]
    ok = bool(
        mate_feature_specs.get("ok")
        and len(requests) == int(mate_feature_specs.get("summary", {}).get("joint_feature_spec_records") or 0)
        and len(records) == len(requests)
        and not result.get("failures")
        and not negative_or_zero_tool_volume
        and not negative_or_zero_cut_volume
    )
    accepted = False
    return {
        "schema": FEMBOT_MATE_FEATURE_CUT_PREVIEW_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "mate_feature_specs_schema": mate_feature_specs.get("schema"),
            "output_root": str(output_root),
            "source_cut_output_root": str(source_cut_output_root),
            "cad_backend": result.get("backend"),
            "cad_python": result.get("python"),
        },
        "summary": {
            "links": 28,
            "joint_feature_request_links": len(requests),
            "feature_cut_tool_step_links": len(exported_links),
            "feature_cut_tool_step_reloads": len(reloaded_links),
            "feature_cut_tool_step_failure_links": len(failure_links),
            "feature_cut_tool_step_failure_link_names": failure_links,
            "feature_cut_step_links": len(source_cut_exported_links),
            "feature_cut_step_reloads": len(source_cut_reloaded_links),
            "cut_feature_records": sum(int(record.get("cut_feature_count") or 0) for record in records),
            "source_cut_feature_records": sum(
                int(record.get("source_cut_feature_count") or 0) for record in records
            ),
            "source_cut_fallback_links": len(source_cut_fallback_links),
            "source_cut_fallback_link_names": source_cut_fallback_links,
            "source_cut_boolean_recovery_links": len(source_cut_boolean_recovery_links),
            "source_cut_boolean_recovery_link_names": source_cut_boolean_recovery_links,
            "wrist_fastener_redesign_applied_links": sum(
                1 for record in records if record.get("wrist_fastener_redesign_applied")
            ),
            "negative_or_zero_tool_volume_links": negative_or_zero_tool_volume,
            "negative_or_zero_cut_volume_links": negative_or_zero_cut_volume,
            "source_cut_non_decreasing_volume_links": source_cut_non_decreasing_volume,
            "excessive_tool_volume_links": excessive_tool_volume,
            "post_cut_collision_validated_links": 0,
            "post_cut_structural_validated_links": 0,
            "post_cut_manufacturing_validated_links": 0,
            "accepted": accepted,
            "acceptance_blocker": (
                "subtractive mate-feature tooling and source-body feature-cut STEP "
                "previews reload, but production acceptance still requires exact "
                "hardware measurements, selected CAD faces, and post-cut collision, "
                "structural, and manufacturing "
                "validation"
            ),
        },
        "feature_cut_tool_steps": records,
        "failures": result.get("failures", []),
    }


def dump_fembot_mate_feature_cut_preview_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_mate_feature_cut_preview_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-mate-feature-cut-preview.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_mate_feature_cut_preview_proof_json(report),
        encoding="utf-8",
    )
    return output
