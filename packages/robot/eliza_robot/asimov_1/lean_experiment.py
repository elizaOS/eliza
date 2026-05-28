"""Experimental lean fork limits for the ASIMOV-1 parametric fembot model."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import numpy as np

from eliza_robot.asimov_1.fembot_mjcf import generate_fembot_mjcf
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_OUTPUT_STL, ASIMOV_PARAM_PROOFS
from eliza_robot.asimov_1.spline_fit_proof import load_connection_specs, load_reserved_levels

LEAN_EXPERIMENT_SCHEMA = "asimov-1-lean-experiment-proof-v1"
LEAN_EXPERIMENT_MJCF_PATH = (
    ASIMOV_PARAM_PROOFS.parent / "output" / "mjcf" / "asimov_fembot_lean_experiment.xml"
)
LEAN_EXPERIMENT_STL_DIR = ASIMOV_PARAM_PROOFS.parent / "output" / "stl-lean-experiment"
LEAN_EXPERIMENT_REPAIRED_STL_DIR = (
    ASIMOV_PARAM_PROOFS.parent / "output" / "stl-lean-experiment-repaired"
)

ARM_REQUESTED_NON_SPINE_SCALE = 0.84
LEG_REQUESTED_NON_SPINE_SCALE = 0.88
BALL_HOUSING_REQUESTED_NON_SPINE_SCALE = 0.90
HIP_SPACING_EXPERIMENT_SCALE = 0.30
SCALE_STEP = 0.01
SWEEP_EXTRA_STEPS = 6
HIP_SPACING_SWEEP_SCALES = (0.90, 0.75, 0.60, 0.45, 0.35, 0.30, 0.25, 0.20)

BALL_HOUSING_LINKS = frozenset(
    {
        "LEFT_SHOULDER_ROLL",
        "RIGHT_SHOULDER_ROLL",
        "LEFT_SHOULDER_YAW",
        "RIGHT_SHOULDER_YAW",
        "LEFT_HIP_ROLL",
        "RIGHT_HIP_ROLL",
        "LEFT_HIP_YAW",
        "RIGHT_HIP_YAW",
        "LEFT_ANKLE_A",
        "RIGHT_ANKLE_A",
        "LEFT_ANKLE_B",
        "RIGHT_ANKLE_B",
    }
)

GROUP_REQUESTED_SCALE = {
    "arm": ARM_REQUESTED_NON_SPINE_SCALE,
    "leg": LEG_REQUESTED_NON_SPINE_SCALE,
}
TOPOLOGY_OK_REQUIRED_LINKS = 28
RESERVED_INTERFACE_TOLERANCE_M = 0.003
REPAIR_DIAGNOSTIC_MAX_FACES = 20_000
TOE_COMPONENT_HULL_VOLUME_RATIO_LIMIT = 1.30
TOE_LINKS = frozenset({"LEFT_TOE", "RIGHT_TOE"})
HIP_PITCH_ELLIPSOID_VOLUME_RATIO_LIMIT = 1.20
HIP_PITCH_LINKS = frozenset({"LEFT_HIP_PITCH", "RIGHT_HIP_PITCH"})
SECTION_LOFT_LINKS = frozenset(
    {
        "IMU_ORIGIN",
        "LEFT_ANKLE_B",
        "LEFT_HIP_PITCH",
        "LEFT_SHOULDER_ROLL",
        "RIGHT_ANKLE_B",
        "RIGHT_HIP_PITCH",
        "RIGHT_SHOULDER_ROLL",
    }
)
SECTION_LOFT_VOLUME_RATIO_LIMITS = {
    "IMU_ORIGIN": 1.08,
    "LEFT_ANKLE_B": 1.08,
    "LEFT_HIP_PITCH": 0.95,
    "LEFT_SHOULDER_ROLL": 1.10,
    "RIGHT_ANKLE_B": 1.08,
    "RIGHT_HIP_PITCH": 0.95,
    "RIGHT_SHOULDER_ROLL": 1.10,
}
SECTION_LOFT_MIN_VOLUME_RATIO = 0.75
SECTION_LOFT_FIT_P95_LIMITS_M = {
    "IMU_ORIGIN": 0.024,
    "LEFT_ANKLE_B": 0.019,
    "LEFT_HIP_PITCH": 0.018,
    "LEFT_SHOULDER_ROLL": 0.018,
    "RIGHT_ANKLE_B": 0.019,
    "RIGHT_HIP_PITCH": 0.018,
    "RIGHT_SHOULDER_ROLL": 0.018,
}
SECTION_LOFT_SUPPORT_PERCENTILES = {
    "LEFT_ANKLE_B": 80.0,
    "LEFT_HIP_PITCH": 85.0,
    "RIGHT_ANKLE_B": 80.0,
    "RIGHT_HIP_PITCH": 85.0,
}
SECTION_LOFT_MIN_VOLUME_RATIO_LIMITS = {
    "LEFT_SHOULDER_ROLL": 0.70,
    "RIGHT_SHOULDER_ROLL": 0.70,
}
SECTION_LOFT_BBOX_DELTA_LIMITS_M = {
    "LEFT_ANKLE_B": 0.010,
    "RIGHT_ANKLE_B": 0.010,
}
SECTION_LOFT_INTERFACE_TOLERANCE_LIMITS_M = {
    "IMU_ORIGIN": 0.007,
    "LEFT_ANKLE_B": 0.0035,
    "RIGHT_ANKLE_B": 0.0035,
}
SECTION_LOFT_INTERFACE_GUARD_LINKS = frozenset(
    {
        "IMU_ORIGIN",
        "LEFT_ANKLE_B",
        "LEFT_HIP_PITCH",
        "LEFT_SHOULDER_ROLL",
        "RIGHT_ANKLE_B",
        "RIGHT_HIP_PITCH",
        "RIGHT_SHOULDER_ROLL",
    }
)


def _load_frontier(path: Path = ASIMOV_PARAM_PROOFS / "fembot-thinness-frontier.json") -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _frontier_report(frontier_report: dict[str, Any] | None = None) -> dict[str, Any]:
    if frontier_report is not None:
        return frontier_report
    cached = _load_frontier()
    if cached is not None:
        return cached
    from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory
    from eliza_robot.asimov_1.fembot_thinness_frontier import (
        build_fembot_thinness_frontier_proof,
    )

    inventory = collect_fembot_inventory()
    return build_fembot_thinness_frontier_proof(inventory["body_groups"])


def _requested_scale(link: str, group: str) -> float | None:
    candidates: list[float] = []
    if group in GROUP_REQUESTED_SCALE:
        candidates.append(GROUP_REQUESTED_SCALE[group])
    if link in BALL_HOUSING_LINKS:
        candidates.append(BALL_HOUSING_REQUESTED_NON_SPINE_SCALE)
    if not candidates:
        return None
    return min(candidates)


def _sweep_scale(source: float, minimum: float) -> float:
    if source <= 0.0:
        return 1.0
    lower_bound = max(0.0, min(1.0, minimum / source))
    scale = 1.0
    while scale - SCALE_STEP >= lower_bound - 1.0e-12:
        scale = round(scale - SCALE_STEP, 2)
    return scale


def _link_experiment_record(record: dict[str, Any]) -> dict[str, Any] | None:
    link = str(record["link"]).upper()
    group = str(record["group"])
    requested = _requested_scale(link, group)
    if requested is None:
        return None

    source_extents = [float(value) for value in record["source_bbox_extent_m"]]
    adjusted_extents = [float(value) for value in record["clearance_adjusted_bbox_extent_m"]]
    non_spine_axes = (0, 1)
    safe_axis_scales = [
        _sweep_scale(source_extents[axis], adjusted_extents[axis])
        for axis in non_spine_axes
    ]
    frontier_scale = max(safe_axis_scales)
    selected = max(requested, frontier_scale)
    target_extents = list(source_extents)
    for axis in non_spine_axes:
        target_extents[axis] = source_extents[axis] * selected
    axis_clearance_margins = [
        target_extents[axis] - adjusted_extents[axis]
        for axis in non_spine_axes
    ]
    limiters = [
        limiter
        for limiter in record.get("active_limiters", [])
        if limiter != "z_height_preservation"
    ]
    return {
        "link": link,
        "group": group,
        "categories": [
            category
            for category, enabled in (
                ("arm", group == "arm"),
                ("leg", group == "leg"),
                ("ball_housing", link in BALL_HOUSING_LINKS),
            )
            if enabled
        ],
        "requested_non_spine_scale": requested,
        "frontier_safe_non_spine_scale": frontier_scale,
        "selected_non_spine_scale": selected,
        "source_bbox_extent_m": source_extents,
        "clearance_adjusted_bbox_extent_m": adjusted_extents,
        "target_bbox_extent_m": target_extents,
        "axis_clearance_margin_m": axis_clearance_margins,
        "minimum_axis_clearance_margin_m": min(axis_clearance_margins),
        "z_height_preserved": True,
        "active_limiters": limiters,
        "fully_requested_scale_accepted": requested >= frontier_scale and not limiters,
        "procedural_action": (
            "apply connection-weighted procedural non-spine scale field to the current "
            "parametric shell; reserved mate levels remain unscaled"
        ),
    }


def _category_summary(records: list[dict[str, Any]], category: str) -> dict[str, Any]:
    selected = [record for record in records if category in record["categories"]]
    if not selected:
        return {
            "category": category,
            "links": 0,
            "minimum_selected_non_spine_scale": None,
            "maximum_selected_non_spine_scale": None,
            "fully_requested_links": 0,
            "limited_links": [],
        }
    limited = [
        record["link"]
        for record in selected
        if not record["fully_requested_scale_accepted"]
    ]
    return {
        "category": category,
        "links": len(selected),
        "minimum_selected_non_spine_scale": min(
            float(record["selected_non_spine_scale"]) for record in selected
        ),
        "maximum_selected_non_spine_scale": max(
            float(record["selected_non_spine_scale"]) for record in selected
        ),
        "fully_requested_links": len(selected) - len(limited),
        "limited_links": limited,
    }


def _scale_sweep_records(records: list[dict[str, Any]]) -> dict[str, Any]:
    link_sweeps = []
    accepted_requested = 0
    accepted_tighter_than_selected = 0
    for record in records:
        source_extents = [float(value) for value in record["source_bbox_extent_m"]]
        adjusted_extents = [
            float(value) for value in record["clearance_adjusted_bbox_extent_m"]
        ]
        requested = float(record["requested_non_spine_scale"])
        selected = float(record["selected_non_spine_scale"])
        frontier = float(record["frontier_safe_non_spine_scale"])
        tested_scales = sorted(
            {
                round(value, 2)
                for value in [
                    requested,
                    selected,
                    frontier,
                    *np.linspace(max(0.01, frontier - 0.12), min(1.0, frontier + 0.02), 15),
                    *(
                        max(0.0, selected - SCALE_STEP * step)
                        for step in range(1, SWEEP_EXTRA_STEPS + 1)
                    ),
                    *(
                        min(1.0, selected + SCALE_STEP * step)
                        for step in range(1, 3)
                    ),
                ]
                if 0.0 < value <= 1.0
            }
        )
        tests = []
        for scale in tested_scales:
            target_extents = list(source_extents)
            margins = []
            for axis in (0, 1):
                target_extents[axis] = source_extents[axis] * scale
                margins.append(target_extents[axis] - adjusted_extents[axis])
            axis_pass = all(margin >= -1.0e-12 for margin in margins)
            tests.append(
                {
                    "scale": scale,
                    "target_bbox_extent_m": target_extents,
                    "axis_clearance_margin_m": margins,
                    "minimum_axis_clearance_margin_m": min(margins),
                    "passes_axis_clearance": axis_pass,
                    "passes_known_frontier": bool(scale >= frontier - 1.0e-12),
                    "accepted_by_sweep": bool(axis_pass and scale >= frontier - 1.0e-12),
                }
            )
        accepted_tests = [test for test in tests if test["accepted_by_sweep"]]
        rejected_tests = [test for test in tests if not test["accepted_by_sweep"]]
        minimum_accepted = min(
            (float(test["scale"]) for test in accepted_tests),
            default=None,
        )
        contiguous_minimum_accepted = None
        encountered_selected = False
        for test in sorted(tests, key=lambda item: float(item["scale"]), reverse=True):
            scale = float(test["scale"])
            if scale <= selected + 1.0e-12:
                encountered_selected = True
            if not encountered_selected:
                continue
            if not test["accepted_by_sweep"]:
                break
            contiguous_minimum_accepted = scale
        maximum_rejected_below_frontier = max(
            (
                float(test["scale"])
                for test in rejected_tests
                if float(test["scale"]) < selected
            ),
            default=None,
        )
        requested_test = next(
            (test for test in tests if abs(float(test["scale"]) - requested) <= 1.0e-12),
            None,
        )
        if requested_test and requested_test["accepted_by_sweep"]:
            accepted_requested += 1
        if any(
            test["accepted_by_sweep"] and float(test["scale"]) < selected - 1.0e-12
            for test in tests
        ):
            accepted_tighter_than_selected += 1
        link_sweeps.append(
            {
                "link": record["link"],
                "group": record["group"],
                "categories": record["categories"],
                "requested_non_spine_scale": requested,
                "selected_non_spine_scale": selected,
                "frontier_safe_non_spine_scale": frontier,
                "minimum_accepted_tested_scale": minimum_accepted,
                "contiguous_minimum_accepted_tested_scale": contiguous_minimum_accepted,
                "requested_scale_accepted_by_sweep": bool(
                    requested_test and requested_test["accepted_by_sweep"]
                ),
                "maximum_rejected_tested_scale_below_selected": maximum_rejected_below_frontier,
                "tested_scale_count": len(tests),
                "tests": tests,
            }
        )
    return {
        "enabled": True,
        "links": len(link_sweeps),
        "sweep_extra_steps": SWEEP_EXTRA_STEPS,
        "scale_step": SCALE_STEP,
        "requested_scale_accepted_links": accepted_requested,
        "requested_scale_rejected_links": len(link_sweeps) - accepted_requested,
        "accepted_tighter_than_selected_links": accepted_tighter_than_selected,
        "records": link_sweeps,
        "ok": bool(len(link_sweeps) == len(records)),
    }


def _load_mesh(path: Path) -> Any:
    import trimesh

    mesh = trimesh.load(path, force="mesh", process=False)
    if not hasattr(mesh, "vertices") or not hasattr(mesh, "faces"):
        raise ValueError(f"{path} did not load as a mesh")
    return mesh


def _bbox_extent(mesh: Any) -> list[float]:
    return [float(value) for value in (mesh.bounds[1] - mesh.bounds[0])]


def _topology_record(mesh: Any) -> dict[str, Any]:
    checked = mesh.copy()
    checked.merge_vertices()
    try:
        import trimesh

        trimesh.repair.fix_winding(checked)
        trimesh.repair.fix_normals(checked)
    except Exception:
        pass
    edges = np.asarray(checked.edges_sorted)
    if len(edges):
        _, edge_counts = np.unique(edges, axis=0, return_counts=True)
        boundary_edges = int(np.sum(edge_counts == 1))
        nonmanifold_edges = int(np.sum(edge_counts > 2))
    else:
        boundary_edges = 0
        nonmanifold_edges = 0
    components = checked.split(only_watertight=False)
    largest_component_faces = max((len(component.faces) for component in components), default=0)
    return {
        "watertight": bool(checked.is_watertight),
        "winding_consistent": bool(checked.is_winding_consistent),
        "euler_number": int(checked.euler_number),
        "body_count": int(len(components)),
        "largest_component_faces": int(largest_component_faces),
        "boundary_edges": boundary_edges,
        "nonmanifold_edges": nonmanifold_edges,
        "vertices": int(len(checked.vertices)),
        "faces": int(len(checked.faces)),
        "volume_m3": float(checked.volume),
        "ok": bool(checked.is_watertight and len(checked.vertices) > 0 and len(checked.faces) > 0),
    }


def _topology_record_without_vertex_merge(mesh: Any) -> dict[str, Any]:
    checked = mesh.copy()
    try:
        import trimesh

        trimesh.repair.fix_winding(checked)
        trimesh.repair.fix_normals(checked)
    except Exception:
        pass
    edges = np.asarray(checked.edges_sorted)
    if len(edges):
        _, edge_counts = np.unique(edges, axis=0, return_counts=True)
        boundary_edges = int(np.sum(edge_counts == 1))
        nonmanifold_edges = int(np.sum(edge_counts > 2))
    else:
        boundary_edges = 0
        nonmanifold_edges = 0
    components = checked.split(only_watertight=False)
    largest_component_faces = max((len(component.faces) for component in components), default=0)
    return {
        "watertight": bool(checked.is_watertight),
        "winding_consistent": bool(checked.is_winding_consistent),
        "euler_number": int(checked.euler_number),
        "body_count": int(len(components)),
        "largest_component_faces": int(largest_component_faces),
        "boundary_edges": boundary_edges,
        "nonmanifold_edges": nonmanifold_edges,
        "vertices": int(len(checked.vertices)),
        "faces": int(len(checked.faces)),
        "volume_m3": float(checked.volume),
        "ok": bool(checked.is_watertight and len(checked.vertices) > 0 and len(checked.faces) > 0),
    }


def _repair_candidate_record(mesh: Any, *, reference_extent: list[float]) -> dict[str, Any]:
    import trimesh

    if len(mesh.faces) > REPAIR_DIAGNOSTIC_MAX_FACES:
        return {
            "attempted": False,
            "skipped": True,
            "safe_candidate": False,
            "face_count": int(len(mesh.faces)),
            "face_count_limit": REPAIR_DIAGNOSTIC_MAX_FACES,
            "blocking_reason": "mesh exceeds bounded automatic repair diagnostic face limit",
        }
    candidate = mesh.copy()
    before_topology = _topology_record(candidate)
    candidate.merge_vertices()
    trimesh.repair.fix_winding(candidate)
    trimesh.repair.fix_normals(candidate)
    fill_holes_returned = bool(trimesh.repair.fill_holes(candidate))
    trimesh.repair.fix_normals(candidate)
    after_topology = _topology_record(candidate)
    repaired_extent = _bbox_extent(candidate)
    bbox_extent_delta = max(
        abs(float(a) - float(b))
        for a, b in zip(repaired_extent, reference_extent, strict=True)
    )
    safe_candidate = bool(
        after_topology["watertight"]
        and bbox_extent_delta <= RESERVED_INTERFACE_TOLERANCE_M
    )
    return {
        "attempted": True,
        "method": "merge_vertices_fix_winding_fix_normals_fill_holes",
        "fill_holes_returned": fill_holes_returned,
        "before_topology": before_topology,
        "after_topology": after_topology,
        "repaired_bbox_extent_m": repaired_extent,
        "bbox_extent_delta_m": bbox_extent_delta,
        "safe_candidate": safe_candidate,
        "blocking_reason": None
        if safe_candidate
        else "automatic hole fill did not produce a watertight bbox-preserving candidate",
    }


def _make_repaired_mesh(mesh: Any) -> Any:
    import trimesh

    candidate = mesh.copy()
    candidate.merge_vertices()
    trimesh.repair.fix_winding(candidate)
    trimesh.repair.fix_normals(candidate)
    trimesh.repair.fill_holes(candidate)
    trimesh.repair.fix_normals(candidate)
    return candidate


def _make_component_convex_hull_mesh(mesh: Any) -> Any:
    import trimesh

    processed = trimesh.Trimesh(
        vertices=np.asarray(mesh.vertices),
        faces=np.asarray(mesh.faces),
        process=True,
    )
    hulls = []
    for component in processed.split(only_watertight=False):
        try:
            hull = trimesh.Trimesh(
                vertices=component.convex_hull.vertices,
                faces=component.convex_hull.faces,
                process=True,
            )
            trimesh.repair.fix_winding(hull)
            trimesh.repair.fix_normals(hull)
            if hull.is_watertight:
                hulls.append(hull)
        except Exception:
            continue
    if not hulls:
        raise ValueError("no watertight component hulls could be generated")
    return trimesh.util.concatenate(hulls)


def _component_hull_candidate_record(
    mesh: Any,
    *,
    link: str,
    reference_extent: list[float],
) -> dict[str, Any]:
    import trimesh

    processed = trimesh.Trimesh(
        vertices=np.asarray(mesh.vertices),
        faces=np.asarray(mesh.faces),
        process=True,
    )
    candidate = _make_component_convex_hull_mesh(mesh)
    topology = _topology_record_without_vertex_merge(candidate)
    merged_topology = _topology_record(candidate)
    repaired_extent = _bbox_extent(candidate)
    bbox_extent_delta = max(
        abs(float(a) - float(b))
        for a, b in zip(repaired_extent, reference_extent, strict=True)
    )
    volume_ratio = abs(float(candidate.volume)) / max(abs(float(processed.volume)), 1.0e-12)
    limit = TOE_COMPONENT_HULL_VOLUME_RATIO_LIMIT if link in TOE_LINKS else 1.10
    safe_candidate = bool(
        topology["watertight"]
        and bbox_extent_delta <= RESERVED_INTERFACE_TOLERANCE_M
        and volume_ratio <= limit
        and link in TOE_LINKS
    )
    return {
        "method": "component_convex_hulls",
        "topology": topology,
        "merged_vertex_topology": merged_topology,
        "repaired_bbox_extent_m": repaired_extent,
        "bbox_extent_delta_m": bbox_extent_delta,
        "volume_ratio": volume_ratio,
        "volume_ratio_limit": limit,
        "safe_candidate": safe_candidate,
        "rejection_reason": None
        if safe_candidate
        else "component hull candidate is not toe-only, bbox-preserving, watertight, and volume-bounded",
    }


def _make_ellipsoid_envelope_mesh(mesh: Any) -> Any:
    import trimesh

    center = mesh.bounds.mean(axis=0)
    extents = mesh.extents
    candidate = trimesh.creation.uv_sphere(count=[32, 16], radius=1.0)
    candidate.apply_scale(extents / 2.0)
    candidate.apply_translation(center)
    candidate.merge_vertices()
    trimesh.repair.fix_winding(candidate)
    trimesh.repair.fix_normals(candidate)
    return candidate


def _ellipsoid_candidate_record(
    mesh: Any,
    *,
    link: str,
    reference_extent: list[float],
) -> dict[str, Any]:
    candidate = _make_ellipsoid_envelope_mesh(mesh)
    topology = _topology_record(candidate)
    repaired_extent = _bbox_extent(candidate)
    bbox_extent_delta = max(
        abs(float(a) - float(b))
        for a, b in zip(repaired_extent, reference_extent, strict=True)
    )
    volume_ratio = abs(float(candidate.volume)) / max(abs(float(mesh.volume)), 1.0e-12)
    safe_candidate = bool(
        topology["watertight"]
        and bbox_extent_delta <= RESERVED_INTERFACE_TOLERANCE_M
        and volume_ratio <= HIP_PITCH_ELLIPSOID_VOLUME_RATIO_LIMIT
        and link in HIP_PITCH_LINKS
    )
    return {
        "method": "ellipsoid_envelope",
        "topology": topology,
        "repaired_bbox_extent_m": repaired_extent,
        "bbox_extent_delta_m": bbox_extent_delta,
        "volume_ratio": volume_ratio,
        "volume_ratio_limit": HIP_PITCH_ELLIPSOID_VOLUME_RATIO_LIMIT,
        "safe_candidate": safe_candidate,
        "rejection_reason": None
        if safe_candidate
        else "ellipsoid candidate is not hip-pitch-only, bbox-preserving, watertight, and volume-bounded",
    }


def _make_section_loft_envelope_mesh(mesh: Any, *, link: str) -> Any:
    import trimesh

    connection_specs = load_connection_specs()
    spine = str(connection_specs.get(link, {}).get("spine", "z"))
    spine_axis = {"x": 0, "y": 1, "z": 2}[spine]
    profile_axes = [axis for axis in range(3) if axis != spine_axis]
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    bounds = np.asarray(mesh.bounds, dtype=np.float64)
    lower = float(bounds[0, spine_axis])
    upper = float(bounds[1, spine_axis])
    reference_center = bounds.mean(axis=0)
    reference_extent = bounds[1] - bounds[0]

    reserved_levels = [
        float(level) for level in load_reserved_levels(link) if lower <= float(level) <= upper
    ]
    section_levels: list[float] = list(np.linspace(lower, upper, 40))
    for reserved_level in reserved_levels:
        if lower <= reserved_level <= upper:
            section_levels.extend(
                [
                    max(lower, float(reserved_level) - 0.004),
                    float(reserved_level),
                    min(upper, float(reserved_level) + 0.004),
                ]
            )
    section_levels = sorted({round(level, 6) for level in section_levels})
    slab_half_width = max((upper - lower) / 40.0 * 2.0, 0.005)
    segment_count = 72
    angles = np.linspace(0.0, 2.0 * np.pi, segment_count, endpoint=False)
    directions = np.column_stack([np.cos(angles), np.sin(angles)])
    support_percentile = SECTION_LOFT_SUPPORT_PERCENTILES.get(link, 95.0)
    rings: list[np.ndarray] = []
    guarded_rings: list[bool] = []
    for level in section_levels:
        slab = vertices[np.abs(vertices[:, spine_axis] - level) <= slab_half_width]
        if len(slab) < 8:
            nearest = np.argsort(np.abs(vertices[:, spine_axis] - level))[:200]
            slab = vertices[nearest]
        profile_points = slab[:, profile_axes]
        guarded = bool(
            link in SECTION_LOFT_INTERFACE_GUARD_LINKS
            and any(abs(level - reserved_level) <= 0.0041 for reserved_level in reserved_levels)
        )
        if guarded:
            guard_slab = vertices[np.abs(vertices[:, spine_axis] - level) <= 0.006]
            if len(guard_slab) < 8:
                guard_slab = slab
            local_min = guard_slab[:, profile_axes].min(axis=0)
            local_max = guard_slab[:, profile_axes].max(axis=0)
            profile_center = (local_min + local_max) / 2.0
            support = np.maximum((local_max - local_min) / 2.0, 0.0015)
            profile = profile_center + directions * support
        else:
            profile_center = (
                np.percentile(profile_points, 5.0, axis=0)
                + np.percentile(profile_points, 95.0, axis=0)
            ) / 2.0
            relative = profile_points - profile_center
            support = np.percentile(relative @ directions.T, support_percentile, axis=0)
            support = np.maximum(support, 0.002)
            support = (np.roll(support, 1) + 2.0 * support + np.roll(support, -1)) / 4.0
            profile = profile_center + directions * support[:, None]
        ring = np.zeros((segment_count, 3), dtype=np.float64)
        ring[:, spine_axis] = level
        ring[:, profile_axes] = profile
        rings.append(ring)
        guarded_rings.append(guarded)

    loft_vertices = np.vstack(rings)
    current_lower = loft_vertices.min(axis=0)
    current_upper = loft_vertices.max(axis=0)
    current_center = (current_lower + current_upper) / 2.0
    current_extent = current_upper - current_lower
    scale = np.ones(3, dtype=np.float64)
    nonzero = current_extent > 1.0e-12
    scale[nonzero] = reference_extent[nonzero] / current_extent[nonzero]
    loft_vertices = reference_center + (loft_vertices - current_center) * scale
    for ring_index, (level, guarded) in enumerate(zip(section_levels, guarded_rings, strict=True)):
        if not guarded:
            continue
        guard_slab = vertices[np.abs(vertices[:, spine_axis] - level) <= 0.006]
        if len(guard_slab) < 8:
            nearest = np.argsort(np.abs(vertices[:, spine_axis] - level))[:200]
            guard_slab = vertices[nearest]
        local_min = guard_slab[:, profile_axes].min(axis=0)
        local_max = guard_slab[:, profile_axes].max(axis=0)
        profile_center = (local_min + local_max) / 2.0
        support = np.maximum((local_max - local_min) / 2.0, 0.0015)
        profile = profile_center + directions * support
        offset = ring_index * segment_count
        loft_vertices[offset : offset + segment_count, spine_axis] = level
        for profile_column, axis in enumerate(profile_axes):
            loft_vertices[offset : offset + segment_count, axis] = profile[:, profile_column]

    faces: list[list[int]] = []
    for ring_index in range(len(rings) - 1):
        lower_offset = ring_index * segment_count
        upper_offset = (ring_index + 1) * segment_count
        for segment_index in range(segment_count):
            next_segment = (segment_index + 1) % segment_count
            faces.append(
                [
                    lower_offset + segment_index,
                    lower_offset + next_segment,
                    upper_offset + next_segment,
                ]
            )
            faces.append(
                [
                    lower_offset + segment_index,
                    upper_offset + next_segment,
                    upper_offset + segment_index,
                ]
            )
    loft_vertices = np.vstack(
        [
            loft_vertices,
            loft_vertices[:segment_count].mean(axis=0),
            loft_vertices[-segment_count:].mean(axis=0),
        ]
    )
    start_center_index = len(loft_vertices) - 2
    end_center_index = len(loft_vertices) - 1
    end_offset = (len(rings) - 1) * segment_count
    for segment_index in range(segment_count):
        next_segment = (segment_index + 1) % segment_count
        faces.append([start_center_index, next_segment, segment_index])
        faces.append([end_center_index, end_offset + segment_index, end_offset + next_segment])

    candidate = trimesh.Trimesh(
        vertices=loft_vertices,
        faces=np.asarray(faces, dtype=np.int64),
        process=True,
    )
    candidate.merge_vertices()
    trimesh.repair.fix_winding(candidate)
    trimesh.repair.fix_normals(candidate)
    return candidate


def _vertex_fit_metrics(source_mesh: Any, candidate_mesh: Any) -> dict[str, float | bool | str]:
    try:
        from scipy.spatial import cKDTree
    except Exception as exc:
        return {
            "available": False,
            "error": str(exc),
            "source_to_candidate_p95_m": float("inf"),
            "candidate_to_source_p95_m": float("inf"),
            "max_p95_m": float("inf"),
        }

    source_vertices = np.asarray(source_mesh.vertices, dtype=np.float64)
    candidate_vertices = np.asarray(candidate_mesh.vertices, dtype=np.float64)
    source_distances, _ = cKDTree(candidate_vertices).query(source_vertices, workers=-1)
    candidate_distances, _ = cKDTree(source_vertices).query(candidate_vertices, workers=-1)
    source_p95 = float(np.percentile(source_distances, 95.0))
    candidate_p95 = float(np.percentile(candidate_distances, 95.0))
    return {
        "available": True,
        "source_to_candidate_p95_m": source_p95,
        "candidate_to_source_p95_m": candidate_p95,
        "max_p95_m": max(source_p95, candidate_p95),
    }


def _section_loft_candidate_record(
    mesh: Any,
    *,
    link: str,
    reference_extent: list[float],
) -> dict[str, Any]:
    candidate = _make_section_loft_envelope_mesh(mesh, link=link)
    topology = _topology_record(candidate)
    repaired_extent = _bbox_extent(candidate)
    bbox_extent_delta = max(
        abs(float(a) - float(b))
        for a, b in zip(repaired_extent, reference_extent, strict=True)
    )
    volume_ratio = abs(float(candidate.volume)) / max(abs(float(mesh.volume)), 1.0e-12)
    fit_metrics = _vertex_fit_metrics(mesh, candidate)
    volume_ratio_limit = SECTION_LOFT_VOLUME_RATIO_LIMITS.get(link, 1.10)
    minimum_volume_ratio = SECTION_LOFT_MIN_VOLUME_RATIO_LIMITS.get(
        link,
        SECTION_LOFT_MIN_VOLUME_RATIO,
    )
    fit_p95_limit = SECTION_LOFT_FIT_P95_LIMITS_M.get(link, 0.012)
    bbox_delta_limit = SECTION_LOFT_BBOX_DELTA_LIMITS_M.get(
        link,
        RESERVED_INTERFACE_TOLERANCE_M,
    )
    interface_tolerance = SECTION_LOFT_INTERFACE_TOLERANCE_LIMITS_M.get(
        link,
        RESERVED_INTERFACE_TOLERANCE_M,
    )
    axis = str(load_connection_specs().get(link, {}).get("spine", "z"))
    interface_preservation = _interface_preservation_records(
        source_mesh=mesh,
        output_mesh=candidate,
        link=link,
        axis_name=axis,
    )
    max_interface_bbox_delta = max(
        (
            float(record["bbox_delta_m"])
            for record in interface_preservation
            if record["bbox_delta_m"] is not None
        ),
        default=None,
    )
    interface_ok = bool(
        interface_preservation
        and all(
            record["bbox_delta_m"] is not None
            and float(record["bbox_delta_m"]) <= interface_tolerance
            for record in interface_preservation
        )
    )
    safe_candidate = bool(
        topology["watertight"]
        and bbox_extent_delta <= bbox_delta_limit
        and interface_ok
        and minimum_volume_ratio <= volume_ratio <= volume_ratio_limit
        and fit_metrics.get("available")
        and float(fit_metrics["max_p95_m"]) <= fit_p95_limit
        and link in SECTION_LOFT_LINKS
    )
    return {
        "method": "section_loft_envelope",
        "topology": topology,
        "repaired_bbox_extent_m": repaired_extent,
        "bbox_extent_delta_m": bbox_extent_delta,
        "bbox_extent_delta_limit_m": bbox_delta_limit,
        "volume_ratio": volume_ratio,
        "minimum_volume_ratio": minimum_volume_ratio,
        "volume_ratio_limit": volume_ratio_limit,
        "support_percentile": SECTION_LOFT_SUPPORT_PERCENTILES.get(link, 95.0),
        "interface_preservation": interface_preservation,
        "interface_tolerance_m": interface_tolerance,
        "interface_ok": interface_ok,
        "max_interface_bbox_delta_m": max_interface_bbox_delta,
        "fit_metrics": fit_metrics,
        "fit_p95_limit_m": fit_p95_limit,
        "safe_candidate": safe_candidate,
        "rejection_reason": None
        if safe_candidate
        else (
            "section loft candidate is not an allowed link, bbox-preserving, "
            "watertight, volume-bounded, and vertex-fit-bounded"
        ),
    }


def _repair_experiment_record(mesh: Any, *, link: str, reference_extent: list[float]) -> dict[str, Any]:
    import trimesh

    experiments = []
    base = mesh.copy()
    base.merge_vertices()

    for method in (
        "stitch_broken_faces",
        "convex_hull",
        "component_convex_hulls",
        "ellipsoid_envelope",
        "section_loft_envelope",
    ):
        try:
            if method == "section_loft_envelope":
                if link not in SECTION_LOFT_LINKS:
                    experiments.append(
                        {
                            "method": method,
                            "ok": True,
                            "safe_candidate": False,
                            "skipped": True,
                            "rejection_reason": "section loft proxy is restricted to validated guarded-loft links",
                        }
                    )
                    continue
                section_record = _section_loft_candidate_record(
                    mesh,
                    link=link,
                    reference_extent=reference_extent,
                )
                experiments.append({"ok": True, **section_record})
                continue
            if method == "ellipsoid_envelope":
                if link not in HIP_PITCH_LINKS:
                    experiments.append(
                        {
                            "method": method,
                            "ok": True,
                            "safe_candidate": False,
                            "skipped": True,
                            "rejection_reason": "ellipsoid proxy is currently restricted to hip-pitch links",
                        }
                    )
                    continue
                ellipsoid_record = _ellipsoid_candidate_record(
                    mesh,
                    link=link,
                    reference_extent=reference_extent,
                )
                experiments.append({"ok": True, **ellipsoid_record})
                continue
            if method == "component_convex_hulls":
                if link not in TOE_LINKS:
                    experiments.append(
                        {
                            "method": method,
                            "ok": True,
                            "safe_candidate": False,
                            "skipped": True,
                            "rejection_reason": "component hull proxy is currently restricted to toe links",
                        }
                    )
                    continue
                component_record = _component_hull_candidate_record(
                    mesh,
                    link=link,
                    reference_extent=reference_extent,
                )
                experiments.append({"ok": True, **component_record})
                continue
            if method == "stitch_broken_faces":
                broken = trimesh.repair.broken_faces(base)
                stitch_result = trimesh.repair.stitch(base, faces=broken, insert_vertices=True)
                if len(stitch_result) == 2:
                    fan, inserted_vertices = stitch_result
                else:
                    fan, inserted_vertices = stitch_result, np.empty((0, 3))
                if len(fan) == 0:
                    raise ValueError("stitch produced no faces")
                vertices = (
                    np.vstack([base.vertices, inserted_vertices])
                    if len(inserted_vertices)
                    else np.asarray(base.vertices)
                )
                candidate = trimesh.Trimesh(
                    vertices=vertices,
                    faces=np.vstack([base.faces, fan]),
                    process=True,
                )
            else:
                candidate = trimesh.Trimesh(
                    vertices=base.convex_hull.vertices,
                    faces=base.convex_hull.faces,
                    process=True,
                )
            candidate.merge_vertices()
            trimesh.repair.fix_winding(candidate)
            trimesh.repair.fix_normals(candidate)
            topology = _topology_record(candidate)
            repaired_extent = _bbox_extent(candidate)
            bbox_extent_delta = max(
                abs(float(a) - float(b))
                for a, b in zip(repaired_extent, reference_extent, strict=True)
            )
            volume_ratio = (
                abs(float(candidate.volume)) / max(abs(float(base.volume)), 1.0e-12)
            )
            safe_candidate = bool(
                topology["watertight"]
                and bbox_extent_delta <= RESERVED_INTERFACE_TOLERANCE_M
                and volume_ratio <= 1.10
            )
            experiments.append(
                {
                    "method": method,
                    "ok": True,
                    "topology": topology,
                    "bbox_extent_delta_m": bbox_extent_delta,
                    "volume_ratio": volume_ratio,
                    "safe_candidate": safe_candidate,
                    "rejection_reason": None
                    if safe_candidate
                    else "candidate is not watertight, bbox-preserving, and volume-conservative",
                }
            )
        except Exception as exc:
            experiments.append(
                {
                    "method": method,
                    "ok": False,
                    "safe_candidate": False,
                    "error": str(exc),
                    "rejection_reason": "repair experiment failed",
                }
            )
    return {
        "attempted": True,
        "experiments": experiments,
        "safe_candidate_methods": [
            experiment["method"]
            for experiment in experiments
            if experiment.get("safe_candidate")
        ],
    }


def _slab_bbox(vertices: np.ndarray, *, axis: int, level: float, half_width: float) -> np.ndarray | None:
    slab = vertices[np.abs(vertices[:, axis] - level) <= half_width]
    if len(slab) == 0:
        return None
    return np.asarray([slab.min(axis=0), slab.max(axis=0)], dtype=np.float64)


def _interface_preservation_records(
    *,
    source_mesh: Any,
    output_mesh: Any,
    link: str,
    axis_name: str,
) -> list[dict[str, Any]]:
    axis = {"x": 0, "y": 1, "z": 2}[axis_name]
    source_vertices = np.asarray(source_mesh.vertices, dtype=np.float64)
    output_vertices = np.asarray(output_mesh.vertices, dtype=np.float64)
    records = []
    for level in load_reserved_levels(link):
        source_bbox = _slab_bbox(source_vertices, axis=axis, level=level, half_width=0.006)
        output_bbox = _slab_bbox(output_vertices, axis=axis, level=level, half_width=0.006)
        if source_bbox is None or output_bbox is None:
            records.append(
                {
                    "level_m": float(level),
                    "available": False,
                    "bbox_delta_m": None,
                    "ok": False,
                }
            )
            continue
        bbox_delta = float(np.max(np.abs(output_bbox - source_bbox)))
        records.append(
            {
                "level_m": float(level),
                "available": True,
                "bbox_delta_m": bbox_delta,
                "ok": bbox_delta <= RESERVED_INTERFACE_TOLERANCE_M,
            }
        )
    return records


def _all_parametric_links(input_stl_dir: Path) -> list[str]:
    return sorted(path.stem.upper() for path in input_stl_dir.glob("*.STL") if path.is_file())


def _build_lean_mesh_for_link(
    *,
    link: str,
    selected_scale: float,
    input_stl_dir: Path,
    output_stl_dir: Path,
    connection_specs: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    import trimesh

    source_path = input_stl_dir / f"{link}.STL"
    output_path = output_stl_dir / f"{link}.STL"
    source_mesh = _load_mesh(source_path)
    axis = str(connection_specs.get(link, {}).get("spine", "z"))
    reserved = load_reserved_levels(link)
    axis_index = {"x": 0, "y": 1, "z": 2}[axis]
    non_spine_axes = [index for index in range(3) if index != axis_index]
    vertices = np.asarray(source_mesh.vertices, dtype=np.float64).copy()
    center = vertices.mean(axis=0)
    levels = vertices[:, axis_index]
    if reserved:
        distance = np.min(
            np.abs(levels[:, None] - np.asarray(reserved, dtype=np.float64)[None, :]),
            axis=1,
        )
        weight = np.clip(distance / 0.03, 0.0, 1.0)
        weight = weight * weight * (3.0 - 2.0 * weight)
    else:
        weight = np.ones(len(vertices), dtype=np.float64)
    vertex_scale = 1.0 + (float(selected_scale) - 1.0) * weight
    for dim in non_spine_axes:
        vertices[:, dim] = center[dim] + (vertices[:, dim] - center[dim]) * vertex_scale
    lean_mesh = trimesh.Trimesh(vertices=vertices, faces=source_mesh.faces.copy(), process=False)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    lean_mesh.export(output_path)
    reloaded = _load_mesh(output_path)
    source_extent = _bbox_extent(source_mesh)
    output_extent = _bbox_extent(reloaded)
    non_spine_ratios = [
        output_extent[index] / max(source_extent[index], 1.0e-12)
        for index in non_spine_axes
    ]
    interfaces = _interface_preservation_records(
        source_mesh=source_mesh,
        output_mesh=reloaded,
        link=link,
        axis_name=axis,
    )
    source_topology = _topology_record(source_mesh)
    topology = _topology_record(reloaded)
    topology_preserved = bool(
        topology["body_count"] == source_topology["body_count"]
        and topology["watertight"] == source_topology["watertight"]
        and topology["winding_consistent"] == source_topology["winding_consistent"]
    )
    inherited_non_watertight = bool(not source_topology["watertight"])
    repair_candidate = (
        _repair_candidate_record(reloaded, reference_extent=output_extent)
        if inherited_non_watertight
        else {"attempted": False, "safe_candidate": False}
    )
    return {
        "link": link,
        "source_stl": str(source_path),
        "output_stl": str(output_path),
        "spine": axis,
        "procedural_method": "topology_preserving_connection_weighted_non_spine_scale_field",
        "reserved_levels_m": [float(level) for level in reserved],
        "selected_non_spine_scale": float(selected_scale),
        "source_bbox_extent_m": source_extent,
        "output_bbox_extent_m": output_extent,
        "measured_non_spine_extent_ratios": [float(value) for value in non_spine_ratios],
        "minimum_measured_non_spine_extent_ratio": float(min(non_spine_ratios)),
        "maximum_measured_non_spine_extent_ratio": float(max(non_spine_ratios)),
        "interface_preservation": interfaces,
        "max_interface_bbox_delta_m": max(
            (float(record["bbox_delta_m"]) for record in interfaces if record["bbox_delta_m"] is not None),
            default=None,
        ),
        "source_topology": source_topology,
        "topology": topology,
        "topology_preserved": topology_preserved,
        "inherited_non_watertight": inherited_non_watertight,
        "repair_candidate": repair_candidate,
        "ok": bool(
            topology_preserved
            and interfaces
            and all(record["ok"] for record in interfaces)
        ),
    }


def _copy_unaffected_link(*, link: str, input_stl_dir: Path, output_stl_dir: Path) -> dict[str, Any]:
    source_path = input_stl_dir / f"{link}.STL"
    output_path = output_stl_dir / f"{link}.STL"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, output_path)
    mesh = _load_mesh(output_path)
    topology = _topology_record(mesh)
    inherited_non_watertight = bool(not topology["watertight"])
    repair_candidate = (
        _repair_candidate_record(mesh, reference_extent=_bbox_extent(mesh))
        if inherited_non_watertight
        else {"attempted": False, "safe_candidate": False}
    )
    return {
        "link": link,
        "source_stl": str(source_path),
        "output_stl": str(output_path),
        "copied_without_lean_transform": True,
        "source_bbox_extent_m": _bbox_extent(mesh),
        "output_bbox_extent_m": _bbox_extent(mesh),
        "source_topology": topology,
        "topology": topology,
        "topology_preserved": True,
        "inherited_non_watertight": inherited_non_watertight,
        "repair_candidate": repair_candidate,
        "ok": True,
    }


def _generate_lean_stl_fork(
    *,
    records: list[dict[str, Any]],
    input_stl_dir: Path,
    output_stl_dir: Path,
) -> dict[str, Any]:
    selected_by_link = {
        str(record["link"]).upper(): float(record["selected_non_spine_scale"])
        for record in records
    }
    all_links = _all_parametric_links(input_stl_dir)
    connection_specs = load_connection_specs()
    output_stl_dir.mkdir(parents=True, exist_ok=True)
    generated_records = []
    for link in all_links:
        if link in selected_by_link:
            generated_records.append(
                _build_lean_mesh_for_link(
                    link=link,
                    selected_scale=selected_by_link[link],
                    input_stl_dir=input_stl_dir,
                    output_stl_dir=output_stl_dir,
                    connection_specs=connection_specs,
                )
            )
        else:
            generated_records.append(
                _copy_unaffected_link(
                    link=link,
                    input_stl_dir=input_stl_dir,
                    output_stl_dir=output_stl_dir,
                )
            )
    transformed = [record for record in generated_records if not record.get("copied_without_lean_transform")]
    ok_records = [record for record in generated_records if record.get("ok")]
    inherited_non_watertight = [
        record for record in generated_records if record.get("inherited_non_watertight")
    ]
    safe_repair_candidates = [
        record
        for record in inherited_non_watertight
        if (record.get("repair_candidate") or {}).get("safe_candidate")
    ]
    return {
        "enabled": True,
        "input_stl_dir": str(input_stl_dir),
        "output_stl_dir": str(output_stl_dir),
        "links": len(generated_records),
        "transformed_links": len(transformed),
        "copied_links": len(generated_records) - len(transformed),
        "watertight_links": sum(1 for record in generated_records if record["topology"]["watertight"]),
        "inherited_non_watertight_links": len(inherited_non_watertight),
        "inherited_non_watertight_link_names": [
            record["link"] for record in inherited_non_watertight
        ],
        "automatic_repair_safe_candidate_links": len(safe_repair_candidates),
        "automatic_repair_safe_candidate_link_names": [
            record["link"] for record in safe_repair_candidates
        ],
        "topology_preserved_links": sum(
            1 for record in generated_records if record.get("topology_preserved")
        ),
        "ok_links": len(ok_records),
        "max_interface_bbox_delta_m": max(
            (
                float(record["max_interface_bbox_delta_m"])
                for record in transformed
                if record.get("max_interface_bbox_delta_m") is not None
            ),
            default=None,
        ),
        "minimum_measured_non_spine_extent_ratio": min(
            (
                float(record["minimum_measured_non_spine_extent_ratio"])
                for record in transformed
            ),
            default=None,
        ),
        "maximum_measured_non_spine_extent_ratio": max(
            (
                float(record["maximum_measured_non_spine_extent_ratio"])
                for record in transformed
            ),
            default=None,
        ),
        "ok": bool(
            len(generated_records) == TOPOLOGY_OK_REQUIRED_LINKS
            and len(ok_records) == len(generated_records)
        ),
        "records": generated_records,
    }


def _generate_repaired_stl_fork(
    *,
    lean_fork: dict[str, Any],
    output_stl_dir: Path,
) -> dict[str, Any]:
    if not lean_fork.get("enabled"):
        return {
            "enabled": False,
            "ok": True,
            "output_stl_dir": str(output_stl_dir),
            "records": [],
        }
    output_stl_dir.mkdir(parents=True, exist_ok=True)
    repaired_records = []
    promoted_links = []
    for record in lean_fork.get("records", []):
        link = str(record["link"]).upper()
        source_path = Path(str(record["output_stl"]))
        output_path = output_stl_dir / f"{link}.STL"
        repair_candidate = record.get("repair_candidate") or {}
        promoted_method = None
        promoted_candidate = None
        if repair_candidate.get("safe_candidate"):
            mesh = _load_mesh(source_path)
            repaired_mesh = _make_repaired_mesh(mesh)
            repaired_mesh.export(output_path)
            reloaded = _load_mesh(output_path)
            topology = _topology_record(reloaded)
            promoted = True
            promoted_method = "fill_holes"
            promoted_candidate = repair_candidate
            promoted_links.append(link)
        else:
            source_mesh = _load_mesh(source_path)
            source_extent = [float(value) for value in record["output_bbox_extent_m"]]
            component_candidate = None
            ellipsoid_candidate = None
            section_loft_candidate = None
            if link in TOE_LINKS:
                try:
                    component_candidate = _component_hull_candidate_record(
                        source_mesh,
                        link=link,
                        reference_extent=source_extent,
                    )
                except Exception:
                    component_candidate = None
            if link in HIP_PITCH_LINKS:
                try:
                    ellipsoid_candidate = _ellipsoid_candidate_record(
                        source_mesh,
                        link=link,
                        reference_extent=source_extent,
                    )
                except Exception:
                    ellipsoid_candidate = None
            if link in SECTION_LOFT_LINKS:
                try:
                    section_loft_candidate = _section_loft_candidate_record(
                        source_mesh,
                        link=link,
                        reference_extent=source_extent,
                    )
                except Exception:
                    section_loft_candidate = None
            if component_candidate and component_candidate.get("safe_candidate"):
                repaired_mesh = _make_component_convex_hull_mesh(source_mesh)
                repaired_mesh.export(output_path)
                reloaded = repaired_mesh
                topology = _topology_record_without_vertex_merge(repaired_mesh)
                promoted = True
                promoted_method = "component_convex_hulls"
                promoted_candidate = component_candidate
                promoted_links.append(link)
            elif section_loft_candidate and section_loft_candidate.get("safe_candidate"):
                repaired_mesh = _make_section_loft_envelope_mesh(source_mesh, link=link)
                repaired_mesh.export(output_path)
                reloaded = repaired_mesh
                topology = _topology_record(repaired_mesh)
                promoted = True
                promoted_method = "section_loft_envelope"
                promoted_candidate = section_loft_candidate
                promoted_links.append(link)
            elif ellipsoid_candidate and ellipsoid_candidate.get("safe_candidate"):
                repaired_mesh = _make_ellipsoid_envelope_mesh(source_mesh)
                repaired_mesh.export(output_path)
                reloaded = repaired_mesh
                topology = _topology_record(repaired_mesh)
                promoted = True
                promoted_method = "ellipsoid_envelope"
                promoted_candidate = ellipsoid_candidate
                promoted_links.append(link)
            else:
                shutil.copy2(source_path, output_path)
                reloaded = _load_mesh(output_path)
                topology = _topology_record(reloaded)
                promoted = False
        source_extent = [float(value) for value in record["output_bbox_extent_m"]]
        output_extent = _bbox_extent(reloaded)
        bbox_extent_delta = max(
            abs(float(a) - float(b))
            for a, b in zip(output_extent, source_extent, strict=True)
        )
        bbox_extent_delta_limit = float(
            (promoted_candidate or {}).get(
                "bbox_extent_delta_limit_m",
                RESERVED_INTERFACE_TOLERANCE_M,
            )
        )
        inherited_non_watertight = bool(
            record.get("inherited_non_watertight")
            and not topology["watertight"]
        )
        repair_experiments = (
            _repair_experiment_record(reloaded, link=link, reference_extent=output_extent)
            if inherited_non_watertight
            else {"attempted": False, "experiments": [], "safe_candidate_methods": []}
        )
        repaired_records.append(
            {
                "link": link,
                "source_stl": str(source_path),
                "output_stl": str(output_path),
                "promoted_safe_repair": promoted,
                "promoted_safe_repair_method": promoted_method,
                "promoted_safe_repair_candidate": promoted_candidate,
                "source_bbox_extent_m": source_extent,
                "output_bbox_extent_m": output_extent,
                "bbox_extent_delta_m": bbox_extent_delta,
                "bbox_extent_delta_limit_m": bbox_extent_delta_limit,
                "topology": topology,
                "repair_experiments": repair_experiments,
                "ok": bool(
                    bbox_extent_delta <= bbox_extent_delta_limit
                    and (topology["watertight"] or not promoted)
                ),
            }
        )
    ok_records = [record for record in repaired_records if record.get("ok")]
    watertight_links = sum(1 for record in repaired_records if record["topology"]["watertight"])
    remaining_non_watertight = [
        record for record in repaired_records if not record["topology"]["watertight"]
    ]
    safe_experiment_records = [
        record
        for record in remaining_non_watertight
        if (record.get("repair_experiments") or {}).get("safe_candidate_methods")
    ]
    return {
        "enabled": True,
        "input_stl_dir": lean_fork.get("output_stl_dir"),
        "output_stl_dir": str(output_stl_dir),
        "links": len(repaired_records),
        "promoted_safe_repair_links": len(promoted_links),
        "promoted_safe_repair_link_names": promoted_links,
        "promoted_safe_repair_methods": {
            record["link"]: record.get("promoted_safe_repair_method")
            for record in repaired_records
            if record.get("promoted_safe_repair")
        },
        "watertight_links": watertight_links,
        "remaining_non_watertight_links": len(remaining_non_watertight),
        "remaining_non_watertight_link_names": [
            record["link"]
            for record in remaining_non_watertight
        ],
        "remaining_topology_defects": [
            {
                "link": record["link"],
                "boundary_edges": record["topology"]["boundary_edges"],
                "nonmanifold_edges": record["topology"]["nonmanifold_edges"],
                "body_count": record["topology"]["body_count"],
                "largest_component_faces": record["topology"]["largest_component_faces"],
                "faces": record["topology"]["faces"],
                "recommended_next_step": _recommended_repair_step(record["topology"]),
                "repair_experiments": record.get("repair_experiments"),
            }
            for record in remaining_non_watertight
        ],
        "alternate_repair_safe_candidate_links": len(safe_experiment_records),
        "alternate_repair_safe_candidate_link_names": [
            record["link"] for record in safe_experiment_records
        ],
        "max_bbox_extent_delta_m": max(
            (float(record["bbox_extent_delta_m"]) for record in repaired_records),
            default=None,
        ),
        "ok_links": len(ok_records),
        "ok": bool(
            len(repaired_records) == TOPOLOGY_OK_REQUIRED_LINKS
            and len(ok_records) == len(repaired_records)
        ),
        "records": repaired_records,
    }


def _final_geometry_reduction_records(
    *,
    records: list[dict[str, Any]],
    source_stl_dir: Path,
    repaired_fork: dict[str, Any],
) -> dict[str, Any]:
    if not repaired_fork.get("enabled") or not repaired_fork.get("records"):
        return {
            "enabled": False,
            "ok": True,
            "records": [],
        }
    experiment_by_link = {str(record["link"]).upper(): record for record in records}
    reductions = []
    for repaired_record in repaired_fork.get("records", []):
        link = str(repaired_record["link"]).upper()
        if link not in experiment_by_link:
            continue
        source_path = source_stl_dir / f"{link}.STL"
        output_path = Path(str(repaired_record["output_stl"]))
        if not source_path.is_file() or not output_path.is_file():
            continue
        source_mesh = _load_mesh(source_path)
        output_mesh = _load_mesh(output_path)
        source_extent = _bbox_extent(source_mesh)
        output_extent = _bbox_extent(output_mesh)
        ratios = [
            float(output_extent[index]) / max(float(source_extent[index]), 1.0e-12)
            for index in range(3)
        ]
        source_volume = abs(float(source_mesh.volume))
        output_volume = abs(float(output_mesh.volume))
        experiment = experiment_by_link[link]
        reductions.append(
            {
                "link": link,
                "group": experiment["group"],
                "categories": experiment["categories"],
                "requested_non_spine_scale": experiment["requested_non_spine_scale"],
                "selected_non_spine_scale": experiment["selected_non_spine_scale"],
                "frontier_safe_non_spine_scale": experiment["frontier_safe_non_spine_scale"],
                "source_bbox_extent_m": source_extent,
                "output_bbox_extent_m": output_extent,
                "bbox_extent_ratio": ratios,
                "minimum_bbox_extent_ratio": min(ratios),
                "maximum_bbox_extent_ratio": max(ratios),
                "source_volume_m3": source_volume,
                "output_volume_m3": output_volume,
                "volume_ratio": output_volume / max(source_volume, 1.0e-12),
                "promoted_safe_repair_method": repaired_record.get(
                    "promoted_safe_repair_method"
                ),
                "watertight": bool(repaired_record.get("topology", {}).get("watertight")),
            }
        )
    return {
        "enabled": True,
        "ok": bool(len(reductions) == len(records)),
        "links": len(reductions),
        "minimum_bbox_extent_ratio": min(
            (record["minimum_bbox_extent_ratio"] for record in reductions),
            default=None,
        ),
        "maximum_bbox_extent_ratio": max(
            (record["maximum_bbox_extent_ratio"] for record in reductions),
            default=None,
        ),
        "minimum_volume_ratio": min(
            (record["volume_ratio"] for record in reductions),
            default=None,
        ),
        "maximum_volume_ratio": max(
            (record["volume_ratio"] for record in reductions),
            default=None,
        ),
        "watertight_links": sum(1 for record in reductions if record["watertight"]),
        "records": reductions,
    }


def _ball_housing_reduction_records(final_geometry_reduction: dict[str, Any]) -> dict[str, Any]:
    if not final_geometry_reduction.get("enabled"):
        return {
            "enabled": False,
            "ok": True,
            "records": [],
        }
    records_by_link = {
        str(record["link"]).upper(): record
        for record in final_geometry_reduction.get("records", [])
    }
    records = []
    missing_links = []
    for link in sorted(BALL_HOUSING_LINKS):
        record = records_by_link.get(link)
        if record is None:
            missing_links.append(link)
            continue
        bbox_reduced = bool(record["minimum_bbox_extent_ratio"] < 1.0 - 1.0e-9)
        volume_reduced = bool(record["volume_ratio"] < 1.0 - 1.0e-9)
        records.append(
            {
                "link": link,
                "volume_ratio": record["volume_ratio"],
                "minimum_bbox_extent_ratio": record["minimum_bbox_extent_ratio"],
                "maximum_bbox_extent_ratio": record["maximum_bbox_extent_ratio"],
                "bbox_extent_ratio": record["bbox_extent_ratio"],
                "promoted_safe_repair_method": record.get("promoted_safe_repair_method"),
                "watertight": bool(record.get("watertight")),
                "bbox_reduced": bbox_reduced,
                "volume_reduced": volume_reduced,
                "ok": bool(record.get("watertight") and volume_reduced),
            }
        )
    ok_records = [record for record in records if record["ok"]]
    bbox_reduced_records = [record for record in records if record["bbox_reduced"]]
    volume_reduced_records = [record for record in records if record["volume_reduced"]]
    return {
        "enabled": True,
        "links": len(records),
        "missing_links": missing_links,
        "ok_links": len(ok_records),
        "bbox_reduced_links": len(bbox_reduced_records),
        "volume_reduced_links": len(volume_reduced_records),
        "minimum_volume_ratio": min(
            (record["volume_ratio"] for record in records),
            default=None,
        ),
        "maximum_volume_ratio": max(
            (record["volume_ratio"] for record in records),
            default=None,
        ),
        "minimum_bbox_extent_ratio": min(
            (record["minimum_bbox_extent_ratio"] for record in records),
            default=None,
        ),
        "ok": bool(
            not missing_links
            and len(records) == len(BALL_HOUSING_LINKS)
            and len(ok_records) == len(records)
        ),
        "records": records,
    }


def _hip_spacing_sweep_records(
    *,
    mesh_dir: Path,
    output_mjcf: Path,
    enabled: bool,
) -> dict[str, Any]:
    if not enabled:
        return {
            "enabled": False,
            "ok": True,
            "records": [],
        }

    def initial_contact_record(mjcf_path: Path) -> dict[str, Any]:
        import mujoco

        model = mujoco.MjModel.from_xml_path(str(mjcf_path))
        data = mujoco.MjData(model)
        mujoco.mj_forward(model, data)
        nonfloor_pairs = []
        for contact_index in range(data.ncon):
            contact = data.contact[contact_index]
            geom1 = mujoco.mj_id2name(
                model,
                mujoco.mjtObj.mjOBJ_GEOM,
                int(contact.geom1),
            ) or ""
            geom2 = mujoco.mj_id2name(
                model,
                mujoco.mjtObj.mjOBJ_GEOM,
                int(contact.geom2),
            ) or ""
            if "floor" in (geom1, geom2):
                continue
            nonfloor_pairs.append(
                {
                    "geom1": geom1,
                    "geom2": geom2,
                    "distance_m": float(contact.dist),
                }
            )
        return {
            "total_contact_count": int(data.ncon),
            "nonfloor_contact_count": len(nonfloor_pairs),
            "nonfloor_contacts": nonfloor_pairs,
            "ok": len(nonfloor_pairs) == 0,
        }

    records = []
    for scale in HIP_SPACING_SWEEP_SCALES:
        sweep_output = output_mjcf.with_name(
            f"{output_mjcf.stem}_hip_{int(round(scale * 100)):03d}{output_mjcf.suffix}"
        )
        report = generate_fembot_mjcf(
            output_mjcf=sweep_output,
            mesh_dir=mesh_dir,
            hip_spacing_scale=float(scale),
            replace_visual_meshes_with_cad_primitives=False,
        )
        summary = report.get("summary", {})
        contact_record = (
            initial_contact_record(sweep_output)
            if report.get("ok")
            else {
                "total_contact_count": None,
                "nonfloor_contact_count": None,
                "nonfloor_contacts": [],
                "ok": False,
            }
        )
        accepted_by_sweep = bool(report.get("ok") and contact_record["ok"])
        records.append(
            {
                "hip_spacing_scale": float(scale),
                "mujoco_ok": bool(report.get("ok")),
                "ok": accepted_by_sweep,
                "accepted": bool(report.get("accepted")),
                "output_mjcf": str(sweep_output),
                "source_hip_spacing_m": summary.get("source_hip_spacing_m"),
                "output_hip_spacing_m": summary.get("output_hip_spacing_m"),
                "hip_spacing_ratio": summary.get("hip_spacing_ratio"),
                "initial_contact": contact_record,
                "mujoco_compiled": bool(summary.get("mujoco_compiled")),
                "mujoco_error": summary.get("mujoco_error"),
                "mass_inertia_ok": bool(summary.get("mass_inertia_ok")),
                "actuator_lag_ok": bool(summary.get("actuator_lag_ok")),
                "contact_tuned_colliders_promoted": bool(
                    summary.get("contact_tuned_colliders_promoted")
                ),
                "contact_tuned_collider_scaled_geom_count": summary.get(
                    "contact_tuned_collider_scaled_geom_count"
                ),
                "contact_tuned_collider_fit_geom_count": summary.get(
                    "contact_tuned_collider_fit_geom_count"
                ),
                "contact_tuned_collider_physical_visual_remediation_geom_count": summary.get(
                    "contact_tuned_collider_physical_visual_remediation_geom_count"
                ),
            }
        )
    ok_records = [record for record in records if record["ok"]]
    return {
        "enabled": True,
        "ok": bool(ok_records),
        "tested_scales": [float(scale) for scale in HIP_SPACING_SWEEP_SCALES],
        "ok_scale_count": len(ok_records),
        "minimum_ok_hip_spacing_scale": min(
            (float(record["hip_spacing_scale"]) for record in ok_records),
            default=None,
        ),
        "minimum_ok_hip_spacing_m": min(
            (
                float(record["output_hip_spacing_m"])
                for record in ok_records
                if record["output_hip_spacing_m"] is not None
            ),
            default=None,
        ),
        "records": records,
    }


def _recommended_repair_step(topology: dict[str, Any]) -> str:
    boundary_edges = int(topology.get("boundary_edges") or 0)
    nonmanifold_edges = int(topology.get("nonmanifold_edges") or 0)
    body_count = int(topology.get("body_count") or 0)
    if body_count > 100 or nonmanifold_edges > 100:
        return "rebuild from controlled loft sections; triangle repair is too fragmented/nonmanifold"
    if boundary_edges > 0 and nonmanifold_edges == 0:
        return "cap boundary loops with part-specific interface guards"
    if boundary_edges > 0:
        return "separate nonmanifold fragments, then cap boundary loops"
    return "remove duplicate/internal fragments before watertight rebuild"


def build_asimov1_lean_experiment_proof(
    *,
    frontier_report: dict[str, Any] | None = None,
    output_mjcf: Path = LEAN_EXPERIMENT_MJCF_PATH,
    input_stl_dir: Path = ASIMOV_PARAM_OUTPUT_STL,
    output_stl_dir: Path = LEAN_EXPERIMENT_STL_DIR,
    repaired_output_stl_dir: Path = LEAN_EXPERIMENT_REPAIRED_STL_DIR,
    hip_spacing_scale: float = HIP_SPACING_EXPERIMENT_SCALE,
    generate_stl_fork: bool = True,
    generate_repaired_fork: bool = True,
    generate_mjcf_variant: bool = True,
) -> dict[str, Any]:
    frontier = _frontier_report(frontier_report)
    records = [
        item
        for item in (_link_experiment_record(record) for record in frontier.get("links", []))
        if item is not None
    ]
    categories = [
        _category_summary(records, "arm"),
        _category_summary(records, "leg"),
        _category_summary(records, "ball_housing"),
    ]
    thinning_sweep = _scale_sweep_records(records)
    stl_fork = (
        _generate_lean_stl_fork(
            records=records,
            input_stl_dir=input_stl_dir,
            output_stl_dir=output_stl_dir,
        )
        if generate_stl_fork
        else {
            "enabled": False,
            "ok": True,
            "output_stl_dir": str(output_stl_dir),
            "records": [],
        }
    )
    repaired_stl_fork = (
        _generate_repaired_stl_fork(
            lean_fork=stl_fork,
            output_stl_dir=repaired_output_stl_dir,
        )
        if generate_stl_fork and generate_repaired_fork
        else {
            "enabled": False,
            "ok": True,
            "output_stl_dir": str(repaired_output_stl_dir),
            "records": [],
        }
    )
    final_geometry_reduction = (
        _final_geometry_reduction_records(
            records=records,
            source_stl_dir=input_stl_dir,
            repaired_fork=repaired_stl_fork,
        )
        if generate_stl_fork and generate_repaired_fork
        else {
            "enabled": False,
            "ok": True,
            "records": [],
        }
    )
    ball_housing_reduction = _ball_housing_reduction_records(final_geometry_reduction)
    mujoco_mesh_dir = (
        repaired_output_stl_dir
        if generate_stl_fork and generate_repaired_fork and repaired_stl_fork.get("ok")
        else output_stl_dir
        if generate_stl_fork
        else input_stl_dir
    )
    hip_spacing_sweep = (
        _hip_spacing_sweep_records(
            mesh_dir=mujoco_mesh_dir,
            output_mjcf=output_mjcf,
            enabled=True,
        )
        if generate_mjcf_variant
        else {
            "enabled": False,
            "ok": True,
            "records": [],
        }
    )
    mjcf_report = (
        generate_fembot_mjcf(
            output_mjcf=output_mjcf,
            mesh_dir=mujoco_mesh_dir,
            hip_spacing_scale=hip_spacing_scale,
            replace_visual_meshes_with_cad_primitives=False,
        )
        if generate_mjcf_variant
        else None
    )
    limited = [record for record in records if not record["fully_requested_scale_accepted"]]
    ok = bool(
        frontier.get("ok")
        and len(records) == 22
        and stl_fork.get("ok")
        and repaired_stl_fork.get("ok")
        and (not generate_mjcf_variant or (mjcf_report or {}).get("ok"))
    )
    experimental_acceptance_checks = {
        "scale_sweep_quantified": bool(thinning_sweep.get("ok")),
        "final_geometry_reduction_quantified": bool(final_geometry_reduction.get("ok")),
        "all_repaired_parts_watertight": bool(
            repaired_stl_fork.get("watertight_links") == TOPOLOGY_OK_REQUIRED_LINKS
            and repaired_stl_fork.get("remaining_non_watertight_links") == 0
        ),
        "ball_housings_reduced": bool(ball_housing_reduction.get("ok")),
        "hip_spacing_narrowed": bool(
            (mjcf_report or {}).get("summary", {}).get("output_hip_spacing_m") is not None
            and (mjcf_report or {}).get("summary", {}).get("source_hip_spacing_m") is not None
            and float((mjcf_report or {}).get("summary", {}).get("output_hip_spacing_m"))
            < float((mjcf_report or {}).get("summary", {}).get("source_hip_spacing_m"))
        ),
        "hip_spacing_frontier_quantified": bool(hip_spacing_sweep.get("ok")),
        "mujoco_primary_loads": bool((mjcf_report or {}).get("ok")),
    }
    experimental_acceptance_ok = bool(
        ok
        and all(experimental_acceptance_checks.values())
    )
    return {
        "schema": LEAN_EXPERIMENT_SCHEMA,
        "ok": ok,
        "accepted": bool(ok and not limited),
        "experimental_acceptance": {
            "ok": experimental_acceptance_ok,
            "checks": experimental_acceptance_checks,
            "production_accepted": bool(ok and not limited),
            "production_blocker": None
            if ok and not limited
            else (
                "raw requested bbox-scale targets remain frontier-limited on selected "
                "hip-pitch and ankle links; the experimental procedural fork is validated "
                "as a watertight MuJoCo-loadable thinning artifact, but production release "
                "still needs final B-rep/STEP acceptance of those constrained mates"
            ),
        },
        "source": {
            "frontier_schema": frontier.get("schema"),
            "frontier_ok": frontier.get("ok"),
            "frontier_proof": str(ASIMOV_PARAM_PROOFS / "fembot-thinness-frontier.json"),
        },
        "parameters": {
            "arm_requested_non_spine_scale": ARM_REQUESTED_NON_SPINE_SCALE,
            "leg_requested_non_spine_scale": LEG_REQUESTED_NON_SPINE_SCALE,
            "ball_housing_requested_non_spine_scale": BALL_HOUSING_REQUESTED_NON_SPINE_SCALE,
            "hip_spacing_scale": hip_spacing_scale,
            "scale_step": SCALE_STEP,
        },
        "summary": {
            "links": len(records),
            "requested_links_fully_accepted": len(records) - len(limited),
            "limited_links": [record["link"] for record in limited],
            "minimum_selected_non_spine_scale": min(
                (float(record["selected_non_spine_scale"]) for record in records),
                default=None,
            ),
            "maximum_selected_non_spine_scale": max(
                (float(record["selected_non_spine_scale"]) for record in records),
                default=None,
            ),
            "minimum_axis_clearance_margin_m": min(
                (float(record["minimum_axis_clearance_margin_m"]) for record in records),
                default=None,
            ),
            "thinning_sweep_ok": thinning_sweep.get("ok"),
            "thinning_sweep_requested_scale_accepted_links": thinning_sweep.get(
                "requested_scale_accepted_links"
            ),
            "thinning_sweep_requested_scale_rejected_links": thinning_sweep.get(
                "requested_scale_rejected_links"
            ),
            "thinning_sweep_accepted_tighter_than_selected_links": thinning_sweep.get(
                "accepted_tighter_than_selected_links"
            ),
            "final_geometry_reduction_ok": final_geometry_reduction.get("ok"),
            "final_geometry_reduction_links": final_geometry_reduction.get("links"),
            "final_geometry_minimum_bbox_extent_ratio": final_geometry_reduction.get(
                "minimum_bbox_extent_ratio"
            ),
            "final_geometry_maximum_bbox_extent_ratio": final_geometry_reduction.get(
                "maximum_bbox_extent_ratio"
            ),
            "final_geometry_minimum_volume_ratio": final_geometry_reduction.get(
                "minimum_volume_ratio"
            ),
            "final_geometry_maximum_volume_ratio": final_geometry_reduction.get(
                "maximum_volume_ratio"
            ),
            "ball_housing_reduction_ok": ball_housing_reduction.get("ok"),
            "ball_housing_reduction_links": ball_housing_reduction.get("links"),
            "ball_housing_volume_reduced_links": ball_housing_reduction.get(
                "volume_reduced_links"
            ),
            "ball_housing_bbox_reduced_links": ball_housing_reduction.get(
                "bbox_reduced_links"
            ),
            "ball_housing_minimum_volume_ratio": ball_housing_reduction.get(
                "minimum_volume_ratio"
            ),
            "ball_housing_maximum_volume_ratio": ball_housing_reduction.get(
                "maximum_volume_ratio"
            ),
            "hip_spacing_sweep_ok": hip_spacing_sweep.get("ok"),
            "hip_spacing_sweep_ok_scale_count": hip_spacing_sweep.get("ok_scale_count"),
            "hip_spacing_sweep_minimum_ok_scale": hip_spacing_sweep.get(
                "minimum_ok_hip_spacing_scale"
            ),
            "hip_spacing_sweep_minimum_ok_spacing_m": hip_spacing_sweep.get(
                "minimum_ok_hip_spacing_m"
            ),
            "hip_spacing_mujoco_ok": bool((mjcf_report or {}).get("ok")),
            "hip_spacing_source_m": (mjcf_report or {}).get("summary", {}).get(
                "source_hip_spacing_m"
            ),
            "hip_spacing_output_m": (mjcf_report or {}).get("summary", {}).get(
                "output_hip_spacing_m"
            ),
            "stl_fork_ok": bool(stl_fork.get("ok")),
            "stl_fork_output_dir": stl_fork.get("output_stl_dir"),
            "stl_fork_links": stl_fork.get("links"),
            "stl_fork_transformed_links": stl_fork.get("transformed_links"),
            "stl_fork_watertight_links": stl_fork.get("watertight_links"),
            "stl_fork_inherited_non_watertight_links": stl_fork.get(
                "inherited_non_watertight_links"
            ),
            "stl_fork_topology_preserved_links": stl_fork.get(
                "topology_preserved_links"
            ),
            "stl_fork_automatic_repair_safe_candidate_links": stl_fork.get(
                "automatic_repair_safe_candidate_links"
            ),
            "stl_fork_automatic_repair_safe_candidate_link_names": stl_fork.get(
                "automatic_repair_safe_candidate_link_names"
            ),
            "repaired_stl_fork_ok": bool(repaired_stl_fork.get("ok")),
            "repaired_stl_fork_output_dir": repaired_stl_fork.get("output_stl_dir"),
            "repaired_stl_fork_links": repaired_stl_fork.get("links"),
            "repaired_stl_fork_promoted_safe_repair_links": repaired_stl_fork.get(
                "promoted_safe_repair_links"
            ),
            "repaired_stl_fork_promoted_safe_repair_link_names": repaired_stl_fork.get(
                "promoted_safe_repair_link_names"
            ),
            "repaired_stl_fork_promoted_safe_repair_methods": repaired_stl_fork.get(
                "promoted_safe_repair_methods"
            ),
            "repaired_stl_fork_watertight_links": repaired_stl_fork.get(
                "watertight_links"
            ),
            "repaired_stl_fork_remaining_non_watertight_links": repaired_stl_fork.get(
                "remaining_non_watertight_links"
            ),
            "repaired_stl_fork_remaining_non_watertight_link_names": repaired_stl_fork.get(
                "remaining_non_watertight_link_names"
            ),
            "repaired_stl_fork_remaining_topology_defects": repaired_stl_fork.get(
                "remaining_topology_defects"
            ),
            "repaired_stl_fork_alternate_repair_safe_candidate_links": repaired_stl_fork.get(
                "alternate_repair_safe_candidate_links"
            ),
            "repaired_stl_fork_alternate_repair_safe_candidate_link_names": repaired_stl_fork.get(
                "alternate_repair_safe_candidate_link_names"
            ),
            "repaired_stl_fork_max_bbox_extent_delta_m": repaired_stl_fork.get(
                "max_bbox_extent_delta_m"
            ),
            "mujoco_mesh_dir": str(mujoco_mesh_dir),
            "stl_fork_max_interface_bbox_delta_m": stl_fork.get(
                "max_interface_bbox_delta_m"
            ),
            "stl_fork_minimum_measured_non_spine_extent_ratio": stl_fork.get(
                "minimum_measured_non_spine_extent_ratio"
            ),
            "stl_fork_maximum_measured_non_spine_extent_ratio": stl_fork.get(
                "maximum_measured_non_spine_extent_ratio"
            ),
            "accepted": bool(ok and not limited),
            "experimental_acceptance_ok": experimental_acceptance_ok,
            "acceptance_blocker": None
            if ok and not limited
            else (
                "some requested arm/leg/ball-housing scales hit existing keepout, "
                "supplier, structural, or process frontier limiters; selected scales "
                "are the procedural safe candidates for the next loft rebuild"
            ),
        },
        "categories": categories,
        "thinning_sweep": thinning_sweep,
        "hip_spacing_sweep": hip_spacing_sweep,
        "final_geometry_reduction": final_geometry_reduction,
        "ball_housing_reduction": ball_housing_reduction,
        "links": records,
        "stl_fork": stl_fork,
        "repaired_stl_fork": repaired_stl_fork,
        "mujoco": mjcf_report,
    }


def dump_asimov1_lean_experiment_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_asimov1_lean_experiment_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "asimov-lean-experiment.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_asimov1_lean_experiment_json(report), encoding="utf-8")
    return output
