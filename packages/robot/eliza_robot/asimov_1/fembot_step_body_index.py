"""CAD-kernel STEP body index for ASIMOV fembot source matching."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import ASIMOV1_MAIN_STEP, ASIMOV1_MECHANICAL_ROOT
from eliza_robot.asimov_1.fembot_cad_toolchain import isolated_cad_env_status
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS


STEP_BODY_INDEX_SCHEMA = "asimov-fembot-step-body-index-v1"
DEFAULT_MAX_FILES_PER_GROUP = 4
DEFAULT_MAIN_ASSEMBLY_TIMEOUT_S = 300


def _fabrication_class(path: Path) -> str:
    parts = {part.upper() for part in path.parts}
    for klass in ("ALU_7075", "SML_316L", "MJF_PA12", "OFF_THE_SHELF"):
        if klass in parts:
            return klass
    return "ASSEMBLY"


def _group_step_candidates(
    assemblies: list[str],
    *,
    mechanical_root: Path,
    max_files: int | None,
) -> list[Path]:
    candidates: list[Path] = []
    for assembly in assemblies:
        fabrication_root = mechanical_root / assembly / "FABRICATION"
        if not fabrication_root.is_dir():
            continue
        for klass in ("ALU_7075", "SML_316L", "MJF_PA12"):
            klass_root = fabrication_root / klass
            candidates.extend(sorted(klass_root.rglob("*.STEP")))
            candidates.extend(sorted(klass_root.rglob("*.step")))
    unique = sorted({path.resolve(): path for path in candidates}.values())
    if max_files is not None:
        return unique[:max_files]
    return unique


def _cadquery_index_step_files(paths: list[Path], *, timeout_s: int = 240) -> list[dict[str, Any]]:
    env = isolated_cad_env_status()
    python = Path(str(env["python"]))
    if not env["ready"] or not python.is_file():
        return [
            {
                "path": str(path),
                "loaded": False,
                "error": "isolated CadQuery/OCP env is not ready",
            }
            for path in paths
        ]

    code = r"""
import json
import sys

from cadquery import importers

payload = json.load(sys.stdin)
records = []
for path in payload["paths"]:
    record = {"path": path, "loaded": False}
    try:
        workplane = importers.importStep(path)
        values = list(workplane.vals())
        solids = []
        for value in values:
            solids.extend(value.Solids())
        bodies = solids or values
        body_records = []
        for index, body in enumerate(bodies):
            bbox = body.BoundingBox()
            try:
                volume = body.Volume()
            except Exception:
                volume = None
            body_records.append(
                {
                    "index": index,
                    "bbox_mm": {
                        "xmin": bbox.xmin,
                        "ymin": bbox.ymin,
                        "zmin": bbox.zmin,
                        "xmax": bbox.xmax,
                        "ymax": bbox.ymax,
                        "zmax": bbox.zmax,
                    },
                    "volume_mm3": volume,
                }
            )
        record.update(
            {
                "loaded": True,
                "value_count": len(values),
                "solid_count": len(solids),
                "body_count": len(body_records),
                "bodies": body_records,
                "solids": body_records,
            }
        )
    except Exception as exc:
        record["error"] = f"{type(exc).__name__}: {exc}"
    records.append(record)
print(json.dumps({"records": records}, sort_keys=True))
"""
    proc = subprocess.run(
        [str(python), "-c", code],
        input=json.dumps({"paths": [str(path) for path in paths]}),
        text=True,
        capture_output=True,
        check=False,
        timeout=timeout_s,
    )
    if proc.returncode != 0:
        message = proc.stderr.strip() or proc.stdout.strip()
        return [{"path": str(path), "loaded": False, "error": message} for path in paths]
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return [
            {"path": str(path), "loaded": False, "error": f"JSONDecodeError: {exc}"}
            for path in paths
        ]
    return list(parsed.get("records", []))


def _main_assembly_step_record(
    *,
    main_step: Path,
    include_cad_index: bool,
    timeout_s: int,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "path": str(main_step),
        "relative_path": main_step.name,
        "exists": main_step.is_file(),
        "sha256": sha256_file(main_step) if main_step.is_file() else None,
        "size_bytes": int(main_step.stat().st_size) if main_step.is_file() else None,
        "cad_index_requested": bool(include_cad_index),
        "cad": {
            "path": str(main_step),
            "loaded": False,
            "skipped": not include_cad_index,
            "error": None if include_cad_index else "main assembly CAD index not requested",
        },
    }
    if not main_step.is_file():
        record["cad"]["error"] = "main assembly STEP file is missing"
        return record
    if not include_cad_index:
        return record
    cad = _cadquery_index_step_files([main_step], timeout_s=timeout_s)
    record["cad"] = cad[0] if cad else {
        "path": str(main_step),
        "loaded": False,
        "error": "missing CAD-kernel result",
    }
    return record


def build_fembot_step_body_index_proof(
    body_groups: list[dict[str, Any]],
    *,
    main_step: Path = ASIMOV1_MAIN_STEP,
    mechanical_root: Path = ASIMOV1_MECHANICAL_ROOT,
    max_files_per_group: int | None = DEFAULT_MAX_FILES_PER_GROUP,
    include_main_assembly: bool = False,
    main_assembly_timeout_s: int = DEFAULT_MAIN_ASSEMBLY_TIMEOUT_S,
) -> dict[str, Any]:
    groups = []
    all_paths: list[Path] = []
    group_paths: dict[str, list[Path]] = {}
    group_assemblies: dict[str, list[str]] = {}
    for group in body_groups:
        group_name = str(group.get("group"))
        assemblies = [str(assembly) for assembly in group.get("assembly_candidates", [])]
        group_assemblies[group_name] = assemblies
        paths = _group_step_candidates(
            assemblies,
            mechanical_root=mechanical_root,
            max_files=max_files_per_group,
        )
        group_paths[group_name] = paths
        all_paths.extend(paths)

    main_assembly = _main_assembly_step_record(
        main_step=main_step,
        include_cad_index=include_main_assembly,
        timeout_s=main_assembly_timeout_s,
    )
    unique_paths = sorted({path.resolve(): path for path in all_paths}.values())
    cad_records = {record["path"]: record for record in _cadquery_index_step_files(unique_paths)}

    loaded_records = [record for record in cad_records.values() if record.get("loaded")]
    failed_records = [record for record in cad_records.values() if not record.get("loaded")]
    solid_count = sum(int(record.get("solid_count", 0)) for record in loaded_records)
    body_count = sum(int(record.get("body_count", 0)) for record in loaded_records)
    material_counts: dict[str, int] = {}

    for group_name, paths in group_paths.items():
        records = []
        for path in paths:
            klass = _fabrication_class(path)
            material_counts[klass] = material_counts.get(klass, 0) + 1
            cad_record = cad_records.get(str(path.resolve())) or cad_records.get(str(path))
            records.append(
                {
                    "path": str(path),
                    "relative_path": str(path.relative_to(mechanical_root)),
                    "sha256": sha256_file(path) if path.is_file() else None,
                    "fabrication_class": klass,
                    "cad": cad_record
                    or {
                        "path": str(path),
                        "loaded": False,
                        "error": "missing CAD-kernel result",
                    },
                }
            )
        groups.append(
            {
                "group": group_name,
                "assembly_candidates": group_assemblies[group_name],
                "indexed_step_files": len(records),
                "records": records,
            }
        )

    main_loaded = bool(main_assembly.get("cad", {}).get("loaded"))
    ok = bool(
        groups
        and main_step.is_file()
        and unique_paths
        and loaded_records
        and not failed_records
        and (main_loaded if include_main_assembly else True)
    )
    full_index = max_files_per_group is None
    accepted = False
    return {
        "schema": STEP_BODY_INDEX_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "main_step": str(main_step),
            "main_step_sha256": sha256_file(main_step) if main_step.is_file() else None,
            "mechanical_root": str(mechanical_root),
            "max_files_per_group": max_files_per_group,
            "include_main_assembly": include_main_assembly,
            "main_assembly_timeout_s": main_assembly_timeout_s,
        },
        "summary": {
            "body_groups": len(groups),
            "main_step_exists": main_step.is_file(),
            "main_step_size_bytes": int(main_step.stat().st_size) if main_step.is_file() else None,
            "main_assembly_cad_index_requested": include_main_assembly,
            "main_assembly_loaded": main_loaded,
            "main_assembly_value_count": int(main_assembly.get("cad", {}).get("value_count", 0))
            if main_loaded
            else 0,
            "main_assembly_solid_count": int(main_assembly.get("cad", {}).get("solid_count", 0))
            if main_loaded
            else 0,
            "main_assembly_body_count": int(main_assembly.get("cad", {}).get("body_count", 0))
            if main_loaded
            else 0,
            "unique_step_files_indexed": len(unique_paths),
            "loaded_step_files": len(loaded_records),
            "failed_step_files": len(failed_records),
            "solid_count": solid_count,
            "body_count": body_count,
            "fabrication_class_counts": dict(sorted(material_counts.items())),
            "full_index": full_index,
            "accepted": accepted,
            "acceptance_blocker": (
                "CAD-kernel fabrication STEP bodies are indexed, but exact link-to-body "
                "matching and fit/interface error bounds have not been solved yet"
            ),
        },
        "main_assembly_step": main_assembly,
        "body_groups": groups,
    }


def dump_fembot_step_body_index_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_step_body_index_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-step-body-index.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_step_body_index_proof_json(report), encoding="utf-8")
    return output
