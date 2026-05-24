"""Per-link source assignment scaffold for ASIMOV fembot."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import ASIMOV1_MAIN_STEP, ASIMOV1_MECHANICAL_ROOT, ASIMOV1_SOURCE_MESH_DIR
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS


LINK_SOURCE_ASSIGNMENT_SCHEMA = "asimov-fembot-link-source-assignment-v1"

FREECADCMD_CANDIDATES = (
    Path("/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd"),
    Path("/Applications/FreeCAD.app/Contents/Resources/bin/FreeCADCmd"),
    Path("/opt/homebrew/bin/freecadcmd"),
    Path("/opt/homebrew/bin/FreeCADCmd"),
)


def _freecadcmd_path() -> str | None:
    for path in FREECADCMD_CANDIDATES:
        if path.is_file():
            return str(path)
    return None


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
    return {
        "group": group_name,
        "link": link,
        "source_kind": "candidate_step_or_controlled_loft_pending",
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
        "controlled_loft_required": True,
        "fit_max_error_m": None,
        "fit_rms_error_m": None,
        "interface_levels_m": [],
        "interface_max_delta_m": None,
        "recommended_next_step": (
            "run CAD-kernel body matching from candidate STEP assemblies to this "
            "link's source STL and mate interfaces; if no exact B-rep body maps, "
            "promote a controlled loft with bounded fit/interface errors"
        ),
        "assignment_strategy": _group_assignment_strategy(group_name),
        "accepted": False,
        "blocking_reason": (
            "candidate group STEP and source STL references are known, but no exact "
            "STEP/B-rep body or accepted controlled loft has been assigned to this link"
        ),
    }


def build_fembot_link_source_assignment_proof(
    body_groups: list[dict[str, Any]],
    *,
    main_step: Path = ASIMOV1_MAIN_STEP,
    mechanical_root: Path = ASIMOV1_MECHANICAL_ROOT,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
) -> dict[str, Any]:
    records = []
    missing_source_refs = []
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
            )
            if not record["source_paths"]:
                missing_source_refs.append(link)
            records.append(record)

    exact_assignments = [record for record in records if record["exact_brep_body_assigned"]]
    accepted = [record for record in records if record["accepted"]]
    controlled_loft_required = [record for record in records if record["controlled_loft_required"]]
    ok = bool(main_step.is_file() and mechanical_root.is_dir() and len(records) == 28 and not missing_source_refs)
    return {
        "schema": LINK_SOURCE_ASSIGNMENT_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "main_step": str(main_step),
            "main_step_sha256": sha256_file(main_step) if main_step.is_file() else None,
            "mechanical_root": str(mechanical_root),
            "mesh_dir": str(mesh_dir),
        },
        "cad_kernel": {
            "freecadcmd": _freecadcmd_path(),
            "detected": _freecadcmd_path() is not None,
            "body_matching_run": False,
            "note": "FreeCAD/OCC detection is recorded, but exact B-rep body matching is not implemented in this proof yet.",
        },
        "summary": {
            "links": len(records),
            "missing_source_refs": sorted(set(missing_source_refs)),
            "candidate_link_assignments": len(records),
            "exact_brep_body_assignments": len(exact_assignments),
            "controlled_loft_required": len(controlled_loft_required),
            "accepted_link_assignments": len(accepted),
            "accepted": False,
            "acceptance_blocker": (
                "all links have candidate source references, but no link has exact "
                "STEP/B-rep body assignment or an accepted controlled-loft source "
                "with fit and interface error bounds"
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
