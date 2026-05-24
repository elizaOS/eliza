"""MuJoCo collision-sweep proof for ASIMOV-1 geometry."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS


APPROVED_FLOOR_PREFIXES = (
    "left_foot",
    "left_toe",
    "right_foot",
    "right_toe",
)


def _geom_name(mujoco: Any, model: Any, geom_id: int) -> str:
    return mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, int(geom_id)) or str(geom_id)


def _joint_name(mujoco: Any, model: Any, joint_id: int) -> str:
    return mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, int(joint_id)) or str(joint_id)


def _approved_contact(geom_a: str, geom_b: str) -> bool:
    if geom_a == "floor":
        return geom_b.startswith(APPROVED_FLOOR_PREFIXES)
    if geom_b == "floor":
        return geom_a.startswith(APPROVED_FLOOR_PREFIXES)
    return False


def _set_neutral_qpos(data: Any) -> None:
    data.qpos[:] = 0.0
    data.qpos[2] = 0.63
    data.qpos[3] = 1.0


def _sample_contacts(
    *,
    mujoco: Any,
    model: Any,
    data: Any,
    label: str,
    joint: str | None,
    qpos_overrides: dict[int, float],
) -> dict[str, Any]:
    _set_neutral_qpos(data)
    for qpos_adr, value in qpos_overrides.items():
        data.qpos[int(qpos_adr)] = float(value)
    mujoco.mj_forward(model, data)

    contacts: list[dict[str, Any]] = []
    unapproved: list[dict[str, Any]] = []
    approved_floor_contact_count = 0
    min_contact_distance = None
    min_unapproved_distance = None

    for contact_idx in range(int(data.ncon)):
        contact = data.contact[contact_idx]
        geom1 = _geom_name(mujoco, model, int(contact.geom1))
        geom2 = _geom_name(mujoco, model, int(contact.geom2))
        distance = float(contact.dist)
        approved = _approved_contact(geom1, geom2)
        row = {
            "geom1": geom1,
            "geom2": geom2,
            "distance_m": distance,
            "approved": approved,
        }
        contacts.append(row)
        min_contact_distance = (
            distance if min_contact_distance is None else min(min_contact_distance, distance)
        )
        if approved:
            approved_floor_contact_count += 1
        else:
            unapproved.append(row)
            min_unapproved_distance = (
                distance
                if min_unapproved_distance is None
                else min(min_unapproved_distance, distance)
            )

    return {
        "label": label,
        "joint": joint,
        "contact_count": int(data.ncon),
        "approved_floor_contact_count": approved_floor_contact_count,
        "unapproved_contact_count": len(unapproved),
        "minimum_contact_distance_m": min_contact_distance,
        "minimum_unapproved_distance_m": min_unapproved_distance,
        "contacts": contacts,
        "unapproved_contacts": unapproved,
        "accepted": len(unapproved) == 0,
    }


def build_asimov1_collision_sweep_proof(
    *,
    mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
    include_midpoints: bool = True,
) -> dict[str, Any]:
    """Sample neutral and joint-limit poses, recording unapproved contacts.

    This is a deterministic spatial sweep, not a controller rollout. It catches
    whether known joint ranges produce geometry collisions before any fembot
    thinning candidate is accepted.
    """
    load: dict[str, Any] = {
        "import_ok": False,
        "compiled": False,
        "error": None,
    }
    try:
        import mujoco  # type: ignore[import-not-found]

        load["import_ok"] = True
    except Exception as exc:
        return {
            "schema": "asimov-1-collision-sweep-proof-v1",
            "ok": False,
            "accepted": False,
            "mjcf_path": str(mjcf_path),
            "load": {**load, "error": f"{type(exc).__name__}: {exc}"},
            "summary": {
                "samples": 0,
                "unapproved_contact_samples": 0,
                "unapproved_contact_count": 0,
                "minimum_unapproved_distance_m": None,
            },
            "samples": [],
        }

    samples: list[dict[str, Any]] = []
    try:
        model = mujoco.MjModel.from_xml_path(str(mjcf_path))
        data = mujoco.MjData(model)
        load["compiled"] = True

        samples.append(
            _sample_contacts(
                mujoco=mujoco,
                model=model,
                data=data,
                label="neutral",
                joint=None,
                qpos_overrides={},
            )
        )
        for joint_id in range(int(model.njnt)):
            if int(model.jnt_type[joint_id]) != int(mujoco.mjtJoint.mjJNT_HINGE):
                continue
            if not int(model.jnt_limited[joint_id]):
                continue
            joint = _joint_name(mujoco, model, joint_id)
            qpos_adr = int(model.jnt_qposadr[joint_id])
            lower = float(model.jnt_range[joint_id, 0])
            upper = float(model.jnt_range[joint_id, 1])
            values: list[tuple[str, float]] = [("lower", lower), ("upper", upper)]
            if include_midpoints:
                values.insert(1, ("mid", (lower + upper) / 2.0))
            for endpoint, value in values:
                samples.append(
                    _sample_contacts(
                        mujoco=mujoco,
                        model=model,
                        data=data,
                        label=f"{joint}:{endpoint}",
                        joint=joint,
                        qpos_overrides={qpos_adr: value},
                    )
                )
    except Exception as exc:
        load["error"] = f"{type(exc).__name__}: {exc}"

    unapproved_samples = [sample for sample in samples if sample["unapproved_contact_count"] > 0]
    unapproved_contacts = [
        contact
        for sample in unapproved_samples
        for contact in sample["unapproved_contacts"]
    ]
    minimum_unapproved_distance = None
    for sample in unapproved_samples:
        distance = sample["minimum_unapproved_distance_m"]
        if distance is None:
            continue
        minimum_unapproved_distance = (
            distance
            if minimum_unapproved_distance is None
            else min(minimum_unapproved_distance, distance)
        )

    accepted = bool(load["compiled"] and not unapproved_samples)
    return {
        "schema": "asimov-1-collision-sweep-proof-v1",
        "ok": bool(load["compiled"]),
        "accepted": accepted,
        "mjcf_path": str(mjcf_path),
        "load": load,
        "approved_contact_policy": {
            "floor_prefixes": list(APPROVED_FLOOR_PREFIXES),
            "description": "floor contact is approved only for foot/toe collision geoms",
        },
        "summary": {
            "samples": len(samples),
            "unapproved_contact_samples": len(unapproved_samples),
            "unapproved_contact_count": len(unapproved_contacts),
            "minimum_unapproved_distance_m": minimum_unapproved_distance,
            "worst_sample": unapproved_samples[0]["label"] if unapproved_samples else None,
        },
        "samples": samples,
    }


def write_collision_sweep_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "collision-sweep.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return output


def dump_collision_sweep_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"
