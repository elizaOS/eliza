"""Bounding-box body matching scaffold for ASIMOV fembot STEP sources."""

from __future__ import annotations

import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF, ASIMOV1_SOURCE_MESH_DIR
from eliza_robot.asimov_1.fembot_step_body_index import (
    DEFAULT_MAX_FILES_PER_GROUP,
    build_fembot_step_body_index_proof,
)
from eliza_robot.asimov_1.fembot_surface_quality import measure_surface_quality_for_stl
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS
from eliza_robot.asimov_1.spline_fit_proof import (
    AXIS_IDX,
    load_connection_specs,
    load_reserved_levels,
    read_binary_stl_vertices,
)


BODY_MATCHING_SCHEMA = "asimov-fembot-body-matching-v1"
DEFAULT_TOP_MATCHES_PER_LINK = 5
DEFAULT_ACCEPTANCE_SCORE = 1.0e-6
DEFAULT_SPATIAL_ANCHOR_TOLERANCE_M = 1.0e-4
DEFAULT_INTERFACE_CONTAINMENT_TOLERANCE_M = 3.0e-3
DEFAULT_INTERFACE_SLAB_HALF_WIDTH_M = 3.0e-3
DEFAULT_INTERFACE_MIN_POINTS = 8


def _parse_floats(raw: str | None) -> list[float]:
    if not raw:
        return []
    return [float(part) for part in raw.split()]


def _vec_sub(left: list[float], right: list[float]) -> list[float]:
    return [a - b for a, b in zip(left, right, strict=True)]


def _vec_norm(values: list[float]) -> float:
    return math.sqrt(sum(value * value for value in values))


def _bbox_center(minimum: list[float], maximum: list[float]) -> list[float]:
    return [(a + b) * 0.5 for a, b in zip(minimum, maximum, strict=True)]


def _bbox_extent(minimum: list[float], maximum: list[float]) -> list[float]:
    return [b - a for a, b in zip(minimum, maximum, strict=True)]


def _point_bbox_outside_distance(point: list[float], minimum: list[float], maximum: list[float]) -> float:
    outside = [
        max(minimum[index] - point[index], 0.0, point[index] - maximum[index])
        for index in range(3)
    ]
    return _vec_norm(outside)


def _cad_bbox_m(body: dict[str, Any]) -> tuple[list[float], list[float]]:
    bbox = body["bbox_mm"]
    minimum = [float(bbox["xmin"]) * 0.001, float(bbox["ymin"]) * 0.001, float(bbox["zmin"]) * 0.001]
    maximum = [float(bbox["xmax"]) * 0.001, float(bbox["ymax"]) * 0.001, float(bbox["zmax"]) * 0.001]
    return minimum, maximum


def _bbox_match_metrics(
    *,
    source_min_m: list[float],
    source_max_m: list[float],
    candidate_min_m: list[float],
    candidate_max_m: list[float],
) -> dict[str, Any]:
    source_center = _bbox_center(source_min_m, source_max_m)
    candidate_center = _bbox_center(candidate_min_m, candidate_max_m)
    source_extent = _bbox_extent(source_min_m, source_max_m)
    candidate_extent = _bbox_extent(candidate_min_m, candidate_max_m)
    center_delta = _vec_sub(candidate_center, source_center)
    extent_delta = _vec_sub(candidate_extent, source_extent)
    source_diag = max(_vec_norm(source_extent), 1.0e-12)
    extent_norm = max(_vec_norm(source_extent), 1.0e-12)

    overlap_extent = [
        max(0.0, min(source_max_m[index], candidate_max_m[index]) - max(source_min_m[index], candidate_min_m[index]))
        for index in range(3)
    ]
    source_volume = max(source_extent[0] * source_extent[1] * source_extent[2], 0.0)
    candidate_volume = max(candidate_extent[0] * candidate_extent[1] * candidate_extent[2], 0.0)
    intersection = overlap_extent[0] * overlap_extent[1] * overlap_extent[2]
    union = source_volume + candidate_volume - intersection
    iou = intersection / union if union > 0.0 else 0.0
    center_error = _vec_norm(center_delta)
    extent_error = _vec_norm(extent_delta)
    normalized_center_error = center_error / source_diag
    normalized_extent_error = extent_error / extent_norm
    score = normalized_center_error + normalized_extent_error + (1.0 - iou)
    return {
        "score": score,
        "center_error_m": center_error,
        "extent_error_m": extent_error,
        "normalized_center_error": normalized_center_error,
        "normalized_extent_error": normalized_extent_error,
        "bbox_iou": iou,
        "source_center_m": source_center,
        "candidate_center_m": candidate_center,
        "source_extent_m": source_extent,
        "candidate_extent_m": candidate_extent,
        "center_delta_m": center_delta,
        "extent_delta_m": extent_delta,
    }


def _mesh_asset_files(root: ET.Element) -> dict[str, str]:
    meshes: dict[str, str] = {}
    for mesh in root.findall(".//asset/mesh"):
        name = mesh.get("name")
        file_name = mesh.get("file")
        if name and file_name:
            meshes[name] = file_name
    return meshes


def _body_visual_link(body: ET.Element, mesh_files: dict[str, str]) -> str | None:
    for geom in body.findall("geom"):
        mesh_name = geom.get("mesh")
        if mesh_name and mesh_name in mesh_files:
            return Path(mesh_files[mesh_name]).stem.upper()
    return None


def _anchor_record(anchor_type: str, name: str | None, pos: list[float]) -> dict[str, Any] | None:
    if len(pos) != 3:
        return None
    return {
        "type": anchor_type,
        "name": name,
        "pos_m": [float(value) for value in pos],
    }


def _local_body_anchors(body: ET.Element) -> list[dict[str, Any]]:
    anchors: list[dict[str, Any]] = []
    origin = _anchor_record("link_origin", body.get("name"), [0.0, 0.0, 0.0])
    if origin:
        anchors.append(origin)
    for joint in body.findall("joint"):
        joint_anchor = _anchor_record("joint_origin", joint.get("name"), [0.0, 0.0, 0.0])
        if joint_anchor:
            joint_anchor["axis"] = _parse_floats(joint.get("axis"))
            joint_anchor["range_rad"] = _parse_floats(joint.get("range"))
            anchors.append(joint_anchor)
    for site in body.findall("site"):
        anchor = _anchor_record("site", site.get("name"), _parse_floats(site.get("pos")))
        if anchor:
            anchors.append(anchor)
    for geom in body.findall("geom"):
        fromto = _parse_floats(geom.get("fromto"))
        if len(fromto) == 6:
            start = _anchor_record("collision_endpoint", f"{geom.get('name')}:start", fromto[:3])
            end = _anchor_record("collision_endpoint", f"{geom.get('name')}:end", fromto[3:])
            if start:
                anchors.append(start)
            if end:
                anchors.append(end)
        pos = _parse_floats(geom.get("pos"))
        if len(pos) == 3 and (geom.get("mesh") or "collision" in (geom.get("name") or "")):
            anchor = _anchor_record("geom_origin", geom.get("name"), pos)
            if anchor:
                anchors.append(anchor)
    for child in body.findall("body"):
        anchor = _anchor_record("child_body_origin", child.get("name"), _parse_floats(child.get("pos")))
        if anchor:
            anchors.append(anchor)
    return anchors


def _collect_mjcf_spatial_anchors(mjcf_path: Path) -> dict[str, list[dict[str, Any]]]:
    if not mjcf_path.is_file():
        return {}
    root = ET.parse(mjcf_path).getroot()
    mesh_files = _mesh_asset_files(root)
    records: dict[str, list[dict[str, Any]]] = {}

    def walk(body: ET.Element) -> None:
        link = _body_visual_link(body, mesh_files)
        if link:
            records[link] = _local_body_anchors(body)
        for child in body.findall("body"):
            walk(child)

    worldbody = root.find("worldbody")
    if worldbody is not None:
        for body in worldbody.findall("body"):
            walk(body)
    return records


def _spatial_anchor_metrics(
    *,
    anchors: list[dict[str, Any]],
    source_min_m: list[float],
    source_max_m: list[float],
    candidate_min_m: list[float],
    candidate_max_m: list[float],
    tolerance_m: float,
) -> dict[str, Any]:
    records = []
    for anchor in anchors:
        point = [float(value) for value in anchor["pos_m"]]
        source_outside = _point_bbox_outside_distance(point, source_min_m, source_max_m)
        candidate_outside = _point_bbox_outside_distance(point, candidate_min_m, candidate_max_m)
        records.append(
            {
                "type": anchor.get("type"),
                "name": anchor.get("name"),
                "pos_m": point,
                "source_bbox_outside_m": source_outside,
                "candidate_bbox_outside_m": candidate_outside,
                "candidate_preserves_anchor": candidate_outside <= tolerance_m,
            }
        )
    source_outside_max = max((record["source_bbox_outside_m"] for record in records), default=None)
    candidate_outside_max = max(
        (record["candidate_bbox_outside_m"] for record in records),
        default=None,
    )
    rejected = any(not record["candidate_preserves_anchor"] for record in records)
    return {
        "anchor_count": len(records),
        "tolerance_m": tolerance_m,
        "source_bbox_outside_max_m": source_outside_max,
        "candidate_bbox_outside_max_m": candidate_outside_max,
        "candidate_anchor_rejected": rejected,
        "anchors": records,
    }


def _source_interface_profiles(
    *,
    link: str,
    stl_path: Path,
    slab_half_width_m: float,
    min_points: int,
) -> dict[str, Any]:
    specs = load_connection_specs()
    spec = specs.get(link, {})
    axis = str(spec.get("spine", "z"))
    axis_idx = AXIS_IDX.get(axis, 2)
    levels = load_reserved_levels(link)
    vertices = read_binary_stl_vertices(stl_path)
    records: list[dict[str, Any]] = []
    for level in levels:
        slab = vertices[abs(vertices[:, axis_idx] - float(level)) <= slab_half_width_m]
        if len(slab) < min_points:
            records.append(
                {
                    "level_m": float(level),
                    "source_point_count": int(len(slab)),
                    "source_profile_available": False,
                    "source_bbox_min_m": None,
                    "source_bbox_max_m": None,
                }
            )
            continue
        records.append(
            {
                "level_m": float(level),
                "source_point_count": int(len(slab)),
                "source_profile_available": True,
                "source_bbox_min_m": [float(value) for value in slab.min(axis=0)],
                "source_bbox_max_m": [float(value) for value in slab.max(axis=0)],
            }
        )
    return {
        "axis": axis,
        "axis_index": axis_idx,
        "slab_half_width_m": slab_half_width_m,
        "min_points": min_points,
        "reserved_level_count": len(levels),
        "profiles": records,
    }


def _bbox_containment_residual_m(
    *,
    inner_min_m: list[float],
    inner_max_m: list[float],
    outer_min_m: list[float],
    outer_max_m: list[float],
) -> float:
    residuals = []
    for index in range(3):
        residuals.append(max(float(outer_min_m[index]) - float(inner_min_m[index]), 0.0))
        residuals.append(max(float(inner_max_m[index]) - float(outer_max_m[index]), 0.0))
    return max(residuals, default=0.0)


def _interface_containment_metrics(
    *,
    source_profiles: dict[str, Any],
    candidate_min_m: list[float],
    candidate_max_m: list[float],
    tolerance_m: float,
) -> dict[str, Any]:
    records = []
    for profile in source_profiles["profiles"]:
        if not profile["source_profile_available"]:
            records.append(
                {
                    **profile,
                    "candidate_contains_source_interface_bbox": False,
                    "candidate_containment_residual_m": None,
                    "candidate_axis_level_outside_m": None,
                }
            )
            continue
        source_min = [float(value) for value in profile["source_bbox_min_m"]]
        source_max = [float(value) for value in profile["source_bbox_max_m"]]
        level = float(profile["level_m"])
        axis_idx = int(source_profiles["axis_index"])
        axis_outside = max(candidate_min_m[axis_idx] - level, 0.0, level - candidate_max_m[axis_idx])
        residual = max(
            _bbox_containment_residual_m(
                inner_min_m=source_min,
                inner_max_m=source_max,
                outer_min_m=candidate_min_m,
                outer_max_m=candidate_max_m,
            ),
            axis_outside,
        )
        records.append(
            {
                **profile,
                "candidate_contains_source_interface_bbox": residual <= tolerance_m,
                "candidate_containment_residual_m": float(residual),
                "candidate_axis_level_outside_m": float(axis_outside),
            }
        )
    available = [record for record in records if record["source_profile_available"]]
    rejected = any(
        not record["candidate_contains_source_interface_bbox"] for record in records
    )
    finite_residuals = [
        float(record["candidate_containment_residual_m"])
        for record in records
        if record["candidate_containment_residual_m"] is not None
    ]
    max_residual = max(finite_residuals, default=None)
    return {
        "axis": source_profiles["axis"],
        "reserved_level_count": int(source_profiles["reserved_level_count"]),
        "source_profiles_available": len(available),
        "tolerance_m": tolerance_m,
        "candidate_interface_rejected": rejected,
        "candidate_containment_residual_max_m": max_residual,
        "interfaces": records,
    }


def _candidate_matches_for_group(group: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for record in group.get("records", []):
        cad = record.get("cad", {})
        if not cad.get("loaded"):
            continue
        for body in cad.get("bodies", []):
            minimum, maximum = _cad_bbox_m(body)
            candidates.append(
                {
                    "source_step": record.get("path"),
                    "relative_path": record.get("relative_path"),
                    "fabrication_class": record.get("fabrication_class"),
                    "sha256": record.get("sha256"),
                    "cad_body_index": body.get("index"),
                    "volume_mm3": body.get("volume_mm3"),
                    "bbox_min_m": minimum,
                    "bbox_max_m": maximum,
                }
            )
    return candidates


def _candidate_matches_for_main_assembly(step_index: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    main_assembly = step_index.get("main_assembly_step", {})
    cad = main_assembly.get("cad", {})
    if not cad.get("loaded"):
        return candidates
    for body in cad.get("bodies", []):
        minimum, maximum = _cad_bbox_m(body)
        candidates.append(
            {
                "source_step": main_assembly.get("path"),
                "relative_path": main_assembly.get("relative_path"),
                "fabrication_class": "ASSEMBLY",
                "source_scope": "main_assembly",
                "sha256": main_assembly.get("sha256"),
                "cad_body_index": body.get("index"),
                "volume_mm3": body.get("volume_mm3"),
                "bbox_min_m": minimum,
                "bbox_max_m": maximum,
            }
        )
    return candidates


def build_fembot_body_matching_proof(
    body_groups: list[dict[str, Any]],
    *,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
    mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
    max_files_per_group: int | None = DEFAULT_MAX_FILES_PER_GROUP,
    top_matches_per_link: int = DEFAULT_TOP_MATCHES_PER_LINK,
    acceptance_score: float = DEFAULT_ACCEPTANCE_SCORE,
    spatial_anchor_tolerance_m: float = DEFAULT_SPATIAL_ANCHOR_TOLERANCE_M,
    interface_containment_tolerance_m: float = DEFAULT_INTERFACE_CONTAINMENT_TOLERANCE_M,
    interface_slab_half_width_m: float = DEFAULT_INTERFACE_SLAB_HALF_WIDTH_M,
    interface_min_points: int = DEFAULT_INTERFACE_MIN_POINTS,
    step_index_report: dict[str, Any] | None = None,
    include_main_assembly_candidates: bool = False,
) -> dict[str, Any]:
    step_index = step_index_report or build_fembot_step_body_index_proof(
        body_groups,
        max_files_per_group=max_files_per_group,
        include_main_assembly=include_main_assembly_candidates,
    )
    indexed_groups = {group["group"]: group for group in step_index.get("body_groups", [])}
    main_assembly_candidates = (
        _candidate_matches_for_main_assembly(step_index)
        if include_main_assembly_candidates
        else []
    )
    spatial_anchors_by_link = _collect_mjcf_spatial_anchors(mjcf_path)
    link_records: list[dict[str, Any]] = []
    missing_links: list[str] = []

    for group in body_groups:
        group_name = str(group.get("group"))
        candidate_bodies = _candidate_matches_for_group(indexed_groups.get(group_name, {}))
        if main_assembly_candidates:
            candidate_bodies = [*candidate_bodies, *main_assembly_candidates]
        for link in [str(link).upper() for link in group.get("links", [])]:
            stl_path = mesh_dir / f"{link}.STL"
            if not stl_path.is_file():
                missing_links.append(link)
                link_records.append(
                    {
                        "group": group_name,
                        "link": link,
                        "source_stl": str(stl_path),
                        "matched": False,
                        "accepted": False,
                        "blocking_reason": "source STL is missing",
                        "candidate_matches": [],
                    }
                )
                continue

            source = measure_surface_quality_for_stl(stl_path)
            source_min = [float(value) for value in source["bbox_min_m"]]
            source_max = [float(value) for value in source["bbox_max_m"]]
            spatial_anchors = spatial_anchors_by_link.get(link, [])
            source_interfaces = _source_interface_profiles(
                link=link,
                stl_path=stl_path,
                slab_half_width_m=interface_slab_half_width_m,
                min_points=interface_min_points,
            )
            matches = []
            for candidate in candidate_bodies:
                metrics = _bbox_match_metrics(
                    source_min_m=source_min,
                    source_max_m=source_max,
                    candidate_min_m=candidate["bbox_min_m"],
                    candidate_max_m=candidate["bbox_max_m"],
                )
                metrics["spatial_anchors"] = _spatial_anchor_metrics(
                    anchors=spatial_anchors,
                    source_min_m=source_min,
                    source_max_m=source_max,
                    candidate_min_m=candidate["bbox_min_m"],
                    candidate_max_m=candidate["bbox_max_m"],
                    tolerance_m=spatial_anchor_tolerance_m,
                )
                metrics["reserved_interfaces"] = _interface_containment_metrics(
                    source_profiles=source_interfaces,
                    candidate_min_m=candidate["bbox_min_m"],
                    candidate_max_m=candidate["bbox_max_m"],
                    tolerance_m=interface_containment_tolerance_m,
                )
                anchor_penalty = float(
                    metrics["spatial_anchors"]["candidate_bbox_outside_max_m"] or 0.0
                ) / max(_vec_norm(metrics["source_extent_m"]), 1.0e-12)
                interface_residual = metrics["reserved_interfaces"][
                    "candidate_containment_residual_max_m"
                ]
                interface_penalty = (
                    float(interface_residual) / max(_vec_norm(metrics["source_extent_m"]), 1.0e-12)
                    if interface_residual is not None
                    else 1.0
                )
                metrics["spatial_anchor_penalty"] = anchor_penalty
                metrics["reserved_interface_penalty"] = interface_penalty
                metrics["combined_score"] = (
                    float(metrics["score"]) + anchor_penalty + interface_penalty
                )
                matches.append({**candidate, "metrics": metrics})
            matches.sort(key=lambda item: float(item["metrics"]["combined_score"]))
            best = matches[0] if matches else None
            accepted = bool(best and float(best["metrics"]["score"]) <= acceptance_score)
            link_records.append(
                {
                    "group": group_name,
                    "link": link,
                    "source_stl": source["source_path"],
                    "source_sha256": source["source_sha256"],
                    "source_bbox_min_m": source_min,
                    "source_bbox_max_m": source_max,
                    "source_bbox_extent_m": source["bbox_extent_m"],
                    "spatial_anchor_count": len(spatial_anchors),
                    "reserved_interface_count": int(source_interfaces["reserved_level_count"]),
                    "source_interface_profiles_available": int(
                        sum(
                            1
                            for profile in source_interfaces["profiles"]
                            if profile["source_profile_available"]
                        )
                    ),
                    "matched": best is not None,
                    "accepted": accepted,
                    "best_score": float(best["metrics"]["score"]) if best else None,
                    "best_combined_score": float(best["metrics"]["combined_score"]) if best else None,
                    "best_match": best,
                    "candidate_match_count": len(matches),
                    "candidate_matches": matches[:top_matches_per_link],
                    "acceptance_score": acceptance_score,
                    "blocking_reason": None
                    if accepted
                    else (
                        "bounding-box ranking exists, but exact B-rep assignment requires "
                        "body identity, mate-interface residuals, and surface-fit error bounds"
                    ),
                }
            )

    matched = [record for record in link_records if record["matched"]]
    accepted_records = [record for record in link_records if record["accepted"]]
    anchored_records = [record for record in link_records if record.get("spatial_anchor_count", 0) > 0]
    anchor_rejected = [
        record
        for record in matched
        if record["best_match"]["metrics"]["spatial_anchors"]["candidate_anchor_rejected"]
    ]
    interface_rejected = [
        record
        for record in matched
        if record["best_match"]["metrics"]["reserved_interfaces"]["candidate_interface_rejected"]
    ]
    interface_residuals = [
        float(record["best_match"]["metrics"]["reserved_interfaces"]["candidate_containment_residual_max_m"])
        for record in matched
        if record["best_match"]["metrics"]["reserved_interfaces"]["candidate_containment_residual_max_m"]
        is not None
    ]
    ok = bool(step_index.get("ok") and len(link_records) == 28 and not missing_links)
    return {
        "schema": BODY_MATCHING_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "mesh_dir": str(mesh_dir),
            "mjcf": str(mjcf_path),
            "step_body_index_schema": step_index.get("schema"),
            "max_files_per_group": max_files_per_group,
            "spatial_anchor_tolerance_m": spatial_anchor_tolerance_m,
            "interface_containment_tolerance_m": interface_containment_tolerance_m,
            "interface_slab_half_width_m": interface_slab_half_width_m,
            "interface_min_points": interface_min_points,
            "include_main_assembly_candidates": include_main_assembly_candidates,
            "main_assembly_step": step_index.get("source", {}).get("main_step")
            or step_index.get("main_assembly_step", {}).get("path"),
        },
        "summary": {
            "links": len(link_records),
            "matched_links": len(matched),
            "accepted_link_matches": len(accepted_records),
            "missing_source_stls": sorted(set(missing_links)),
            "candidate_step_bodies": int(step_index.get("summary", {}).get("body_count", 0))
            + len(main_assembly_candidates),
            "fabrication_candidate_step_bodies": step_index.get("summary", {}).get(
                "body_count", 0
            ),
            "main_assembly_candidates_included": include_main_assembly_candidates,
            "main_assembly_candidate_bodies": len(main_assembly_candidates),
            "main_assembly_loaded": bool(
                step_index.get("summary", {}).get("main_assembly_loaded", False)
            ),
            "step_index_failed_step_files": step_index.get("summary", {}).get("failed_step_files", 0),
            "links_with_spatial_anchors": len(anchored_records),
            "best_match_anchor_rejected_links": len(anchor_rejected),
            "links_with_reserved_interfaces": sum(
                1 for record in link_records if record.get("reserved_interface_count", 0) > 0
            ),
            "best_match_interface_rejected_links": len(interface_rejected),
            "best_match_interface_residual_max_m": max(interface_residuals, default=None),
            "best_match_interface_residual_min_m": min(interface_residuals, default=None),
            "best_score_min": min((record["best_score"] for record in matched), default=None),
            "best_score_max": max((record["best_score"] for record in matched), default=None),
            "best_combined_score_min": min(
                (record["best_combined_score"] for record in matched),
                default=None,
            ),
            "best_combined_score_max": max(
                (record["best_combined_score"] for record in matched),
                default=None,
            ),
            "accepted": False,
            "acceptance_blocker": (
                "candidate STEP bodies are ranked against source STL envelopes, but exact "
                "B-rep link identity, mate-interface residuals, and surface-fit bounds "
                "are not accepted yet"
            ),
        },
        "link_matches": link_records,
    }


def dump_fembot_body_matching_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_body_matching_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-body-matching.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_body_matching_proof_json(report), encoding="utf-8")
    return output
