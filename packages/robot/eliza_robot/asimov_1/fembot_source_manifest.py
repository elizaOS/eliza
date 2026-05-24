"""Source STEP split manifest for ASIMOV fembot body groups."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import ASIMOV1_MAIN_STEP, ASIMOV1_MECHANICAL_ROOT
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS


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


def build_fembot_source_manifest_proof(
    body_groups: list[dict[str, Any]],
    *,
    main_step: Path = ASIMOV1_MAIN_STEP,
    mechanical_root: Path = ASIMOV1_MECHANICAL_ROOT,
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

        group_records.append(
            {
                "group": group.get("group"),
                "links": links,
                "assembly_candidates": assemblies,
                "assembly_records": assembly_records,
                "step_files": step_records,
                "step_file_count": len(step_records),
                "exact_link_assignments": [],
                "unresolved_links": links,
                "source_kind": "source_step_group_candidate_manifest",
                "accepted": False,
                "blocking_reason": (
                    "body-group STEP candidates are inventoried, but individual "
                    "simulation links are not yet assigned to exact STEP/B-rep "
                    "bodies or controlled loft sources"
                ),
            }
        )

    link_count = sum(len(group.get("links", [])) for group in group_records)
    unresolved_count = sum(len(group["unresolved_links"]) for group in group_records)
    ok = bool(main_step.is_file() and mechanical_root.is_dir() and not missing_assemblies and group_records)
    return {
        "schema": SOURCE_MANIFEST_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "main_step": str(main_step),
            "main_step_sha256": sha256_file(main_step) if main_step.is_file() else None,
            "mechanical_root": str(mechanical_root),
        },
        "summary": {
            "body_groups": len(group_records),
            "links": link_count,
            "unique_step_files": len(all_step_paths),
            "group_step_file_references": sum(group["step_file_count"] for group in group_records),
            "fabrication_class_counts": dict(sorted(fabrication_class_counts.items())),
            "missing_assemblies": sorted(set(missing_assemblies)),
            "exact_link_assignments": 0,
            "unresolved_links": unresolved_count,
            "accepted": False,
            "acceptance_blocker": (
                "the ASIMOV source STEP split is inventoried by fembot body group, "
                "but every simulation link still needs exact STEP/B-rep body assignment "
                "or a controlled loft source with fit and interface error bounds"
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
