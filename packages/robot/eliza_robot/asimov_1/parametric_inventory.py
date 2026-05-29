"""Inventory ASIMOV-1 meshes against the parametric CAD conversion target."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file, validate_cad_tree
from eliza_robot.asimov_1.constants import (
    ASIMOV1_GENERATED_MJCF,
    ASIMOV1_MAIN_STEP,
    ASIMOV1_PROFILE_ASSET_ROOT,
    ASIMOV1_SOURCE_MESH_DIR,
)

ROBOT_PACKAGE_ROOT = Path(__file__).resolve().parents[2]
ASIMOV_FEMININE_CAD_ROOT = ROBOT_PACKAGE_ROOT / "cad" / "asimov-feminine"
ASIMOV_PARAM_ROOT = ASIMOV_FEMININE_CAD_ROOT / "param"
ASIMOV_PARAM_PARTS_ROOT = ASIMOV_PARAM_ROOT / "parts"
ASIMOV_PARAM_OUTPUT_STL = ASIMOV_FEMININE_CAD_ROOT / "output" / "stl"
ASIMOV_PARAM_PROOFS = ASIMOV_FEMININE_CAD_ROOT / "proofs"

_MESH_FILE_RE = re.compile(r"mesh(?:es)?/([^\"'\s<>]+\.STL)", re.IGNORECASE)
_MJCF_MESH_RE = re.compile(r"<mesh\b[^>]*\bname=\"([^\"]+)\"[^>]*\bfile=\"([^\"]+)\"", re.IGNORECASE)


@dataclass(frozen=True)
class AsimovParametricMeshRecord:
    link: str
    mesh_file: str
    source_stl: str
    source_stl_sha256: str | None
    source_stl_bytes: int | None
    mjcf_mesh_refs: list[str]
    connection_spec: bool
    part_script: str | None
    output_stl: str | None
    output_stl_sha256: str | None
    current_method: str
    parametric_status: str
    spline_fit_proof: str | None
    spline_fit_proven: bool
    interface_proven: bool
    topology_proven: bool
    surface_distance_proven: bool
    proven_against_step: bool
    required_proofs: list[str]


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def _source_mentions(source: str, token: str, helper_sources: dict[str, str]) -> bool:
    if token in source:
        return True
    for helper_name, helper_source in helper_sources.items():
        if f"import {helper_name}" in source or f"from {helper_name} import" in source:
            if token in helper_source:
                return True
    return False


def _classify_part_script(script: Path | None, helper_sources: dict[str, str]) -> tuple[str, str]:
    if script is None or not script.is_file():
        return "none", "mesh_only"
    source = _read_text(script)
    if _source_mentions(source, "STEP", helper_sources) and (
        "cadquery" in source or "build123d" in source or "OCP." in source
    ):
        return "step_parametric_candidate", "needs_proof"
    if _source_mentions(source, "rings_to_mesh", helper_sources) or _source_mentions(
        source, "slice_to_rings", helper_sources
    ):
        return "mesh_section_loft", "mesh_derived_parametric_unproven"
    if "Y-mirror" in source or "apply_scale([1.0, -1.0, 1.0])" in source:
        return "mesh_section_loft_mirror", "mesh_derived_parametric_unproven"
    if _source_mentions(source, "warplib", helper_sources) or _source_mentions(
        source, "W.warp", helper_sources
    ):
        return "direct_mesh_warp", "non_parametric_mesh_warp"
    return "script_unknown", "needs_review"


def _mjcf_mesh_refs(mjcf: Path) -> dict[str, list[str]]:
    if not mjcf.is_file():
        return {}
    refs: dict[str, list[str]] = {}
    # Avoid ElementTree here: some local developer Pythons have a broken
    # pyexpat build, and this audit only needs static mesh file attributes.
    for name, file_attr in _MJCF_MESH_RE.findall(_read_text(mjcf)):
        if not file_attr:
            continue
        link = Path(file_attr).stem.upper()
        refs.setdefault(link, []).append(name)
    return refs


def _urdf_mesh_refs(urdf: Path) -> set[str]:
    if not urdf.is_file():
        return set()
    refs: set[str] = set()
    text = _read_text(urdf)
    for match in _MESH_FILE_RE.finditer(text):
        refs.add(Path(match.group(1)).stem.upper())
    return refs


def _required_proofs(method: str, *, has_output: bool) -> list[str]:
    proofs = [
        "source STEP/B-rep or controlled section-loft source is identified per link",
        "every fitted spline reports max/rms section error under the configured tolerance",
        "generated surface round-trips against the input mesh with signed-distance/chamfer bounds",
        "connection planes from the kinematic tree are unchanged within tolerance",
        "watertight/manifold checks pass with no holes, inverted patches, or disconnected shells",
        "MuJoCo loads the generated meshes and inertial/collider updates without changing actuator count",
    ]
    if method == "direct_mesh_warp":
        proofs.insert(0, "replace vertex-warp output with lofted or STEP-parametric geometry")
    if not has_output:
        proofs.insert(0, "generate an output STL or STEP-derived surrogate for the link")
    return proofs


def _load_spline_fit_proof(
    path: Path,
    link: str,
    *,
    source_stl: Path,
    output_stl: Path,
) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if raw.get("schema") != "asimov-1-spline-fit-proof-v1":
        return None
    if str(raw.get("link", "")).upper() != link:
        return None
    summary = raw.get("summary")
    if not isinstance(summary, dict):
        return None
    if (
        raw.get("mesh_sha256") != sha256_file(source_stl)
        or raw.get("output_mesh_sha256") != sha256_file(output_stl)
    ):
        return None
    return raw


def collect_asimov1_parametric_inventory(
    *,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
    profile_asset_root: Path = ASIMOV1_PROFILE_ASSET_ROOT,
    main_step: Path = ASIMOV1_MAIN_STEP,
    mjcf: Path = ASIMOV1_GENERATED_MJCF,
    param_parts_root: Path = ASIMOV_PARAM_PARTS_ROOT,
    output_stl_root: Path = ASIMOV_PARAM_OUTPUT_STL,
    proof_root: Path = ASIMOV_PARAM_PROOFS,
) -> dict[str, Any]:
    """Return a report showing which ASIMOV visual meshes are truly parametric.

    The current repo has useful shape-edit experiments, but most outputs are
    mesh-derived and have not been proven as STEP/loft reconstructions. This
    report makes that distinction explicit so downstream gates can require the
    stronger proof before promotion.
    """
    cad = validate_cad_tree(main_step=main_step, mesh_dir=mesh_dir)
    helper_sources = {
        path.stem: _read_text(path)
        for path in sorted(param_parts_root.glob("_*.py"))
        if path.is_file()
    }
    mjcf_refs = _mjcf_mesh_refs(mjcf)
    urdf_refs = _urdf_mesh_refs(profile_asset_root / "asimov.urdf")
    connection_links: set[str] = set()
    connections_py = ASIMOV_PARAM_ROOT / "connections.py"
    if connections_py.is_file():
        namespace: dict[str, Any] = {}
        exec(connections_py.read_text(encoding="utf-8"), namespace)
        connection_links = set(namespace.get("LINKS", {}).keys())

    records: list[AsimovParametricMeshRecord] = []
    mesh_paths = sorted(mesh_dir.glob("*.STL"))
    for mesh_path in mesh_paths:
        link = mesh_path.stem.upper()
        script = param_parts_root / f"{link}.py"
        method, status = _classify_part_script(script if script.is_file() else None, helper_sources)
        output = output_stl_root / mesh_path.name
        has_output = output.is_file()
        proof_path = proof_root / f"{link}.spline-fit.json"
        spline_proof = (
            _load_spline_fit_proof(
                proof_path,
                link,
                source_stl=mesh_path,
                output_stl=output,
            )
            if has_output
            else None
        )
        spline_fit_proven = bool(spline_proof and spline_proof["summary"].get("ok"))
        interface_proven = bool(
            spline_proof
            and spline_proof["summary"].get("interfaces_checked", 0) > 0
            and spline_proof["summary"].get("interfaces_checked")
            == spline_proof["summary"].get("interfaces_ok")
        )
        topology_proven = bool(
            spline_proof
            and spline_proof["summary"].get("output_watertight")
            and spline_proof["summary"].get("output_boundary_edges") == 0
            and spline_proof["summary"].get("output_nonmanifold_edges") == 0
        )
        surface_distance_proven = bool(
            spline_proof
            and spline_proof["summary"].get("surface_symmetric_hausdorff_m", float("inf"))
            <= spline_proof.get("tolerances", {}).get("surface_distance_tolerance_m", -1)
        )
        proven = method == "step_parametric_candidate" and False
        records.append(
            AsimovParametricMeshRecord(
                link=link,
                mesh_file=mesh_path.name,
                source_stl=str(mesh_path),
                source_stl_sha256=sha256_file(mesh_path) if mesh_path.is_file() else None,
                source_stl_bytes=mesh_path.stat().st_size if mesh_path.is_file() else None,
                mjcf_mesh_refs=sorted(mjcf_refs.get(link, [])),
                connection_spec=link in connection_links,
                part_script=str(script) if script.is_file() else None,
                output_stl=str(output) if has_output else None,
                output_stl_sha256=sha256_file(output) if has_output else None,
                current_method=method,
                parametric_status=status,
                spline_fit_proof=str(proof_path) if spline_proof else None,
                spline_fit_proven=spline_fit_proven,
                interface_proven=interface_proven,
                topology_proven=topology_proven,
                surface_distance_proven=surface_distance_proven,
                proven_against_step=proven,
                required_proofs=_required_proofs(method, has_output=has_output),
            )
        )

    by_method: dict[str, int] = {}
    by_status: dict[str, int] = {}
    for record in records:
        by_method[record.current_method] = by_method.get(record.current_method, 0) + 1
        by_status[record.parametric_status] = by_status.get(record.parametric_status, 0) + 1

    proven_count = sum(1 for record in records if record.proven_against_step)
    spline_fit_count = sum(1 for record in records if record.spline_fit_proven)
    interface_count = sum(1 for record in records if record.interface_proven)
    topology_count = sum(1 for record in records if record.topology_proven)
    surface_distance_count = sum(1 for record in records if record.surface_distance_proven)
    report = {
        "schema": "asimov-1-parametric-inventory-v1",
        "ok": main_step.is_file() and len(records) == 28 and len(mjcf_refs) == 28,
        "fully_parametric": proven_count == len(records) and bool(records),
        "source": {
            "main_step": str(main_step),
            "main_step_sha256": sha256_file(main_step) if main_step.is_file() else None,
            "mesh_dir": str(mesh_dir),
            "mjcf": str(mjcf),
        },
        "counts": {
            "mesh_files": len(records),
            "mjcf_mesh_links": len(mjcf_refs),
            "urdf_mesh_links": len(urdf_refs),
            "with_connection_specs": sum(1 for r in records if r.connection_spec),
            "with_part_scripts": sum(1 for r in records if r.part_script),
            "with_outputs": sum(1 for r in records if r.output_stl),
            "with_spline_fit_proofs": spline_fit_count,
            "with_interface_proofs": interface_count,
            "with_topology_proofs": topology_count,
            "with_surface_distance_proofs": surface_distance_count,
            "proven_parametric": proven_count,
        },
        "methods": by_method,
        "statuses": by_status,
        "records": [asdict(record) for record in records],
    }
    return report


def dump_parametric_inventory_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"
