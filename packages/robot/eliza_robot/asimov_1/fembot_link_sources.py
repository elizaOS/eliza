"""Per-link source assignment scaffold for ASIMOV fembot."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import ASIMOV1_MAIN_STEP, ASIMOV1_MECHANICAL_ROOT, ASIMOV1_SOURCE_MESH_DIR
from eliza_robot.asimov_1.fembot_body_matching import build_fembot_body_matching_proof
from eliza_robot.asimov_1.fembot_cad_toolchain import build_fembot_cad_toolchain_readiness_proof
from eliza_robot.asimov_1.parametric_inventory import (
    ASIMOV_PARAM_OUTPUT_STL,
    ASIMOV_PARAM_PROOFS,
    _load_spline_fit_proof,
)


LINK_SOURCE_ASSIGNMENT_SCHEMA = "asimov-fembot-link-source-assignment-v1"

def _cad_cli_toolchain(body_matching_report: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return command-line CAD tool availability without requiring a GUI stack."""
    report = build_fembot_cad_toolchain_readiness_proof()
    candidates = {candidate["package"]: candidate for candidate in report["candidates"]}
    isolated_modules = report["isolated_env"]["probe"].get("modules", {})
    body_matching_summary = body_matching_report.get("summary", {}) if body_matching_report else {}
    return {
        "preferred": "python_occ_cli",
        "preferred_ready": bool(report["accepted"]),
        "python_modules": {
            "pycad": bool(candidates["pycad"]["installed"]),
            "cadquery": bool(candidates["cadquery"]["installed"]),
            "build123d": bool(candidates["build123d"]["installed"]),
            "OCP": bool(candidates["cadquery-ocp"]["installed"]),
        },
        "isolated_env": {
            "ready": bool(report["isolated_env"]["ready"]),
            "venv": report["isolated_env"]["venv"],
            "python": report["isolated_env"]["python"],
            "preferred_ready": report["isolated_env"]["preferred_ready"],
            "kernel_ready": bool(report["isolated_env"]["kernel_ready"]),
            "python_modules": {
                "pycad": bool(isolated_modules.get("pycad", {}).get("installed")),
                "cadquery": bool(isolated_modules.get("cadquery", {}).get("installed")),
                "build123d": bool(isolated_modules.get("build123d", {}).get("installed")),
                "OCP": bool(isolated_modules.get("cadquery-ocp", {}).get("installed")),
            },
        },
        "freecadcmd": report["freecad_fallback"]["freecadcmd"],
        "freecadcmd_detected": report["freecad_fallback"]["detected"],
        "freecad_role": report["freecad_fallback"]["role"],
        "body_matching_run": bool(body_matching_report),
        "body_matching_schema": body_matching_report.get("schema") if body_matching_report else None,
        "body_matching_summary": body_matching_summary,
        "readiness_schema": report["schema"],
        "selected_backend": report["selected_backend"],
        "note": report["summary"]["acceptance_blocker"]
        or "preferred command-line Python/OCC CAD backend is available",
    }


def _assembly_step(assembly: str, mechanical_root: Path) -> Path:
    return mechanical_root / assembly / f"ASV1_{assembly}.STEP"


def _group_assignment_strategy(group: str) -> str:
    if group == "torso":
        return "assign structural STEP bodies first; reconstruct cosmetic torso/pelvis shell as smooth controlled loft where source body is visual-only"
    if group == "head":
        return "assign neck mechanism STEP bodies; reconstruct head shell as smooth controlled loft if no exact source B-rep body maps to the STL"
    if group == "arm":
        return "assign side-specific arm assembly bodies and preserve shoulder/elbow/wrist bores before any radial slimming"
    if group == "leg":
        return "assign hip/knee/ankle structural bodies and preserve load-path interfaces before thigh/calf slimming"
    if group == "foot":
        return "split foot/toe bodies from lower-leg assemblies and preserve sole, ankle, and toe contact envelopes"
    return "assign exact STEP/B-rep bodies before production edits"


def _link_assignment_record(
    *,
    group_name: str,
    link: str,
    assemblies: list[str],
    mechanical_root: Path,
    mesh_dir: Path,
    body_match: dict[str, Any] | None = None,
    proof_root: Path = ASIMOV_PARAM_PROOFS,
    output_stl_root: Path = ASIMOV_PARAM_OUTPUT_STL,
) -> dict[str, Any]:
    assembly_steps = [_assembly_step(assembly, mechanical_root) for assembly in assemblies]
    source_stl = mesh_dir / f"{link}.STL"
    source_paths = [str(path) for path in assembly_steps if path.is_file()]
    if source_stl.is_file():
        source_paths.append(str(source_stl))
    source_hashes = {
        str(path): sha256_file(path)
        for path in (*assembly_steps, source_stl)
        if path.is_file()
    }
    output_stl = output_stl_root / f"{link}.STL"
    spline_proof = (
        _load_spline_fit_proof(
            proof_root / f"{link}.spline-fit.json",
            link,
            source_stl=source_stl,
            output_stl=output_stl,
        )
        if source_stl.is_file() and output_stl.is_file()
        else None
    )
    proof_summary = spline_proof.get("summary", {}) if spline_proof else {}
    proof_tolerances = spline_proof.get("tolerances", {}) if spline_proof else {}
    controlled_loft_accepted = bool(
        spline_proof
        and proof_summary.get("ok")
        and proof_summary.get("interfaces_checked", 0) > 0
        and proof_summary.get("interfaces_checked") == proof_summary.get("interfaces_ok")
        and proof_summary.get("output_watertight")
        and proof_summary.get("output_boundary_edges") == 0
        and proof_summary.get("output_nonmanifold_edges") == 0
        and proof_summary.get("surface_symmetric_hausdorff_m", float("inf"))
        <= proof_tolerances.get("surface_distance_tolerance_m", -1)
    )
    max_interface_delta = max(
        float(proof_summary.get("max_interface_centroid_delta_m", float("inf"))),
        float(proof_summary.get("max_interface_bbox_delta_m", float("inf"))),
        float(proof_summary.get("max_interface_radius_delta_m", float("inf"))),
    )
    source_kind = (
        "accepted_controlled_loft_source"
        if controlled_loft_accepted
        else "candidate_step_or_controlled_loft_pending"
    )
    blocking_reason = (
        None
        if controlled_loft_accepted
        else (
            "candidate group STEP and source STL references are known, but no exact "
            "STEP/B-rep body or accepted controlled loft has been assigned to this link"
        )
    )
    return {
        "group": group_name,
        "link": link,
        "source_kind": source_kind,
        "source_paths": source_paths,
        "source_sha256": source_hashes,
        "candidate_assemblies": assemblies,
        "candidate_assembly_steps": [
            {
                "assembly": assembly,
                "path": str(path),
                "sha256": sha256_file(path) if path.is_file() else None,
                "exists": path.is_file(),
            }
            for assembly, path in zip(assemblies, assembly_steps, strict=True)
        ],
        "source_stl_reference": {
            "path": str(source_stl),
            "sha256": sha256_file(source_stl) if source_stl.is_file() else None,
            "exists": source_stl.is_file(),
            "role": "reverse-engineering reference only, not production source",
        },
        "exact_brep_body_assigned": False,
        "controlled_loft_assigned": controlled_loft_accepted,
        "controlled_loft_required": not controlled_loft_accepted,
        "controlled_loft_proof": str(proof_root / f"{link}.spline-fit.json") if spline_proof else None,
        "controlled_loft_validation_source": spline_proof.get("validation_mesh_source")
        if spline_proof
        else None,
        "fit_max_error_m": proof_summary.get("max_error_m") if spline_proof else None,
        "fit_rms_error_m": proof_summary.get("max_rms_error_m") if spline_proof else None,
        "interface_levels_m": [float(interface.get("level")) for interface in spline_proof.get("interfaces", [])]
        if spline_proof
        else [],
        "interface_max_delta_m": max_interface_delta if spline_proof else None,
        "surface_symmetric_hausdorff_m": proof_summary.get("surface_symmetric_hausdorff_m")
        if spline_proof
        else None,
        "topology": {
            "watertight": bool(proof_summary.get("output_watertight")),
            "boundary_edges": proof_summary.get("output_boundary_edges"),
            "nonmanifold_edges": proof_summary.get("output_nonmanifold_edges"),
        },
        "body_matching": {
            "run": body_match is not None,
            "matched": bool(body_match and body_match.get("matched")),
            "accepted": bool(body_match and body_match.get("accepted")),
            "best_score": body_match.get("best_score") if body_match else None,
            "best_candidate_step": body_match.get("best_match", {}).get("source_step")
            if body_match
            else None,
            "best_candidate_source_scope": body_match.get("best_match", {}).get("source_scope")
            if body_match
            else None,
            "best_candidate_relative_path": body_match.get("best_match", {}).get("relative_path")
            if body_match
            else None,
            "best_candidate_fabrication_class": body_match.get("best_match", {}).get("fabrication_class")
            if body_match
            else None,
            "best_candidate_cad_body_index": body_match.get("best_match", {}).get("cad_body_index")
            if body_match
            else None,
            "best_candidate_metrics": body_match.get("best_match", {}).get("metrics")
            if body_match
            else None,
            "candidate_match_count": body_match.get("candidate_match_count") if body_match else 0,
            "blocking_reason": body_match.get("blocking_reason") if body_match else "body matching not run",
        },
        "recommended_next_step": (
            "exact STEP/B-rep body identity is still unresolved; keep this "
            "accepted controlled loft source as the bounded parametric source "
            "until a STEP body can be proven"
            if controlled_loft_accepted
            else (
                "promote the ranked STEP body only after exact B-rep identity, source "
                "surface fit, and mate-interface residuals are bounded; otherwise "
                "reconstruct this link as a controlled loft"
            )
        ),
        "assignment_strategy": _group_assignment_strategy(group_name),
        "accepted": controlled_loft_accepted,
        "blocking_reason": blocking_reason,
    }


def build_fembot_link_source_assignment_proof(
    body_groups: list[dict[str, Any]],
    *,
    main_step: Path = ASIMOV1_MAIN_STEP,
    mechanical_root: Path = ASIMOV1_MECHANICAL_ROOT,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
    body_matching_report: dict[str, Any] | None = None,
    proof_root: Path = ASIMOV_PARAM_PROOFS,
    output_stl_root: Path = ASIMOV_PARAM_OUTPUT_STL,
) -> dict[str, Any]:
    records = []
    missing_source_refs = []
    if body_matching_report is None:
        body_matching_report = build_fembot_body_matching_proof(
            body_groups,
            mesh_dir=mesh_dir,
            max_files_per_group=1,
        )
    body_matches = {
        str(record.get("link")).upper(): record
        for record in body_matching_report.get("link_matches", [])
        if isinstance(record, dict)
    }
    for group in body_groups:
        group_name = str(group.get("group"))
        assemblies = [str(assembly) for assembly in group.get("assembly_candidates", [])]
        for link in [str(link).upper() for link in group.get("links", [])]:
            record = _link_assignment_record(
                group_name=group_name,
                link=link,
                assemblies=assemblies,
                mechanical_root=mechanical_root,
                mesh_dir=mesh_dir,
                body_match=body_matches.get(link),
                proof_root=proof_root,
                output_stl_root=output_stl_root,
            )
            if not record["source_paths"]:
                missing_source_refs.append(link)
            records.append(record)

    exact_assignments = [record for record in records if record["exact_brep_body_assigned"]]
    accepted = [record for record in records if record["accepted"]]
    controlled_loft_assignments = [record for record in records if record["controlled_loft_assigned"]]
    controlled_loft_required = [record for record in records if record["controlled_loft_required"]]
    matched_body_records = [record for record in records if record["body_matching"]["matched"]]
    ok = bool(main_step.is_file() and mechanical_root.is_dir() and len(records) == 28 and not missing_source_refs)
    accepted_all_links = ok and len(accepted) == len(records)
    return {
        "schema": LINK_SOURCE_ASSIGNMENT_SCHEMA,
        "ok": ok,
        "accepted": accepted_all_links,
        "source": {
            "main_step": str(main_step),
            "main_step_sha256": sha256_file(main_step) if main_step.is_file() else None,
            "mechanical_root": str(mechanical_root),
            "mesh_dir": str(mesh_dir),
            "proof_root": str(proof_root),
        },
        "cad_cli_toolchain": _cad_cli_toolchain(body_matching_report),
        "summary": {
            "links": len(records),
            "missing_source_refs": sorted(set(missing_source_refs)),
            "candidate_link_assignments": len(records),
            "exact_brep_body_assignments": len(exact_assignments),
            "controlled_loft_assignments": len(controlled_loft_assignments),
            "controlled_loft_required": len(controlled_loft_required),
            "body_matching_run": True,
            "body_matching_matched_links": len(matched_body_records),
            "body_matching_accepted_links": int(
                body_matching_report.get("summary", {}).get("accepted_link_matches", 0)
            ),
            "accepted_link_assignments": len(accepted),
            "accepted": accepted_all_links,
            "acceptance_blocker": (
                None
                if accepted_all_links
                else (
                    "all links have candidate source references, but at least one "
                    "link lacks exact STEP/B-rep body assignment or an accepted "
                    "controlled-loft source with fit and interface error bounds"
                )
            ),
        },
        "link_assignments": records,
    }


def dump_fembot_link_source_assignment_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_link_source_assignment_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-link-source-assignments.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_link_source_assignment_proof_json(report), encoding="utf-8")
    return output
