"""Generate a fembot MuJoCo model that uses the parametric ASIMOV meshes."""

from __future__ import annotations

import json
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import numpy as np

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import ASIMOV1_FIRMWARE_JOINT_ORDER, ASIMOV1_GENERATED_MJCF
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_OUTPUT_STL, ASIMOV_PARAM_PROOFS

FEMBOT_MJCF_SCHEMA = "asimov-fembot-mjcf-v1"
FEMBOT_MJCF_PATH = ASIMOV_PARAM_PROOFS.parent / "output" / "mjcf" / "asimov_fembot.xml"
HIP_SPACING_SCALE = 0.96
HIP_BODY_NAMES = ("left_hip_pitch_link", "right_hip_pitch_link")
ACTUATOR_STEP_RAD = 0.02
ACTUATOR_LAG_SECONDS = 0.25
PROMOTED_COLLIDER_LENGTH_SCALE = 0.5
PROMOTED_STRUCTURAL_COLLIDER_LINKS = frozenset(
    {
        "LEFT_HIP_YAW",
        "RIGHT_HIP_YAW",
        "LEFT_KNEE",
        "RIGHT_KNEE",
        "LEFT_SHOULDER_YAW",
        "RIGHT_SHOULDER_YAW",
    }
)
PROMOTED_RESIDUAL_COLLIDER_PAIRS = (
    ("neck_pitch_link_collision", "waist_yaw_link_collision"),
    ("right_elbow_link_collision", "right_hip_pitch_link_collision"),
    ("left_elbow_link_collision", "left_hip_pitch_link_collision"),
    ("left_elbow_link_collision", "left_shoulder_roll_link_collision"),
    ("right_elbow_link_collision", "right_shoulder_roll_link_collision"),
)


def _parse_vec(raw: str | None) -> list[float]:
    if not raw:
        return [0.0, 0.0, 0.0]
    values = [float(part) for part in raw.split()]
    if len(values) != 3:
        raise ValueError(f"expected 3-vector, got {raw!r}")
    return values


def _format_vec(values: list[float]) -> str:
    return " ".join(f"{value:.12g}" for value in values)


def _mesh_files(root: ET.Element) -> list[str]:
    return [
        str(mesh.get("file"))
        for mesh in root.findall(".//asset/mesh")
        if mesh.get("file")
    ]


def _promote_contact_tuned_colliders(
    *,
    source_mjcf: Path,
    output_mjcf: Path,
    length_scale: float = PROMOTED_COLLIDER_LENGTH_SCALE,
) -> dict[str, Any]:
    from eliza_robot.asimov_1.fembot_contact_tuning import (
        _add_physical_visual_remediation_capsules,
        _fit_link_specific_residual_capsules,
        _shorten_body_capsules,
    )

    reconstruction_plan = [
        {
            "geom_pair": list(pair),
            "recommended_reconstruction": "promoted link-specific residual multi-capsule fit",
        }
        for pair in PROMOTED_RESIDUAL_COLLIDER_PAIRS
    ]
    with tempfile.TemporaryDirectory(prefix="asimov-fembot-promoted-colliders-") as tmp:
        tmp_path = Path(tmp)
        structural_mjcf = tmp_path / "structural-target-length.xml"
        residual_mjcf = tmp_path / "link-specific-residual-fit.xml"
        structural_model = _shorten_body_capsules(
            source_mjcf=source_mjcf,
            output_mjcf=structural_mjcf,
            length_scale=float(length_scale),
            target_links=set(PROMOTED_STRUCTURAL_COLLIDER_LINKS),
        )
        residual_model = _fit_link_specific_residual_capsules(
            source_mjcf=structural_mjcf,
            output_mjcf=residual_mjcf,
            reconstruction_plan=reconstruction_plan,
        )
        physical_visual_model = _add_physical_visual_remediation_capsules(
            source_mjcf=residual_mjcf,
            reference_mjcf=source_mjcf,
            output_mjcf=output_mjcf,
        )
    return {
        "strategy": "physical_visual_remediation_promoted",
        "length_scale": float(length_scale),
        "target_links": sorted(PROMOTED_STRUCTURAL_COLLIDER_LINKS),
        "residual_geom_pairs": [list(pair) for pair in PROMOTED_RESIDUAL_COLLIDER_PAIRS],
        "structural_scaled_geom_count": structural_model["scaled_geom_count"],
        "residual_fit_geom_count": residual_model["fit_geom_count"],
        "physical_visual_remediation_geom_count": physical_visual_model[
            "remediation_geom_count"
        ],
        "scaled_geom_count": (
            int(structural_model["scaled_geom_count"])
            + int(residual_model["scaled_geom_count"])
            + int(physical_visual_model["scaled_geom_count"])
        ),
        "fit_geom_count": (
            int(residual_model["fit_geom_count"])
            + int(physical_visual_model["fit_geom_count"])
        ),
        "mjcf": str(output_mjcf),
        "mjcf_sha256": sha256_file(output_mjcf),
        "contact_enabled": True,
        "scaled_geoms": [
            *structural_model["scaled_geoms"],
            *residual_model["scaled_geoms"],
            *physical_visual_model["scaled_geoms"],
        ],
    }


def _compiled_mass_inertia_report(model: Any | None) -> dict[str, Any]:
    if model is None:
        return {
            "ok": False,
            "body_count": 0,
            "zero_or_negative_body_masses": None,
            "zero_or_negative_body_inertias": None,
        }
    body_mass = np.asarray(model.body_mass[1:], dtype=np.float64)
    body_inertia = np.asarray(model.body_inertia[1:], dtype=np.float64)
    return {
        "ok": bool(
            len(body_mass) > 0
            and np.all(np.isfinite(body_mass))
            and np.all(np.isfinite(body_inertia))
            and np.all(body_mass > 0.0)
            and np.all(body_inertia > 0.0)
        ),
        "body_count": int(model.nbody),
        "dynamic_body_count": int(len(body_mass)),
        "total_mass_kg": float(np.sum(body_mass)),
        "min_body_mass_kg": float(np.min(body_mass, initial=float("inf"))),
        "max_body_mass_kg": float(np.max(body_mass, initial=0.0)),
        "min_body_inertia_kg_m2": float(np.min(body_inertia, initial=float("inf"))),
        "zero_or_negative_body_masses": int(np.sum(body_mass <= 0.0)),
        "zero_or_negative_body_inertias": int(np.sum(body_inertia <= 0.0)),
    }


def _actuator_lag_report(model: Any | None, mujoco: Any) -> dict[str, Any]:
    if model is None:
        return {"ok": False, "reason": "model_not_compiled"}
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    baseline_qpos = np.asarray(data.qpos, dtype=np.float64).copy()
    controls = np.zeros(model.nu, dtype=np.float64)
    tracked: list[dict[str, Any]] = []
    for actuator_index in range(model.nu):
        joint_id = int(model.actuator_trnid[actuator_index, 0])
        if joint_id < 0:
            continue
        qpos_adr = int(model.jnt_qposadr[joint_id])
        base = float(baseline_qpos[qpos_adr])
        target = base + ACTUATOR_STEP_RAD
        if bool(model.actuator_ctrllimited[actuator_index]):
            lo, hi = model.actuator_ctrlrange[actuator_index]
            if target > hi:
                target = base - ACTUATOR_STEP_RAD
            if target < lo:
                target = base + ACTUATOR_STEP_RAD * 0.5
            target = float(np.clip(target, lo, hi))
        delta = target - base
        if abs(delta) <= 1e-9:
            continue
        controls[actuator_index] = target
        tracked.append(
            {
                "actuator_index": actuator_index,
                "joint": mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, joint_id),
                "joint_id": joint_id,
                "qpos_adr": qpos_adr,
                "target_delta_rad": delta,
            }
        )
    data.ctrl[:] = controls
    response_samples: list[dict[str, Any]] = []
    step_count = max(1, int(round(ACTUATOR_LAG_SECONDS / float(model.opt.timestep))))
    sample_steps = sorted(
        {
            1,
            2,
            max(1, int(round(0.02 / float(model.opt.timestep)))),
            max(1, int(round(0.10 / float(model.opt.timestep)))),
            step_count,
        }
    )
    response_by_step: dict[int, list[float]] = {step: [] for step in sample_steps}
    max_abs_qvel = 0.0
    for step in range(1, step_count + 1):
        mujoco.mj_step(model, data)
        max_abs_qvel = max(max_abs_qvel, float(np.max(np.abs(data.qvel), initial=0.0)))
        if step not in response_by_step:
            continue
        for item in tracked:
            qpos_adr = int(item["qpos_adr"])
            delta = float(item["target_delta_rad"])
            response_by_step[step].append(float((data.qpos[qpos_adr] - baseline_qpos[qpos_adr]) / delta))
    for step in sample_steps:
        values = np.asarray(response_by_step[step], dtype=np.float64)
        response_samples.append(
            {
                "step": int(step),
                "time_s": float(step * model.opt.timestep),
                "median_response_fraction": float(np.median(values)) if len(values) else None,
                "min_response_fraction": float(np.min(values)) if len(values) else None,
                "max_response_fraction": float(np.max(values)) if len(values) else None,
            }
        )
    first = response_samples[0]["median_response_fraction"] if response_samples else None
    final = response_samples[-1]["median_response_fraction"] if response_samples else None
    return {
        "ok": bool(
            len(tracked) == len(ASIMOV1_FIRMWARE_JOINT_ORDER)
            and first is not None
            and final is not None
            and 0.0 <= first < 0.10
            and final > 0.50
            and np.all(np.isfinite(data.qpos))
            and np.all(np.isfinite(data.qvel))
        ),
        "model": "MuJoCo position actuators under 20 mrad step; finite, non-instantaneous response",
        "actuators_tracked": len(tracked),
        "expected_actuators": len(ASIMOV1_FIRMWARE_JOINT_ORDER),
        "step_delta_rad": ACTUATOR_STEP_RAD,
        "duration_s": ACTUATOR_LAG_SECONDS,
        "max_abs_qvel_rad_s": max_abs_qvel,
        "response_samples": response_samples,
    }


def generate_fembot_mjcf(
    *,
    source_mjcf: Path = ASIMOV1_GENERATED_MJCF,
    output_mjcf: Path = FEMBOT_MJCF_PATH,
    mesh_dir: Path = ASIMOV_PARAM_OUTPUT_STL,
    hip_spacing_scale: float = HIP_SPACING_SCALE,
    promote_contact_tuned_colliders: bool = True,
) -> dict[str, Any]:
    """Write a generated-fembot MJCF and return a loadable proof record."""
    import mujoco

    tree = ET.parse(source_mjcf)
    root = tree.getroot()
    compiler = root.find("compiler")
    if compiler is None:
        compiler = ET.SubElement(root, "compiler")
    meshdir = "../stl" if output_mjcf.parent.parent == mesh_dir.parent else str(mesh_dir.resolve())
    compiler.set("meshdir", meshdir)

    body_positions: dict[str, dict[str, Any]] = {}
    for body in root.findall(".//body"):
        name = body.get("name")
        if name not in HIP_BODY_NAMES:
            continue
        source_pos = _parse_vec(body.get("pos"))
        output_pos = list(source_pos)
        output_pos[1] *= hip_spacing_scale
        body.set("pos", _format_vec(output_pos))
        body_positions[str(name)] = {
            "source_pos_m": source_pos,
            "output_pos_m": output_pos,
            "y_delta_m": output_pos[1] - source_pos[1],
        }

    output_mjcf.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(tree, space="  ")
    if promote_contact_tuned_colliders:
        with tempfile.TemporaryDirectory(prefix="asimov-fembot-base-mjcf-") as tmp:
            base_mjcf = Path(tmp) / "asimov_fembot_base.xml"
            compiler.set("meshdir", str(mesh_dir.resolve()))
            tree.write(base_mjcf, encoding="utf-8", xml_declaration=False)
            contact_tuned_colliders = _promote_contact_tuned_colliders(
                source_mjcf=base_mjcf,
                output_mjcf=output_mjcf,
            )
            root = ET.parse(output_mjcf).getroot()
    else:
        tree.write(output_mjcf, encoding="utf-8", xml_declaration=False)
        contact_tuned_colliders = {
            "strategy": None,
            "scaled_geom_count": 0,
            "fit_geom_count": 0,
            "physical_visual_remediation_geom_count": 0,
            "contact_enabled": False,
            "scaled_geoms": [],
        }

    missing_meshes = sorted(
        {
            file_name
            for file_name in _mesh_files(root)
            if not (mesh_dir / file_name).is_file()
        }
    )
    model = None
    load_error = None
    mass_inertia = _compiled_mass_inertia_report(None)
    actuator_lag = {"ok": False, "reason": "model_not_compiled"}
    try:
        model = mujoco.MjModel.from_xml_path(str(output_mjcf))
        data = mujoco.MjData(model)
        mujoco.mj_forward(model, data)
        for _ in range(5):
            mujoco.mj_step(model, data)
        mass_inertia = _compiled_mass_inertia_report(model)
        actuator_lag = _actuator_lag_report(model, mujoco)
    except Exception as exc:  # pragma: no cover - exercised by failure artifacts
        load_error = str(exc)

    left = body_positions.get("left_hip_pitch_link", {}).get("source_pos_m")
    right = body_positions.get("right_hip_pitch_link", {}).get("source_pos_m")
    out_left = body_positions.get("left_hip_pitch_link", {}).get("output_pos_m")
    out_right = body_positions.get("right_hip_pitch_link", {}).get("output_pos_m")
    source_spacing = abs(left[1] - right[1]) if left and right else None
    output_spacing = abs(out_left[1] - out_right[1]) if out_left and out_right else None
    spacing_ratio = (
        output_spacing / source_spacing
        if source_spacing is not None and output_spacing is not None and source_spacing > 0
        else None
    )
    ok = bool(
        load_error is None
        and not missing_meshes
        and len(body_positions) == 2
        and spacing_ratio is not None
        and abs(spacing_ratio - hip_spacing_scale) <= 1.0e-9
        and mass_inertia.get("ok")
        and actuator_lag.get("ok")
    )
    report = {
        "schema": FEMBOT_MJCF_SCHEMA,
        "ok": ok,
        "accepted": ok,
        "source": {
            "source_mjcf": str(source_mjcf),
            "source_mjcf_sha256": sha256_file(source_mjcf),
            "mesh_dir": str(mesh_dir),
        },
        "output": {
            "mjcf": str(output_mjcf),
            "mjcf_sha256": sha256_file(output_mjcf),
        },
        "summary": {
            "hip_spacing_scale": hip_spacing_scale,
            "source_hip_spacing_m": source_spacing,
            "output_hip_spacing_m": output_spacing,
            "hip_spacing_ratio": spacing_ratio,
            "contact_tuned_colliders_promoted": bool(promote_contact_tuned_colliders),
            "contact_tuned_collider_strategy": contact_tuned_colliders.get("strategy"),
            "contact_tuned_collider_scaled_geom_count": contact_tuned_colliders.get(
                "scaled_geom_count"
            ),
            "contact_tuned_collider_fit_geom_count": contact_tuned_colliders.get(
                "fit_geom_count"
            ),
            "contact_tuned_collider_physical_visual_remediation_geom_count": (
                contact_tuned_colliders.get("physical_visual_remediation_geom_count")
            ),
            "missing_meshes": missing_meshes,
            "mujoco_compiled": model is not None,
            "mujoco_error": load_error,
            "nmesh": int(model.nmesh) if model is not None else None,
            "nu": int(model.nu) if model is not None else None,
            "mass_inertia_ok": bool(mass_inertia.get("ok")),
            "actuator_lag_ok": bool(actuator_lag.get("ok")),
        },
        "hip_bodies": body_positions,
        "contact_tuned_colliders": contact_tuned_colliders,
        "mass_inertia": mass_inertia,
        "actuator_lag": actuator_lag,
    }
    return report


def dump_fembot_mjcf_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_mjcf_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-mjcf.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_mjcf_json(report), encoding="utf-8")
    return output
