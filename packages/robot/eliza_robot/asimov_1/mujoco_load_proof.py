"""MuJoCo load proof collection for ASIMOV-1 assets."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.constants import (
    ASIMOV1_FIRMWARE_JOINT_ORDER,
    ASIMOV1_GENERATED_MJCF,
    ASIMOV1_PROFILE_ASSET_ROOT,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

_COMPILER_MESHDIR_RE = re.compile(r"<compiler\b[^>]*\bmeshdir=\"([^\"]+)\"", re.IGNORECASE)
_MESH_RE = re.compile(r"<mesh\b[^>]*\bname=\"([^\"]+)\"[^>]*\bfile=\"([^\"]+)\"", re.IGNORECASE)
_JOINT_RE = re.compile(r"<joint\b[^>]*\bname=\"([^\"]+)\"", re.IGNORECASE)
_POSITION_ACTUATOR_RE = re.compile(
    r"<position\b[^>]*\bname=\"([^\"]+)\"[^>]*\bjoint=\"([^\"]+)\"", re.IGNORECASE
)
_GEOM_RE = re.compile(r"<geom\b[^>]*\bname=\"([^\"]+)\"[^>]*", re.IGNORECASE)


@dataclass(frozen=True)
class StaticMjcfChecks:
    mjcf_exists: bool
    compiler_meshdir: str | None
    compiler_meshdir_exists: bool
    mesh_refs: int
    mesh_files_found: int
    mesh_files_missing: list[str]
    joints: int
    expected_actuators: int
    position_actuators: int
    actuator_joints_match_firmware_order: bool
    missing_firmware_joints: list[str]
    foot_collision_geoms: int
    body_collision_geoms: int
    ok: bool


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def _compiler_meshdir(text: str, mjcf_path: Path) -> Path | None:
    match = _COMPILER_MESHDIR_RE.search(text)
    if not match:
        return None
    raw = match.group(1)
    path = Path(raw)
    return path if path.is_absolute() else (mjcf_path.parent / path)


def collect_static_mjcf_checks(
    *,
    mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
    fallback_mesh_dir: Path = ASIMOV1_PROFILE_ASSET_ROOT / "meshes",
) -> StaticMjcfChecks:
    text = _read_text(mjcf_path)
    compiler_meshdir = _compiler_meshdir(text, mjcf_path)
    mesh_dir = compiler_meshdir or fallback_mesh_dir
    mesh_refs = _MESH_RE.findall(text)
    missing_mesh_files = [
        file_name for _, file_name in mesh_refs if not (mesh_dir / file_name).is_file()
    ]
    joints = _JOINT_RE.findall(text)
    position_actuators = _POSITION_ACTUATOR_RE.findall(text)
    actuator_joints = [joint for _, joint in position_actuators]
    firmware = list(ASIMOV1_FIRMWARE_JOINT_ORDER)
    missing_firmware_joints = [joint for joint in firmware if joint not in joints]
    geoms = _GEOM_RE.findall(text)
    foot_collision_geoms = sum(1 for name in geoms if "foot" in name and "collision" in name)
    body_collision_geoms = sum(1 for name in geoms if "collision" in name) - foot_collision_geoms
    ok = bool(
        mjcf_path.is_file()
        and compiler_meshdir is not None
        and compiler_meshdir.is_dir()
        and len(mesh_refs) == 28
        and not missing_mesh_files
        and actuator_joints == firmware
        and not missing_firmware_joints
        and foot_collision_geoms >= 10
        and body_collision_geoms >= 8
    )
    return StaticMjcfChecks(
        mjcf_exists=mjcf_path.is_file(),
        compiler_meshdir=str(compiler_meshdir) if compiler_meshdir else None,
        compiler_meshdir_exists=bool(compiler_meshdir and compiler_meshdir.is_dir()),
        mesh_refs=len(mesh_refs),
        mesh_files_found=len(mesh_refs) - len(missing_mesh_files),
        mesh_files_missing=missing_mesh_files,
        joints=len(joints),
        expected_actuators=len(firmware),
        position_actuators=len(position_actuators),
        actuator_joints_match_firmware_order=actuator_joints == firmware,
        missing_firmware_joints=missing_firmware_joints,
        foot_collision_geoms=foot_collision_geoms,
        body_collision_geoms=body_collision_geoms,
        ok=ok,
    )


def build_mujoco_load_proof(
    *,
    mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
    proof_links: list[str] | None = None,
) -> dict[str, Any]:
    static = collect_static_mjcf_checks(mjcf_path=mjcf_path)
    text = _read_text(mjcf_path)
    mesh_links = sorted({Path(file_name).stem.upper() for _, file_name in _MESH_RE.findall(text)})
    load: dict[str, Any] = {
        "attempted": False,
        "import_ok": False,
        "compiled": False,
        "forward_ok": False,
        "step_ok": False,
        "error": None,
        "model": None,
    }
    try:
        import mujoco  # type: ignore[import-not-found]

        load["import_ok"] = True
    except Exception as exc:
        load["error"] = f"{type(exc).__name__}: {exc}"
        mujoco = None  # type: ignore[assignment]

    if mujoco is not None:
        load["attempted"] = True
        try:
            model = mujoco.MjModel.from_xml_path(str(mjcf_path))
            data = mujoco.MjData(model)
            load["compiled"] = True
            mujoco.mj_forward(model, data)
            load["forward_ok"] = True
            mujoco.mj_step(model, data)
            load["step_ok"] = True
            load["model"] = {
                "nq": int(model.nq),
                "nv": int(model.nv),
                "nu": int(model.nu),
                "nbody": int(model.nbody),
                "ngeom": int(model.ngeom),
                "nmesh": int(model.nmesh),
            }
        except Exception as exc:
            load["error"] = f"{type(exc).__name__}: {exc}"

    static_dict = asdict(static)
    model = load.get("model") or {}
    model_actuators_ok = bool(model and model.get("nu") == len(ASIMOV1_FIRMWARE_JOINT_ORDER))
    ok = bool(static.ok and load["compiled"] and load["forward_ok"] and load["step_ok"] and model_actuators_ok)
    requested_links = proof_links if proof_links is not None else mesh_links
    links = sorted({str(link).upper() for link in requested_links}) if ok else []
    return {
        "schema": "asimov-1-mujoco-load-proof-v1",
        "ok": ok,
        "mjcf_path": str(mjcf_path),
        "links": links,
        "static": static_dict,
        "load": load,
        "summary": {
            "compiler_meshdir_exists": static.compiler_meshdir_exists,
            "mesh_files_found": static.mesh_files_found,
            "mesh_refs": static.mesh_refs,
            "position_actuators": static.position_actuators,
            "expected_actuators": static.expected_actuators,
            "actuator_order_ok": static.actuator_joints_match_firmware_order,
            "mujoco_import_ok": load["import_ok"],
            "mujoco_compiled": load["compiled"],
            "mujoco_forward_ok": load["forward_ok"],
            "mujoco_step_ok": load["step_ok"],
        },
    }


def write_mujoco_load_proof(report: dict[str, Any], output: Path = ASIMOV_PARAM_PROOFS / "mujoco-load.json") -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return output


def dump_mujoco_load_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"
