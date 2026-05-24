"""Surface-fit proof for ranked ASIMOV fembot STEP/B-rep body candidates."""

from __future__ import annotations

import json
import math
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import ASIMOV1_SOURCE_MESH_DIR
from eliza_robot.asimov_1.fembot_body_matching import build_fembot_body_matching_proof
from eliza_robot.asimov_1.fembot_cad_toolchain import isolated_cad_env_status
from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory
from eliza_robot.asimov_1.fembot_surface_quality import _load_stl_triangles
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS


BREP_SURFACE_FIT_SCHEMA = "asimov-fembot-brep-surface-fit-v1"
DEFAULT_SURFACE_TOLERANCE_M = 0.003
DEFAULT_MAX_SAMPLE_COUNT = 20_000
DEFAULT_SURFACE_CANDIDATES_PER_LINK = 3


def _sample_vertices(vertices: np.ndarray, max_count: int) -> np.ndarray:
    if len(vertices) <= max_count:
        return vertices
    indices = np.linspace(0, len(vertices) - 1, max_count, dtype=np.int64)
    return vertices[indices]


def _nearest_distances(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    try:
        from scipy.spatial import cKDTree

        tree = cKDTree(right)
        distances, _ = tree.query(left, k=1)
        return np.asarray(distances, dtype=np.float64)
    except Exception:
        chunks = []
        chunk_size = 1024
        for start in range(0, len(left), chunk_size):
            chunk = left[start : start + chunk_size]
            delta = chunk[:, None, :] - right[None, :, :]
            chunks.append(np.sqrt(np.min(np.sum(delta * delta, axis=2), axis=1)))
        return np.concatenate(chunks) if chunks else np.asarray([], dtype=np.float64)


def _mesh_vertices_m(path: Path, *, scale: float = 1.0) -> np.ndarray:
    triangles = _load_stl_triangles(path)
    return triangles.reshape((-1, 3)).astype(np.float64) * scale


def _bbox_center_extent(vertices: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if len(vertices) == 0:
        empty = np.asarray([math.inf, math.inf, math.inf], dtype=np.float64)
        return empty, empty
    minimum = np.min(vertices, axis=0)
    maximum = np.max(vertices, axis=0)
    return (minimum + maximum) * 0.5, maximum - minimum


def _distance_summary(left: np.ndarray, right: np.ndarray) -> dict[str, float]:
    left_to_right = _nearest_distances(left, right)
    right_to_left = _nearest_distances(right, left)
    left_max = float(np.max(left_to_right)) if len(left_to_right) else math.inf
    right_max = float(np.max(right_to_left)) if len(right_to_left) else math.inf
    left_rms = (
        float(np.sqrt(np.mean(left_to_right * left_to_right)))
        if len(left_to_right)
        else math.inf
    )
    right_rms = (
        float(np.sqrt(np.mean(right_to_left * right_to_left)))
        if len(right_to_left)
        else math.inf
    )
    return {
        "left_to_right_max_m": left_max,
        "right_to_left_max_m": right_max,
        "symmetric_hausdorff_m": max(left_max, right_max),
        "left_to_right_rms_m": left_rms,
        "right_to_left_rms_m": right_rms,
        "symmetric_rms_m": max(left_rms, right_rms),
    }


def _surface_distance_metrics(
    *,
    source_stl: Path,
    candidate_stl: Path,
    max_sample_count: int,
) -> dict[str, Any]:
    source = _sample_vertices(_mesh_vertices_m(source_stl), max_sample_count)
    candidate = _sample_vertices(_mesh_vertices_m(candidate_stl, scale=0.001), max_sample_count)
    raw = _distance_summary(source, candidate)
    source_center, source_extent = _bbox_center_extent(source)
    candidate_center, candidate_extent = _bbox_center_extent(candidate)
    center_delta = candidate_center - source_center
    center_aligned_candidate = candidate - center_delta
    center_aligned = _distance_summary(source, center_aligned_candidate)
    scale = np.divide(
        source_extent,
        candidate_extent,
        out=np.ones_like(source_extent),
        where=np.abs(candidate_extent) > 1.0e-12,
    )
    bbox_affine_candidate = (candidate - candidate_center) * scale + source_center
    bbox_affine = _distance_summary(source, bbox_affine_candidate)
    return {
        "source_sample_count": int(len(source)),
        "candidate_sample_count": int(len(candidate)),
        "source_to_candidate_max_m": raw["left_to_right_max_m"],
        "candidate_to_source_max_m": raw["right_to_left_max_m"],
        "symmetric_hausdorff_m": raw["symmetric_hausdorff_m"],
        "source_to_candidate_rms_m": raw["left_to_right_rms_m"],
        "candidate_to_source_rms_m": raw["right_to_left_rms_m"],
        "symmetric_rms_m": raw["symmetric_rms_m"],
        "source_bbox_center_m": [float(value) for value in source_center],
        "candidate_bbox_center_m": [float(value) for value in candidate_center],
        "candidate_to_source_bbox_center_delta_m": [float(value) for value in center_delta],
        "source_bbox_extent_m": [float(value) for value in source_extent],
        "candidate_bbox_extent_m": [float(value) for value in candidate_extent],
        "candidate_to_source_bbox_extent_scale": [float(value) for value in scale],
        "center_aligned_symmetric_hausdorff_m": center_aligned["symmetric_hausdorff_m"],
        "center_aligned_symmetric_rms_m": center_aligned["symmetric_rms_m"],
        "bbox_affine_aligned_symmetric_hausdorff_m": bbox_affine["symmetric_hausdorff_m"],
        "bbox_affine_aligned_symmetric_rms_m": bbox_affine["symmetric_rms_m"],
    }


def _ranked_candidate_requests(
    body_matching_report: dict[str, Any],
    *,
    candidates_per_link: int,
) -> tuple[
    list[dict[str, Any]],
    dict[tuple[str, int], list[str]],
    dict[str, list[dict[str, Any]]],
]:
    requests_by_key: dict[tuple[str, int], dict[str, Any]] = {}
    links_by_key: dict[tuple[str, int], list[str]] = {}
    candidates_by_link: dict[str, list[dict[str, Any]]] = {}
    for record in body_matching_report.get("link_matches", []):
        if not isinstance(record, dict):
            continue
        link = str(record.get("link", "")).upper()
        ranked = record.get("candidate_matches")
        if not isinstance(ranked, list) or not ranked:
            best = record.get("best_match")
            ranked = [best] if isinstance(best, dict) else []
        link_candidates: list[dict[str, Any]] = []
        for rank, candidate in enumerate(ranked[: max(1, candidates_per_link)], start=1):
            if not isinstance(candidate, dict):
                continue
            source_step = candidate.get("source_step")
            body_index = candidate.get("cad_body_index")
            if source_step is None or body_index is None:
                continue
            key = (str(source_step), int(body_index))
            request = {
                "source_step": str(source_step),
                "cad_body_index": int(body_index),
                "source_scope": candidate.get("source_scope"),
                "relative_path": candidate.get("relative_path"),
                "fabrication_class": candidate.get("fabrication_class"),
                "sha256": candidate.get("sha256"),
            }
            requests_by_key.setdefault(key, request)
            links_by_key.setdefault(key, []).append(link)
            link_candidates.append(
                {
                    **request,
                    "body_matching_rank": rank,
                    "body_matching_score": candidate.get("metrics", {}).get("score"),
                    "body_matching_combined_score": candidate.get("metrics", {}).get(
                        "combined_score"
                    ),
                }
            )
        if link_candidates:
            candidates_by_link[link] = link_candidates
    return list(requests_by_key.values()), links_by_key, candidates_by_link


def _best_candidate_requests(
    body_matching_report: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[tuple[str, int], list[str]]]:
    requests, links_by_key, _ = _ranked_candidate_requests(
        body_matching_report,
        candidates_per_link=1,
    )
    return requests, links_by_key


def _candidate_key(candidate: dict[str, Any]) -> tuple[str, int] | None:
    source_step = candidate.get("source_step")
    body_index = candidate.get("cad_body_index")
    if source_step is None or body_index is None:
        return None
    return (str(source_step), int(body_index))


def _candidate_fit_record(
    *,
    candidate: dict[str, Any],
    export: dict[str, Any],
    source_stl: Path,
    surface_tolerance_m: float,
    max_sample_count: int,
    links_by_key: dict[tuple[str, int], list[str]],
) -> dict[str, Any]:
    key = _candidate_key(candidate)
    record = {
        **candidate,
        "candidate_reused_by_links": sorted(links_by_key.get(key, [])) if key else [],
        "candidate_reuse_count": len(links_by_key.get(key, [])) if key else 0,
        "exported": bool(export.get("exported")),
        "candidate_stl_sha256": (
            sha256_file(Path(export["candidate_stl"]))
            if export.get("exported") and Path(export["candidate_stl"]).is_file()
            else None
        ),
        "surface_tolerance_m": float(surface_tolerance_m),
    }
    if not source_stl.is_file():
        record.update(
            {
                "accepted": False,
                "blocking_reason": "source STL is missing",
                "export_error": export.get("error"),
            }
        )
    elif not export.get("exported"):
        record.update(
            {
                "accepted": False,
                "blocking_reason": "candidate STEP body did not export",
                "export_error": export.get("error"),
            }
        )
    else:
        metrics = _surface_distance_metrics(
            source_stl=source_stl,
            candidate_stl=Path(export["candidate_stl"]),
            max_sample_count=max_sample_count,
        )
        accepted = bool(metrics["symmetric_hausdorff_m"] <= surface_tolerance_m)
        bbox_affine_accepted = bool(
            metrics["bbox_affine_aligned_symmetric_hausdorff_m"] <= surface_tolerance_m
        )
        record.update(
            {
                **metrics,
                "accepted": accepted,
                "bbox_affine_alignment_would_pass": bbox_affine_accepted,
                "residual_classification": "accepted_raw_candidate"
                if accepted
                else "pose_or_scale_unresolved"
                if bbox_affine_accepted
                else "shape_mismatch_after_bbox_alignment",
                "blocking_reason": None
                if accepted
                else "candidate STEP body surface residual exceeds tolerance",
            }
        )
    return record


def _export_candidate_bodies(
    requests: list[dict[str, Any]],
    *,
    output_dir: Path,
    timeout_s: int,
) -> dict[tuple[str, int], dict[str, Any]]:
    env = isolated_cad_env_status()
    python = Path(str(env["python"]))
    if not env["ready"] or not python.is_file():
        return {
            (request["source_step"], int(request["cad_body_index"])): {
                **request,
                "exported": False,
                "error": "isolated CadQuery/OCP env is not ready",
            }
            for request in requests
        }

    payload = {"requests": requests, "output_dir": str(output_dir)}
    code = r"""
import json
import sys
from collections import defaultdict
from pathlib import Path

from cadquery import exporters, importers

payload = json.load(sys.stdin)
output_dir = Path(payload["output_dir"])
output_dir.mkdir(parents=True, exist_ok=True)
by_step = defaultdict(list)
for request in payload["requests"]:
    by_step[request["source_step"]].append(request)

records = []
for source_step, requests in by_step.items():
    try:
        workplane = importers.importStep(source_step)
        values = list(workplane.vals())
        solids = []
        for value in values:
            solids.extend(value.Solids())
        bodies = solids or values
        for request in requests:
            index = int(request["cad_body_index"])
            record = dict(request)
            if index < 0 or index >= len(bodies):
                record.update({"exported": False, "error": f"body index {index} out of range {len(bodies)}"})
                records.append(record)
                continue
            output = output_dir / f"body_{len(records):04d}.stl"
            exporters.export(bodies[index], str(output))
            record.update({"exported": True, "candidate_stl": str(output), "error": None})
            records.append(record)
    except Exception as exc:
        for request in requests:
            record = dict(request)
            record.update({"exported": False, "error": f"{type(exc).__name__}: {exc}"})
            records.append(record)

print(json.dumps({"records": records}, sort_keys=True))
"""
    proc = subprocess.run(
        [str(python), "-c", code],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
        timeout=timeout_s,
    )
    if proc.returncode != 0:
        message = proc.stderr.strip() or proc.stdout.strip()
        return {
            (request["source_step"], int(request["cad_body_index"])): {
                **request,
                "exported": False,
                "error": message,
            }
            for request in requests
        }
    parsed = json.loads(proc.stdout)
    return {
        (record["source_step"], int(record["cad_body_index"])): record
        for record in parsed.get("records", [])
    }


def build_fembot_brep_surface_fit_proof(
    *,
    body_matching_report: dict[str, Any] | None = None,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
    surface_tolerance_m: float = DEFAULT_SURFACE_TOLERANCE_M,
    max_sample_count: int = DEFAULT_MAX_SAMPLE_COUNT,
    surface_candidates_per_link: int = DEFAULT_SURFACE_CANDIDATES_PER_LINK,
    export_timeout_s: int = 360,
) -> dict[str, Any]:
    if body_matching_report is None:
        inventory = collect_fembot_inventory()
        body_matching_report = build_fembot_body_matching_proof(inventory["body_groups"])

    requests, links_by_key, candidates_by_link = _ranked_candidate_requests(
        body_matching_report,
        candidates_per_link=surface_candidates_per_link,
    )
    link_records: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="asimov-brep-fit-") as tmp:
        exports = _export_candidate_bodies(
            requests,
            output_dir=Path(tmp),
            timeout_s=export_timeout_s,
        )
        for match in body_matching_report.get("link_matches", []):
            link = str(match.get("link", "")).upper()
            candidates = candidates_by_link.get(link, [])
            source_stl = mesh_dir / f"{link}.STL"
            source_record = {
                "link": link,
                "source_stl": str(source_stl),
                "source_stl_sha256": sha256_file(source_stl) if source_stl.is_file() else None,
                "surface_tolerance_m": float(surface_tolerance_m),
            }
            if not candidates:
                link_records.append(
                    {
                        **source_record,
                        "exported": False,
                        "accepted": False,
                        "blocking_reason": "missing ranked STEP candidate",
                        "evaluated_candidate_count": 0,
                        "candidate_fits": [],
                    }
                )
                continue

            candidate_fits: list[dict[str, Any]] = []
            for candidate in candidates:
                key = _candidate_key(candidate)
                export = exports.get(key, {}) if key else {}
                candidate_fits.append(
                    _candidate_fit_record(
                        candidate=candidate,
                        export=export,
                        source_stl=source_stl,
                        surface_tolerance_m=surface_tolerance_m,
                        max_sample_count=max_sample_count,
                        links_by_key=links_by_key,
                    )
                )

            finite_fits = [
                fit
                for fit in candidate_fits
                if fit.get("symmetric_hausdorff_m") is not None
            ]
            best_fit = min(
                finite_fits,
                key=lambda fit: float(fit["symmetric_hausdorff_m"]),
                default=candidate_fits[0],
            )
            accepted = bool(best_fit.get("accepted"))
            record = {
                **source_record,
                "source_step": best_fit.get("source_step"),
                "cad_body_index": best_fit.get("cad_body_index"),
                "body_matching_rank": best_fit.get("body_matching_rank"),
                "body_matching_score": best_fit.get("body_matching_score"),
                "body_matching_combined_score": best_fit.get(
                    "body_matching_combined_score"
                ),
                "candidate_reused_by_links": best_fit.get("candidate_reused_by_links", []),
                "candidate_reuse_count": best_fit.get("candidate_reuse_count", 0),
                "exported": any(bool(fit.get("exported")) for fit in candidate_fits),
                "evaluated_candidate_count": len(candidate_fits),
                "exported_candidate_count": sum(
                    1 for fit in candidate_fits if fit.get("exported")
                ),
                "accepted": accepted,
                "candidate_fits": candidate_fits,
                "blocking_reason": None
                if accepted
                else "no ranked STEP body candidate satisfies source-STL surface-fit tolerance",
            }
            for metric_key in (
                "candidate_stl_sha256",
                "source_sample_count",
                "candidate_sample_count",
                "source_to_candidate_max_m",
                "candidate_to_source_max_m",
                "symmetric_hausdorff_m",
                "source_to_candidate_rms_m",
                "candidate_to_source_rms_m",
                "symmetric_rms_m",
                "center_aligned_symmetric_hausdorff_m",
                "center_aligned_symmetric_rms_m",
                "bbox_affine_aligned_symmetric_hausdorff_m",
                "bbox_affine_aligned_symmetric_rms_m",
                "bbox_affine_alignment_would_pass",
                "residual_classification",
            ):
                if metric_key in best_fit:
                    record[metric_key] = best_fit[metric_key]
            if not source_stl.is_file():
                record["blocking_reason"] = "source STL is missing"
            elif not any(bool(fit.get("exported")) for fit in candidate_fits):
                record["blocking_reason"] = "no ranked STEP body candidate exported"
            link_records.append(record)

    exported = [record for record in link_records if record.get("exported")]
    accepted = [record for record in link_records if record.get("accepted")]
    residuals = [
        float(record["symmetric_hausdorff_m"])
        for record in link_records
        if record.get("symmetric_hausdorff_m") is not None
    ]
    center_aligned_residuals = [
        float(record["center_aligned_symmetric_hausdorff_m"])
        for record in link_records
        if record.get("center_aligned_symmetric_hausdorff_m") is not None
    ]
    bbox_affine_aligned_residuals = [
        float(record["bbox_affine_aligned_symmetric_hausdorff_m"])
        for record in link_records
        if record.get("bbox_affine_aligned_symmetric_hausdorff_m") is not None
    ]
    candidate_fit_records = [
        fit
        for record in link_records
        for fit in record.get("candidate_fits", [])
        if isinstance(fit, dict)
    ]
    exported_candidate_fits = [
        fit for fit in candidate_fit_records if fit.get("exported")
    ]
    accepted_candidate_fits = [
        fit for fit in candidate_fit_records if fit.get("accepted")
    ]
    bbox_affine_pass_candidate_fits = [
        fit
        for fit in candidate_fit_records
        if fit.get("bbox_affine_alignment_would_pass")
    ]
    best_requests, _ = _best_candidate_requests(body_matching_report)
    ok = bool(len(link_records) == 28 and len(exported) == len(link_records))
    all_accepted = ok and len(accepted) == len(link_records)
    return {
        "schema": BREP_SURFACE_FIT_SCHEMA,
        "ok": ok,
        "accepted": all_accepted,
        "source": {
            "mesh_dir": str(mesh_dir),
            "body_matching_schema": body_matching_report.get("schema"),
            "surface_tolerance_m": float(surface_tolerance_m),
            "max_sample_count": int(max_sample_count),
            "surface_candidates_per_link": int(surface_candidates_per_link),
            "export_timeout_s": int(export_timeout_s),
            "best_candidate_unique_bodies": len(best_requests),
            "ranked_candidate_unique_bodies": len(requests),
        },
        "summary": {
            "links": len(link_records),
            "best_candidate_unique_bodies": len(best_requests),
            "ranked_candidate_unique_bodies": len(requests),
            "surface_candidates_per_link": int(surface_candidates_per_link),
            "evaluated_candidate_fits": len(candidate_fit_records),
            "exported_candidate_fits": len(exported_candidate_fits),
            "accepted_candidate_fits": len(accepted_candidate_fits),
            "exported_links": len(exported),
            "accepted_link_fits": len(accepted),
            "rejected_link_fits": len(link_records) - len(accepted),
            "surface_tolerance_m": float(surface_tolerance_m),
            "symmetric_hausdorff_min_m": min(residuals, default=None),
            "symmetric_hausdorff_max_m": max(residuals, default=None),
            "center_aligned_symmetric_hausdorff_min_m": min(
                center_aligned_residuals,
                default=None,
            ),
            "center_aligned_symmetric_hausdorff_max_m": max(
                center_aligned_residuals,
                default=None,
            ),
            "bbox_affine_aligned_symmetric_hausdorff_min_m": min(
                bbox_affine_aligned_residuals,
                default=None,
            ),
            "bbox_affine_aligned_symmetric_hausdorff_max_m": max(
                bbox_affine_aligned_residuals,
                default=None,
            ),
            "bbox_affine_alignment_pass_candidate_fits": len(
                bbox_affine_pass_candidate_fits
            ),
            "bbox_affine_alignment_pass_links": sum(
                1 for record in link_records if record.get("bbox_affine_alignment_would_pass")
            ),
            "shape_mismatch_after_bbox_alignment_links": sum(
                1
                for record in link_records
                if record.get("residual_classification")
                == "shape_mismatch_after_bbox_alignment"
            ),
            "accepted": all_accepted,
            "acceptance_blocker": None
            if all_accepted
            else "ranked STEP/B-rep candidates do not yet satisfy source-STL surface-fit tolerance",
        },
        "link_fits": link_records,
    }


def dump_fembot_brep_surface_fit_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_brep_surface_fit_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-brep-surface-fit.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_brep_surface_fit_proof_json(report), encoding="utf-8")
    return output
