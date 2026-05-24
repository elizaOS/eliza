"""Audit robot training inputs before launching expensive training.

This validator reviews the pieces that silently decide whether a run is
well-posed: robot profiles/assets, curriculum task support, text-conditioning
variants, dataset presence, and the current profile-env action/observation
contract. It is intentionally stricter for the default/full-training task set
than for future curriculum tiers: unsupported future tasks are reported as
warnings, but unsupported launch tasks are blockers.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

PKG_ROOT = Path(__file__).resolve().parents[1]
if str(PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(PKG_ROOT))

from eliza_robot.curriculum.loader import load_curriculum  # noqa: E402
from eliza_robot.profiles.schema import list_profiles, load_profile  # noqa: E402
from eliza_robot.rl.text_conditioned.encoder import (  # noqa: E402
    DEFAULT_PCA_DIM,
    curriculum_content_sha256,
)
from eliza_robot.rl.text_conditioned.profile_env import (  # noqa: E402
    ProfileEnvConfig,
    make_text_conditioned_env,
)
from scripts.train_text_conditioned import _DEFAULT_TASKS  # noqa: E402

SUPPORTED_REWARD_KEYS = {
    "target_velocity_x_m_s",
    "target_velocity_y_m_s",
    "target_yaw_rate_rad_s",
    "target_yaw_change_rad",
    "torso_height_target_m",
    "torso_height_target_ratio",
    "torso_height_tolerance_m",
    "torso_height_tolerance_ratio",
    "upright_weight",
    "velocity_track_weight",
    "yaw_track_weight",
    "gait_phase_weight",
    "action_rate_weight",
    "energy_weight",
    "progress_weight",
}

SUPPORTED_SUCCESS_KEYS = {
    "torso_z_min_m",
    "torso_z_max_m",
    "torso_z_min_ratio",
    "torso_z_max_ratio",
    "hold_s",
    "fall_pitch_rad",
    "fall_roll_rad",
    "delta_x_m_min",
    "delta_x_m_max",
    "delta_y_m_min",
    "delta_y_m_max",
    "delta_yaw_rad_min",
    "delta_yaw_rad_max",
    "abs_delta_yaw_rad_min",
    "window_s",
    "max_lateral_drift_m",
    "no_fall",
}


def _task_support(task) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    if task.requires_target:
        reasons.append("requires_target_scene")
    unsupported_reward = sorted(set(task.reward) - SUPPORTED_REWARD_KEYS)
    unsupported_success = sorted(set(task.success) - SUPPORTED_SUCCESS_KEYS)
    if unsupported_reward:
        reasons.append(f"unsupported_reward_keys={unsupported_reward}")
    if unsupported_success:
        reasons.append(f"unsupported_success_keys={unsupported_success}")
    if task.init_state not in (None, "stand", "sit", "crouch"):
        reasons.append(f"unsupported_init_state={task.init_state!r}")
    return not reasons, reasons


def _text_variant_collisions(curriculum) -> list[dict[str, Any]]:
    seen: dict[str, list[str]] = defaultdict(list)
    for task in curriculum.tasks:
        for variant in task.verbs.all_variants():
            seen[variant.lower().strip()].append(task.id)
    return [
        {"variant": variant, "task_ids": task_ids}
        for variant, task_ids in sorted(seen.items())
        if len(set(task_ids)) > 1
    ]


def _profile_report(profile_id: str, *, launch_tasks: tuple[str, ...]) -> dict[str, Any]:
    profile = load_profile(profile_id)
    leg_joints = [j for j in profile.kinematics.joints if j.group == "LEG"]
    assets = {
        "mjcf_xml": str(profile.assets.mjcf_xml),
        "mjx_xml": str(profile.assets.mjx_xml),
        "urdf": str(profile.assets.urdf),
        "mesh_dir": str(profile.assets.mesh_dir),
        "scene_xml": str(profile.assets.scene_xml) if profile.assets.scene_xml else None,
    }
    missing_assets = [
        key
        for key, value in assets.items()
        if value is not None and not Path(value).exists()
    ]

    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            include_tasks=launch_tasks,
            exclude_tasks=(),
            pca_dim=DEFAULT_PCA_DIM,
            episode_steps=4,
            domain_rand=False,
        ),
    )
    obs_dim = int(env.observation_space.shape[0])
    action_dim = int(env.action_space.shape[0])
    expected_proprio_dim = 3 + 3 + 3 + 3 * len(leg_joints)

    mujoco_compile_ok = None
    mujoco_compile_error = None
    try:
        env.reset(seed=0)
        mujoco_compile_ok = True
    except Exception as exc:  # pragma: no cover - exercised in integration use
        mujoco_compile_ok = False
        mujoco_compile_error = str(exc)

    return {
        "profile_id": profile_id,
        "dof": profile.kinematics.dof,
        "leg_action_dim": len(leg_joints),
        "env_action_dim": action_dim,
        "env_obs_dim": obs_dim,
        "expected_proprio_dim": expected_proprio_dim,
        "output_dim": len(profile.kinematics.joints),
        "assets": assets,
        "missing_assets": missing_assets,
        "mujoco_compile_ok": mujoco_compile_ok,
        "mujoco_compile_error": mujoco_compile_error,
        "ok": (
            not missing_assets
            and mujoco_compile_ok is True
            and action_dim == len(leg_joints)
            and obs_dim == expected_proprio_dim + DEFAULT_PCA_DIM
        ),
    }


def _dataset_report() -> dict[str, Any]:
    data_dir = PKG_ROOT / "data"
    datasets_dir = PKG_ROOT / "datasets"
    trajectory_db = PKG_ROOT / "eliza_robot" / "trajectory_db"
    dataset_files = [
        str(p.relative_to(PKG_ROOT))
        for root in (data_dir, datasets_dir)
        if root.exists()
        for p in root.rglob("*")
        if p.is_file() and p.name not in {".gitkeep", "README.md"}
    ]
    return {
        "data_dir": str(data_dir),
        "datasets_dir": str(datasets_dir),
        "trajectory_db_tooling_present": trajectory_db.is_dir(),
        "offline_dataset_files": sorted(dataset_files),
        "offline_datasets_present": bool(dataset_files),
        "rl_from_sim_ready": True,
        "imitation_training_ready": bool(dataset_files),
        "offline_datasets_block_current_plan": False,
        "training_source": (
            "RL-from-simulation; trajectory_db tooling is not wired into the "
            "Alberta/PPO text-conditioned policy trainers."
        ),
    }


def build_report(*, launch_tasks: tuple[str, ...]) -> dict[str, Any]:
    curriculum = load_curriculum()
    task_ids = curriculum.all_ids()
    duplicate_ids = sorted({task_id for task_id in task_ids if task_ids.count(task_id) > 1})
    missing_launch_tasks = sorted(set(launch_tasks) - set(task_ids))

    task_reports = []
    unsupported_launch_tasks = []
    unsupported_future_tasks = []
    for task in curriculum.tasks:
        supported, reasons = _task_support(task)
        entry = {
            "task_id": task.id,
            "tier": task.tier,
            "supported_by_profile_env": supported,
            "reasons": reasons,
            "in_launch_tasks": task.id in launch_tasks,
        }
        task_reports.append(entry)
        if not supported and task.id in launch_tasks:
            unsupported_launch_tasks.append(entry)
        elif not supported:
            unsupported_future_tasks.append(entry)

    profiles = [
        _profile_report(profile_id, launch_tasks=launch_tasks)
        for profile_id in list_profiles()
    ]
    blockers = []
    warnings = []
    if duplicate_ids:
        blockers.append({"kind": "duplicate_task_ids", "task_ids": duplicate_ids})
    if missing_launch_tasks:
        blockers.append({"kind": "missing_launch_tasks", "task_ids": missing_launch_tasks})
    if unsupported_launch_tasks:
        blockers.append(
            {"kind": "unsupported_launch_tasks", "tasks": unsupported_launch_tasks}
        )
    for profile in profiles:
        if not profile["ok"]:
            blockers.append({"kind": "profile_not_ready", "profile": profile})
    collisions = _text_variant_collisions(curriculum)
    if collisions:
        blockers.append({"kind": "text_variant_collisions", "collisions": collisions})
    if unsupported_future_tasks:
        warnings.append(
            {
                "kind": "unsupported_future_curriculum_tasks",
                "tasks": unsupported_future_tasks,
            }
        )

    dataset_report = _dataset_report()
    if not dataset_report["offline_datasets_present"]:
        warnings.append(
            {
                "kind": "no_offline_policy_datasets",
                "detail": (
                    "No imitation/offline policy dataset files were found. "
                    "This is acceptable for the current RL-from-sim plan, but "
                    "not for a demonstration/imitation training run."
                ),
            }
        )

    return {
        "ok": not blockers,
        "launch_tasks": list(launch_tasks),
        "curriculum": {
            "version": curriculum.version,
            "task_count": len(curriculum.tasks),
            "content_sha256": curriculum_content_sha256(curriculum),
            "duplicate_ids": duplicate_ids,
            "text_variant_collisions": collisions,
        },
        "tasks": task_reports,
        "profiles": profiles,
        "datasets": dataset_report,
        "blockers": blockers,
        "warnings": warnings,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tasks",
        nargs="+",
        default=list(_DEFAULT_TASKS),
        help="Task set that will be used for the launch/training job.",
    )
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args(argv)
    report = build_report(launch_tasks=tuple(args.tasks))
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(encoded, encoding="utf-8")
    print(encoded)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
