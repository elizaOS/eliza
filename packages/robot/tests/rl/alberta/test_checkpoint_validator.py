from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

from eliza_robot.curriculum.loader import load_curriculum
from eliza_robot.profiles.schema import load_profile
from eliza_robot.rl.alberta.agent import AlbertaContinualController, AlbertaControllerConfig
from eliza_robot.rl.alberta.features import FeatureConfig
from scripts.validate_alberta_robot_checkpoint import validate_alberta_robot_checkpoint


def _task_physical_checks(task: str) -> dict[str, bool]:
    locomotion_support = {
        "min_swing_foot_clearance_m": True,
        "max_foot_slip_m_s": True,
        "max_self_collision_count": True,
    }
    if task == "stand_up":
        return {
            "hold_s": True,
            "torso_height_gain": True,
            "tracked_height_gain": True,
        }
    if task == "walk_forward":
        return {
            "no_fall": True,
            "hold_s": True,
            "min_alternating_foot_contacts": True,
            "tracked_height_present": True,
            "tracked_delta_x_forward": True,
            "tracked_lateral_drift_bound": True,
            "yaw_drift_bound": True,
            **locomotion_support,
        }
    if task == "walk_backward":
        return {
            "no_fall": True,
            "hold_s": True,
            "min_alternating_foot_contacts": True,
            "tracked_height_present": True,
            "tracked_delta_x_backward": True,
            "tracked_lateral_drift_bound": True,
            "yaw_drift_bound": True,
            **locomotion_support,
        }
    if task == "sidestep_left":
        return {
            "no_fall": True,
            "hold_s": True,
            "min_alternating_foot_contacts": True,
            "tracked_height_present": True,
            "tracked_delta_y_left": True,
            "tracked_forward_drift_bound": True,
            "yaw_drift_bound": True,
            **locomotion_support,
        }
    if task == "sidestep_right":
        return {
            "no_fall": True,
            "hold_s": True,
            "min_alternating_foot_contacts": True,
            "tracked_height_present": True,
            "tracked_delta_y_right": True,
            "tracked_forward_drift_bound": True,
            "yaw_drift_bound": True,
            **locomotion_support,
        }
    if task == "turn_left":
        return {
            "no_fall": True,
            "hold_s": True,
            "tracked_height_present": True,
            "delta_yaw_left": True,
            "tracked_translation_drift_bound": True,
        }
    if task == "turn_right":
        return {
            "no_fall": True,
            "hold_s": True,
            "tracked_height_present": True,
            "delta_yaw_right": True,
            "tracked_translation_drift_bound": True,
        }
    return {}


def _task_motion(task: str) -> tuple[float, float, float]:
    if task == "walk_forward":
        return 0.4, 0.0, 0.0
    if task == "walk_backward":
        return -0.3, 0.0, 0.0
    if task == "sidestep_left":
        return 0.0, 0.3, 0.0
    if task == "sidestep_right":
        return 0.0, -0.3, 0.0
    if task == "turn_left":
        return 0.02, 0.01, 0.8
    if task == "turn_right":
        return 0.02, -0.01, -0.8
    return 0.0, 0.0, 0.0


def _write_alberta_checkpoint(
    path: Path,
    *,
    profile_id: str = "hiwonder-ainex",
    total_steps: int = 10,
    output_dim: int | None = None,
    domain_rand: bool = True,
    tasks: list[str] | None = None,
) -> None:
    path.mkdir(parents=True, exist_ok=True)
    profile = load_profile(profile_id)
    output_dim = len(profile.kinematics.joints) if output_dim is None else output_dim
    feature_cfg = FeatureConfig(
        mode="sparse_gated",
        embed_dim=32,
        n_prototypes=64,
        gate_hard=True,
        proprio_random_dim=32,
        random_dim=256,
        seed=0,
    )
    controller_cfg = AlbertaControllerConfig(
        obs_dim=77,
        action_dim=12,
        gamma=0.5,
        log_sigma_init=-1.0,
        normalize=False,
        obgd_kappa=2.0,
        features=feature_cfg,
        seed=0,
    )
    controller = AlbertaContinualController(controller_cfg)
    np.savez(path / "alberta_policy.npz", **controller.state_dict())
    tasks = tasks or ["stand_up"]
    manifest = {
        "regime": "alberta_streaming",
        "phase_promotion_schema": "alberta-phase-promotion-v1",
        "curriculum_version": load_curriculum().version,
        "pca_dim": 32,
        "active_tasks": tasks,
        "obs_dim": 77,
        "action_dim": 12,
        "output_dim": output_dim,
        "profile_id": profile_id,
        "profile_version": profile.version,
        "proprio_dim": 45,
        "text_dim": 32,
        "ckpt": "alberta_policy.npz",
        "requested_total_steps": total_steps,
        "steps_per_task": total_steps // len(tasks),
        "total_steps": total_steps,
        "episode_steps": 200,
        "action_scale": 0.3,
        "action_scale_schedule": {
            "schema": "alberta-action-scale-schedule-v1",
            "mode": "no_fall_physical_gate_ramp",
            "enabled": True,
            "initial_scale": 0.15,
            "target_scale": 0.3,
            "increment": 0.05,
            "final_scale": 0.3,
            "criteria": {
                "failure_rate_lte": 0.0,
                "physical_success": True,
                "success_rate_gte": 1.0,
            },
            "events": [
                {
                    "phase": None,
                    "task": None,
                    "step": 0,
                    "from_scale": None,
                    "to_scale": 0.15,
                    "reason": "initial_stability_scale",
                    "gate_passed": True,
                },
                {
                    "phase": 0,
                    "task": tasks[0],
                    "step": total_steps // len(tasks),
                    "from_scale": 0.15,
                    "to_scale": 0.3,
                    "reason": "no_fall_physical_gate_passed",
                    "gate_passed": True,
                },
            ],
        },
        "eval_episodes": 3,
        "seed": 0,
        "domain_rand": domain_rand,
        "controller": {
            "gamma": controller_cfg.gamma,
            "actor_step_size": controller_cfg.actor_step_size,
            "critic_step_size": controller_cfg.critic_step_size,
            "actor_lamda": controller_cfg.actor_lamda,
            "critic_lamda": controller_cfg.critic_lamda,
            "log_sigma_init": controller_cfg.log_sigma_init,
            "log_sigma_min": controller_cfg.log_sigma_min,
            "log_sigma_max": controller_cfg.log_sigma_max,
            "action_low": controller_cfg.action_low,
            "action_high": controller_cfg.action_high,
            "obgd_kappa": controller_cfg.obgd_kappa,
            "normalize": controller_cfg.normalize,
            "normalizer_decay": controller_cfg.normalizer_decay,
            "decouple_global_bias": controller_cfg.decouple_global_bias,
            "features": {
                "mode": feature_cfg.mode,
                "embed_dim": feature_cfg.embed_dim,
                "n_prototypes": feature_cfg.n_prototypes,
                "gate_hard": feature_cfg.gate_hard,
                "gate_temperature": feature_cfg.gate_temperature,
                "proprio_random_dim": feature_cfg.proprio_random_dim,
                "random_dim": feature_cfg.random_dim,
                "scale": feature_cfg.scale,
                "seed": feature_cfg.seed,
            },
        },
        "history": [
            {
                "phase": phase,
                "task": task,
                "train_episodes": 1,
                "train_mean_return": -1.0,
                "eval_mean_return": -0.5,
                "eval_success_rate": 1.0,
                "promotion_passed": True,
            }
            for phase, task in enumerate(tasks)
        ],
    }
    cumulative = 0
    phases = []
    steps_per_task = total_steps // len(tasks)
    for phase, task in enumerate(tasks):
        cumulative += steps_per_task
        delta_x, delta_y, delta_yaw = _task_motion(task)
        phases.append(
            {
                "phase": phase,
                "task": task,
                "attempt": 1,
                "steps_trained": steps_per_task,
                "cumulative_steps": cumulative,
                "eval_episodes": 3,
                "eval_mean_return": -0.5,
                "eval_success_rate": 1.0,
                "failure_rate": 0.0,
                "physical_success": True,
                "physical_checks": _task_physical_checks(task),
                "tracked_body_name": "body_link",
                "mean_final_delta_yaw_rad": delta_yaw,
                "mean_final_torso_z_m": 1.0,
                "mean_final_torso_z_delta_m": 0.1 if task == "stand_up" else 0.0,
                "mean_final_tracked_delta_x_m": delta_x,
                "mean_final_tracked_delta_y_m": delta_y,
                "mean_final_tracked_delta_z_m": 0.1 if task == "stand_up" else 0.0,
                "mean_final_tracked_z_m": 1.0,
                "eval_failures": 0,
                "promotion_passed": True,
                "promotion_reason": "success_rate_gte_threshold",
            }
        )
    manifest["phase_promotion"] = {
        "gate": "curriculum_goal_checker",
        "status": "completed",
        "success_threshold": 1.0,
        "eval_episodes": 3,
        "eval_interval_steps": steps_per_task,
        "max_phase_attempts": 1,
        "promoted_phase_count": len(tasks),
        "requested_phase_count": len(tasks),
        "failed_phase": None,
        "phases": phases,
    }
    (path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def test_alberta_checkpoint_validator_accepts_complete_checkpoint(tmp_path: Path) -> None:
    _write_alberta_checkpoint(tmp_path)

    report = validate_alberta_robot_checkpoint(
        tmp_path,
        profile_id="hiwonder-ainex",
        required_tasks=["stand_up"],
        min_steps=10,
        require_domain_rand=True,
        require_inference=True,
    )

    assert report["ok"] is True
    assert all(report["checks"].values())
    assert report["inference_report"]["ok"] is True


def test_alberta_checkpoint_validator_rejects_undertrained_checkpoint(tmp_path: Path) -> None:
    _write_alberta_checkpoint(tmp_path, total_steps=9)

    report = validate_alberta_robot_checkpoint(tmp_path, min_steps=10)

    assert report["ok"] is False
    assert report["checks"]["total_steps"] is False
    assert report["checks"]["requested_total_steps"] is False


def test_alberta_checkpoint_validator_can_require_phase_promotion(tmp_path: Path) -> None:
    _write_alberta_checkpoint(tmp_path)

    report = validate_alberta_robot_checkpoint(
        tmp_path,
        min_steps=10,
        require_phase_promotion=True,
    )

    assert report["ok"] is True
    assert report["checks"]["phase_promotion"] is True


def test_alberta_checkpoint_validator_rejects_failed_phase_promotion(tmp_path: Path) -> None:
    _write_alberta_checkpoint(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["phase_promotion"]["status"] = "failed"
    manifest["phase_promotion"]["failed_phase"] = 0
    manifest["phase_promotion"]["phases"][0]["promotion_passed"] = False
    manifest["phase_promotion"]["phases"][0]["eval_success_rate"] = 0.0
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    report = validate_alberta_robot_checkpoint(
        tmp_path,
        min_steps=10,
        require_phase_promotion=True,
    )

    assert report["ok"] is False
    assert report["checks"]["phase_promotion"] is False


def test_alberta_checkpoint_validator_requires_physical_phase_evidence(
    tmp_path: Path,
) -> None:
    _write_alberta_checkpoint(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["phase_promotion"]["phases"][0].pop("tracked_body_name")
    manifest["phase_promotion"]["phases"][0]["physical_checks"] = {}
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    report = validate_alberta_robot_checkpoint(
        tmp_path,
        min_steps=10,
        require_phase_promotion=True,
    )

    assert report["ok"] is False
    assert report["checks"]["phase_promotion"] is False


def test_alberta_checkpoint_validator_rejects_stale_tracked_body(
    tmp_path: Path,
) -> None:
    _write_alberta_checkpoint(tmp_path, profile_id="hiwonder-ainex")
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["phase_promotion"]["phases"][0]["tracked_body_name"] = "head_tilt_link"
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    report = validate_alberta_robot_checkpoint(
        tmp_path,
        min_steps=10,
        require_phase_promotion=True,
    )

    assert report["ok"] is False
    assert report["checks"]["phase_promotion"] is False


def test_alberta_checkpoint_validator_recomputes_phase_signed_motion(
    tmp_path: Path,
) -> None:
    _write_alberta_checkpoint(tmp_path, tasks=["walk_backward"])
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["phase_promotion"]["phases"][0]["mean_final_tracked_delta_x_m"] = 0.4
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    report = validate_alberta_robot_checkpoint(
        tmp_path,
        profile_id="hiwonder-ainex",
        required_tasks=["walk_backward"],
        require_phase_promotion=True,
    )

    assert report["ok"] is False
    assert report["checks"]["phase_promotion"] is False


def test_alberta_checkpoint_validator_rejects_extra_failed_physical_check(
    tmp_path: Path,
) -> None:
    _write_alberta_checkpoint(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["phase_promotion"]["phases"][0]["physical_checks"][
        "unexpected_extra_check"
    ] = False
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    report = validate_alberta_robot_checkpoint(
        tmp_path,
        min_steps=10,
        require_phase_promotion=True,
    )

    assert report["ok"] is False
    assert report["checks"]["phase_promotion"] is False


def test_alberta_checkpoint_validator_rejects_missing_required_task(
    tmp_path: Path,
) -> None:
    _write_alberta_checkpoint(tmp_path, tasks=["stand_up"])

    report = validate_alberta_robot_checkpoint(
        tmp_path,
        required_tasks=["stand_up", "walk_forward"],
        min_steps=10,
    )

    assert report["ok"] is False
    assert report["checks"]["required_tasks"] is False


def test_alberta_checkpoint_validator_rejects_duplicate_active_tasks(
    tmp_path: Path,
) -> None:
    _write_alberta_checkpoint(tmp_path, total_steps=20, tasks=["stand_up", "stand_up"])

    report = validate_alberta_robot_checkpoint(
        tmp_path,
        required_tasks=["stand_up"],
        min_steps=20,
    )

    assert report["ok"] is False
    assert report["checks"]["unique_active_tasks"] is False


def test_alberta_checkpoint_validator_rejects_profile_and_output_mismatch(
    tmp_path: Path,
) -> None:
    _write_alberta_checkpoint(tmp_path, output_dim=999)

    report = validate_alberta_robot_checkpoint(
        tmp_path,
        profile_id="unitree-g1",
        min_steps=10,
    )

    assert report["ok"] is False
    assert report["checks"]["profile_id"] is False
    assert report["checks"]["output_dim"] is False


def test_alberta_checkpoint_validator_can_require_domain_randomization(
    tmp_path: Path,
) -> None:
    _write_alberta_checkpoint(tmp_path, domain_rand=False)

    report = validate_alberta_robot_checkpoint(
        tmp_path,
        min_steps=10,
        require_domain_rand=True,
    )

    assert report["ok"] is False
    assert report["checks"]["domain_rand"] is False


def test_alberta_checkpoint_validator_rejects_validation_checkpoint_marker(
    tmp_path: Path,
) -> None:
    _write_alberta_checkpoint(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["validation_checkpoint"] = True
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    report = validate_alberta_robot_checkpoint(tmp_path, min_steps=10)

    assert report["ok"] is False
    assert report["checks"]["not_validation_checkpoint"] is False


def test_alberta_checkpoint_validator_rejects_boolean_controller_scalars(
    tmp_path: Path,
) -> None:
    _write_alberta_checkpoint(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["controller"]["gamma"] = True
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    report = validate_alberta_robot_checkpoint(tmp_path, min_steps=10)

    assert report["ok"] is False
    assert report["checks"]["controller"] is False


def test_alberta_checkpoint_validator_cli(tmp_path: Path) -> None:
    _write_alberta_checkpoint(tmp_path)

    proc = subprocess.run(
        [
            sys.executable,
            "packages/robot/scripts/validate_alberta_robot_checkpoint.py",
            str(tmp_path),
            "--profile",
            "hiwonder-ainex",
            "--tasks",
            "stand_up",
            "--min-steps",
            "10",
            "--require-domain-rand",
        ],
        cwd=Path(__file__).resolve().parents[5],
        capture_output=True,
        text=True,
        check=False,
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["ok"] is True
