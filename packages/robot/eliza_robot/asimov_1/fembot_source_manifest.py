"""Source STEP split manifest for ASIMOV fembot body groups."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import ASIMOV1_MAIN_STEP, ASIMOV1_MECHANICAL_ROOT, ASIMOV1_SOURCE_MESH_DIR
from eliza_robot.asimov_1.parametric_inventory import (
    ASIMOV_PARAM_OUTPUT_STL,
    ASIMOV_PARAM_PROOFS,
    _load_spline_fit_proof,
)


SOURCE_MANIFEST_SCHEMA = "asimov-fembot-source-manifest-v1"


def _fabrication_class(path: Path) -> str:
    parts = {part.upper(): part for part in path.parts}
    for klass in ("ALU_7075", "SML_316L", "MJF_PA12", "OFF_THE_SHELF"):
        if klass in parts:
            return klass
    if path.name.upper().endswith(".STEP"):
        return "ASSEMBLY"
    return "unknown"


def _step_record(path: Path, *, mechanical_root: Path) -> dict[str, Any]:
    return {
        "path": str(path),
        "relative_path": str(path.relative_to(mechanical_root)),
        "name": path.name,
        "assembly": path.relative_to(mechanical_root).parts[0],
        "fabrication_class": _fabrication_class(path),
        "sha256": sha256_file(path) if path.is_file() else None,
    }


def _assembly_step_files(assembly: str, *, mechanical_root: Path) -> list[Path]:
    root = mechanical_root / assembly
    return sorted(root.rglob("*.STEP")) + sorted(root.rglob("*.step"))


def _accepted_controlled_loft_links(
    links: list[str],
    *,
    mesh_dir: Path,
    output_stl_root: Path,
    proof_root: Path,
) -> list[dict[str, Any]]:
    records = []
    for link in links:
        source_stl = mesh_dir / f"{link}.STL"
        output_stl = output_stl_root / f"{link}.STL"
        proof = (
            _load_spline_fit_proof(
                proof_root / f"{link}.spline-fit.json",
                link,
                source_stl=source_stl,
                output_stl=output_stl,
            )
            if source_stl.is_file() and output_stl.is_file()
            else None
        )
        summary = proof.get("summary", {}) if proof else {}
        tolerances = proof.get("tolerances", {}) if proof else {}
        accepted = bool(
            proof
            and summary.get("ok")
            and summary.get("interfaces_checked", 0) > 0
            and summary.get("interfaces_checked") == summary.get("interfaces_ok")
            and summary.get("output_watertight")
            and summary.get("output_boundary_edges") == 0
            and summary.get("output_nonmanifold_edges") == 0
            and summary.get("surface_symmetric_hausdorff_m", float("inf"))
            <= tolerances.get("surface_distance_tolerance_m", -1)
        )
        if accepted:
            records.append(
                {
                    "link": link,
                    "source_kind": "accepted_controlled_loft_source",
                    "proof": str(proof_root / f"{link}.spline-fit.json"),
                    "validation_mesh_source": proof.get("validation_mesh_source"),
                    "fit_max_error_m": summary.get("max_error_m"),
                    "fit_rms_error_m": summary.get("max_rms_error_m"),
                    "surface_symmetric_hausdorff_m": summary.get(
                        "surface_symmetric_hausdorff_m"
                    ),
                    "interfaces_checked": summary.get("interfaces_checked"),
                    "interfaces_ok": summary.get("interfaces_ok"),
                    "output_watertight": summary.get("output_watertight"),
                    "output_boundary_edges": summary.get("output_boundary_edges"),
                    "output_nonmanifold_edges": summary.get("output_nonmanifold_edges"),
                }
            )
    return records


def build_fembot_source_manifest_proof(
    body_groups: list[dict[str, Any]],
    *,
    main_step: Path = ASIMOV1_MAIN_STEP,
    mechanical_root: Path = ASIMOV1_MECHANICAL_ROOT,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
    output_stl_root: Path = ASIMOV_PARAM_OUTPUT_STL,
    proof_root: Path = ASIMOV_PARAM_PROOFS,
) -> dict[str, Any]:
    """Build the current fembot body-group source split manifest.

    This is a source traceability inventory, not accepted per-link proof. It
    records the ASIMOV STEP files that each fembot body group is allowed to
    draw from, then explicitly lists unresolved simulation links that still need
    B-rep body assignment or controlled loft reconstruction.
    """
    group_records = []
    missing_assemblies: list[str] = []
    all_step_paths: set[Path] = set()
    fabrication_class_counts: dict[str, int] = {}

    for group in body_groups:
        assemblies = [str(assembly) for assembly in group.get("assembly_candidates", [])]
        links = [str(link).upper() for link in group.get("links", [])]
        assembly_records = []
        group_step_paths: list[Path] = []
        for assembly in assemblies:
            assembly_root = mechanical_root / assembly
            assembly_step = assembly_root / f"ASV1_{assembly}.STEP"
            step_paths = _assembly_step_files(assembly, mechanical_root=mechanical_root)
            if not assembly_root.is_dir() or not assembly_step.is_file():
                missing_assemblies.append(assembly)
            group_step_paths.extend(step_paths)
            assembly_records.append(
                {
                    "assembly": assembly,
                    "assembly_root": str(assembly_root),
                    "assembly_step": str(assembly_step),
                    "assembly_step_sha256": sha256_file(assembly_step)
                    if assembly_step.is_file()
                    else None,
                    "step_file_count": len(step_paths),
                }
            )

        step_records = [_step_record(path, mechanical_root=mechanical_root) for path in group_step_paths]
        for record in step_records:
            all_step_paths.add(Path(record["path"]))
            klass = str(record["fabrication_class"])
            fabrication_class_counts[klass] = fabrication_class_counts.get(klass, 0) + 1

        controlled_loft_assignments = _accepted_controlled_loft_links(
            links,
            mesh_dir=mesh_dir,
            output_stl_root=output_stl_root,
            proof_root=proof_root,
        )
        accepted_controlled_links = {
            str(record["link"]) for record in controlled_loft_assignments
        }
        unresolved_links = [link for link in links if link not in accepted_controlled_links]

        group_records.append(
            {
                "group": group.get("group"),
                "links": links,
                "assembly_candidates": assemblies,
                "assembly_records": assembly_records,
                "step_files": step_records,
                "step_file_count": len(step_records),
                "exact_link_assignments": [],
                "controlled_loft_assignments": controlled_loft_assignments,
                "unresolved_links": unresolved_links,
                "source_kind": (
                    "source_step_group_with_accepted_controlled_lofts"
                    if not unresolved_links
                    else "source_step_group_candidate_manifest"
                ),
                "accepted": not unresolved_links,
                "blocking_reason": (
                    None
                    if not unresolved_links
                    else (
                        "body-group STEP candidates are inventoried, but at least one "
                        "simulation link is not yet assigned to an exact STEP/B-rep "
                        "body or controlled loft source"
                    )
                ),
            }
        )

    link_count = sum(len(group.get("links", [])) for group in group_records)
    unresolved_count = sum(len(group["unresolved_links"]) for group in group_records)
    controlled_loft_count = sum(
        len(group["controlled_loft_assignments"]) for group in group_records
    )
    ok = bool(main_step.is_file() and mechanical_root.is_dir() and not missing_assemblies and group_records)
    accepted = ok and unresolved_count == 0 and controlled_loft_count == link_count
    return {
        "schema": SOURCE_MANIFEST_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "main_step": str(main_step),
            "main_step_sha256": sha256_file(main_step) if main_step.is_file() else None,
            "mechanical_root": str(mechanical_root),
            "mesh_dir": str(mesh_dir),
            "proof_root": str(proof_root),
        },
        "summary": {
            "body_groups": len(group_records),
            "links": link_count,
            "unique_step_files": len(all_step_paths),
            "group_step_file_references": sum(group["step_file_count"] for group in group_records),
            "fabrication_class_counts": dict(sorted(fabrication_class_counts.items())),
            "missing_assemblies": sorted(set(missing_assemblies)),
            "exact_link_assignments": 0,
            "controlled_loft_assignments": controlled_loft_count,
            "unresolved_links": unresolved_count,
            "accepted": accepted,
            "acceptance_blocker": (
                None
                if accepted
                else (
                    "the ASIMOV source STEP split is inventoried by fembot body group, "
                    "but at least one simulation link still needs exact STEP/B-rep "
                    "body assignment or a controlled loft source with fit and "
                    "interface error bounds"
                )
            ),
        },
        "body_groups": group_records,
    }


def dump_fembot_source_manifest_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_source_manifest_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-source-manifest.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_source_manifest_proof_json(report), encoding="utf-8")
    return output
