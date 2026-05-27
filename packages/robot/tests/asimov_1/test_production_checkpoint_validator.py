# ruff: noqa: E402,I001

from __future__ import annotations

import json
import subprocess
import sys
import hashlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MANIFEST, ASIMOV1_GENERATED_MJCF  # noqa: E402
from eliza_robot.curriculum.loader import load_curriculum  # noqa: E402
from eliza_robot.profiles.schema import load_profile  # noqa: E402
from eliza_robot.rl.alberta.agent import AlbertaContinualController, AlbertaControllerConfig  # noqa: E402
from eliza_robot.rl.alberta.features import FeatureConfig  # noqa: E402
from scripts import validate_asimov1_production_checkpoint as validator  # noqa: E402


TASKS = [
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
]


def _write_checkpoint(path: Path, *, steps: int = 2_000_000, tiny: bool = False) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "training_job.json").write_text(
        json.dumps(
            {
                "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
                "mjcf_xml_sha256": hashlib.sha256(ASIMOV1_GENERATED_MJCF.read_bytes()).hexdigest(),
                "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
                "asset_manifest_sha256": hashlib.sha256(
                    ASIMOV1_GENERATED_MANIFEST.read_bytes()
                ).hexdigest(),
            }
        ),
        encoding="utf-8",
    )
    manifest = {
        "regime": "brax_ppo",
        "curriculum_version": 1,
        "pca_dim": 8,
        "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
        "mjcf_xml_sha256": hashlib.sha256(ASIMOV1_GENERATED_MJCF.read_bytes()).hexdigest(),
        "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
        "asset_manifest_sha256": hashlib.sha256(
            ASIMOV1_GENERATED_MANIFEST.read_bytes()
        ).hexdigest(),
        "active_tasks": TASKS,
        "obs_dim": 53,
        "proprio_dim": 45,
        "text_dim": 8,
        "critic_obs_dim": 62,
        "policy_obs_key": "state",
        "value_obs_key": "privileged_state",
        "action_dim": 12,
        "output_dim": 25,
        "profile_id": "asimov-1",
        "ckpt": "policy_brax.pkl",
        "observation_delay_steps": {"left_leg": 1, "right_leg": 2},
        "observation_delay_groups": {
            "left_leg": list(range(0, 6)),
            "right_leg": list(range(6, 12)),
        },
    }
    if tiny:
        manifest["tiny_training_validation"] = True
    (path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (path / "metrics.json").write_text(
        json.dumps([{"steps": steps, "reward": 1.25, "elapsed_s": 12.0}]),
        encoding="utf-8",
    )
    (path / "config.json").write_text(
        json.dumps(
            {
                "profile_id": "asimov-1",
                "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
                "mjcf_xml_sha256": hashlib.sha256(ASIMOV1_GENERATED_MJCF.read_bytes()).hexdigest(),
                "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
                "asset_manifest_sha256": hashlib.sha256(
                    ASIMOV1_GENERATED_MANIFEST.read_bytes()
                ).hexdigest(),
                "active_tasks": TASKS,
                "observation_delay_steps": {"left_leg": 1, "right_leg": 2},
                "ppo": {
                    "policy_obs_key": "state",
                    "value_obs_key": "privileged_state",
                },
            }
        ),
        encoding="utf-8",
    )
    policy_path = path / "policy_brax.pkl"
    policy_path.write_bytes(b"not-empty")
    (path / "inference_check.json").write_text(
        json.dumps(
            {
                "ok": True,
                "checkpoint": str(path.resolve()),
                "policy_artifact": str(policy_path.resolve()),
                "policy_artifact_sha256": hashlib.sha256(policy_path.read_bytes()).hexdigest(),
                "manifest": {
                    "profile_id": "asimov-1",
                    "regime": "brax_ppo",
                    "obs_dim": 53,
                    "proprio_dim": 45,
                    "text_dim": 8,
                    "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
                    "mjcf_xml_sha256": hashlib.sha256(
                        ASIMOV1_GENERATED_MJCF.read_bytes()
                    ).hexdigest(),
                    "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
                    "asset_manifest_sha256": hashlib.sha256(
                        ASIMOV1_GENERATED_MANIFEST.read_bytes()
                    ).hexdigest(),
                    "critic_obs_dim": 62,
                    "action_dim": 12,
                    "output_dim": 25,
                    "policy_obs_key": "state",
                    "value_obs_key": "privileged_state",
                    "active_tasks": TASKS,
                },
                "checks": {
                    "profile": True,
                    "proprio_dim": True,
                    "action_dim": True,
                    "output_dim": True,
                    "critic_obs_dim": True,
                    "policy_obs_key": True,
                    "policy_artifact": True,
                    "mjcf_xml": True,
                    "asset_manifest": True,
                    "value_obs_key": True,
                },
                "results": [{"text": "stand up", "first_action": [0.0] * 25}],
            }
        ),
        encoding="utf-8",
    )


def _write_asimov_alberta_checkpoint(path: Path, *, steps: int = 2_000_000) -> None:
    path.mkdir(parents=True, exist_ok=True)
    profile = load_profile("asimov-1")
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
    manifest = {
        "regime": "alberta_streaming",
        "phase_promotion_schema": "alberta-phase-promotion-v1",
        "curriculum_version": load_curriculum().version,
        "pca_dim": 32,
        "active_tasks": TASKS,
        "obs_dim": 77,
        "action_dim": 12,
        "output_dim": len(profile.kinematics.joints),
        "profile_id": "asimov-1",
        "profile_version": profile.version,
        "proprio_dim": 45,
        "text_dim": 32,
        "ckpt": "alberta_policy.npz",
        "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
        "mjcf_xml_sha256": hashlib.sha256(ASIMOV1_GENERATED_MJCF.read_bytes()).hexdigest(),
        "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
        "asset_manifest_sha256": hashlib.sha256(
            ASIMOV1_GENERATED_MANIFEST.read_bytes()
        ).hexdigest(),
        "requested_total_steps": steps,
        "steps_per_task": steps // len(TASKS),
        "total_steps": (steps // len(TASKS)) * len(TASKS),
        "episode_steps": 200,
        "eval_episodes": 3,
        "seed": 0,
        "domain_rand": True,
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
            for phase, task in enumerate(TASKS)
        ],
    }
    cumulative = 0
    phases = []
    steps_per_task = steps // len(TASKS)
    for phase, task in enumerate(TASKS):
        cumulative += steps_per_task
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
        "promoted_phase_count": len(TASKS),
        "requested_phase_count": len(TASKS),
        "failed_phase": None,
        "phases": phases,
    }
    (path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def test_production_checkpoint_validator_accepts_complete_artifact(tmp_path: Path) -> None:
    _write_checkpoint(tmp_path)

    report = validator.validate_asimov1_production_checkpoint(tmp_path, min_steps=1_000_000)

    assert report["ok"] is True
    assert all(report["checks"].values())
    assert report["max_metric_steps"] == 2_000_000


def test_production_checkpoint_validator_accepts_asimov_alberta_artifact(
    tmp_path: Path,
) -> None:
    _write_asimov_alberta_checkpoint(tmp_path)

    report = validator.validate_asimov1_production_checkpoint(
        tmp_path,
        min_steps=1_000_000,
        require_inference_check=True,
    )

    assert report["ok"] is True
    assert report["production_regime"] == "alberta_streaming"
    assert report["checks"]["regime"] is True
    assert report["checks"]["required_tasks"] is True
    assert report["checks"]["domain_rand"] is True
    assert report["checks"]["manifest_mjcf_asset_provenance"] is True
    assert report["checks"]["manifest_asset_manifest_provenance"] is True
    assert report["checks"]["inference_check"] is True
    assert report["max_metric_steps"] >= 1_000_000


def test_production_checkpoint_validator_rejects_asimov_alberta_stale_asset_provenance(
    tmp_path: Path,
) -> None:
    _write_asimov_alberta_checkpoint(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["mjcf_xml_sha256"] = "0" * 64
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    report = validator.validate_asimov1_production_checkpoint(
        tmp_path,
        min_steps=1_000_000,
        require_inference_check=True,
    )

    assert report["ok"] is False
    assert report["checks"]["manifest_mjcf_asset_provenance"] is False


def test_production_checkpoint_validator_rejects_asimov_alberta_validation_checkpoint(
    tmp_path: Path,
) -> None:
    _write_asimov_alberta_checkpoint(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["validation_checkpoint"] = True
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    report = validator.validate_asimov1_production_checkpoint(
        tmp_path,
        min_steps=1_000_000,
        require_inference_check=True,
    )

    assert report["ok"] is False
    assert report["checks"]["not_validation_checkpoint"] is False


def test_production_checkpoint_validator_rejects_tiny_or_undertrained_checkpoint(
    tmp_path: Path,
) -> None:
    _write_checkpoint(tmp_path, steps=8, tiny=True)

    report = validator.validate_asimov1_production_checkpoint(tmp_path, min_steps=1_000_000)

    assert report["ok"] is False
    assert report["checks"]["not_tiny_validation"] is False
    assert report["checks"]["metrics_steps"] is False


def test_production_checkpoint_validator_requires_observation_delay_contract(
    tmp_path: Path,
) -> None:
    _write_checkpoint(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["observation_delay_steps"] = {"left_leg": 0, "right_leg": 0}
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    report = validator.validate_asimov1_production_checkpoint(tmp_path, min_steps=1_000_000)

    assert report["ok"] is False
    assert report["checks"]["observation_delay_steps"] is False


def test_production_checkpoint_validator_requires_asymmetric_critic_contract(
    tmp_path: Path,
) -> None:
    _write_checkpoint(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["value_obs_key"] = "state"
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    report = validator.validate_asimov1_production_checkpoint(tmp_path, min_steps=1_000_000)

    assert report["ok"] is False
    assert report["checks"]["asymmetric_actor_critic"] is False


def test_production_checkpoint_validator_requires_bound_model_assets(
    tmp_path: Path,
) -> None:
    _write_checkpoint(tmp_path)
    job = json.loads((tmp_path / "training_job.json").read_text(encoding="utf-8"))
    job["mjcf_xml_sha256"] = "0" * 64
    (tmp_path / "training_job.json").write_text(json.dumps(job), encoding="utf-8")

    report = validator.validate_asimov1_production_checkpoint(tmp_path, min_steps=1_000_000)

    assert report["ok"] is False
    assert report["checks"]["training_job"] is True
    assert report["checks"]["mjcf_current_asset"] is True
    assert report["checks"]["mjcf_asset_hash"] is False


def test_production_checkpoint_validator_requires_manifest_model_asset_provenance(
    tmp_path: Path,
) -> None:
    _write_checkpoint(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["asset_manifest_sha256"] = "0" * 64
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    report = validator.validate_asimov1_production_checkpoint(tmp_path, min_steps=1_000_000)

    assert report["ok"] is False
    assert report["checks"]["asset_manifest_hash"] is True
    assert report["checks"]["manifest_asset_manifest_provenance"] is False


def test_production_checkpoint_validator_can_require_inference_check_report(
    tmp_path: Path,
) -> None:
    _write_checkpoint(tmp_path)
    (tmp_path / "inference_check.json").unlink()

    missing = validator.validate_asimov1_production_checkpoint(
        tmp_path,
        min_steps=1_000_000,
        require_inference_check=True,
    )
    assert missing["ok"] is False
    assert missing["checks"]["inference_check"] is False

    _write_checkpoint(tmp_path)
    present = validator.validate_asimov1_production_checkpoint(
        tmp_path,
        min_steps=1_000_000,
        require_inference_check=True,
    )
    assert present["ok"] is True
    assert present["checks"]["inference_check"] is True


def test_production_checkpoint_validator_rejects_stale_inference_check_report(
    tmp_path: Path,
) -> None:
    _write_checkpoint(tmp_path)
    report = json.loads((tmp_path / "inference_check.json").read_text(encoding="utf-8"))
    report["manifest"]["critic_obs_dim"] = 999
    (tmp_path / "inference_check.json").write_text(json.dumps(report), encoding="utf-8")

    validation = validator.validate_asimov1_production_checkpoint(
        tmp_path,
        min_steps=1_000_000,
        require_inference_check=True,
    )

    assert validation["ok"] is False
    assert validation["checks"]["inference_check"] is False


def test_production_checkpoint_validator_rejects_stale_policy_hash(
    tmp_path: Path,
) -> None:
    _write_checkpoint(tmp_path)
    (tmp_path / "policy_brax.pkl").write_bytes(b"changed-policy")

    validation = validator.validate_asimov1_production_checkpoint(
        tmp_path,
        min_steps=1_000_000,
        require_inference_check=True,
    )

    assert validation["ok"] is False
    assert validation["checks"]["inference_check"] is False


def test_production_checkpoint_validator_rejects_stale_inference_model_hash(
    tmp_path: Path,
) -> None:
    _write_checkpoint(tmp_path)
    report = json.loads((tmp_path / "inference_check.json").read_text(encoding="utf-8"))
    report["manifest"]["mjcf_xml_sha256"] = "0" * 64
    (tmp_path / "inference_check.json").write_text(json.dumps(report), encoding="utf-8")

    validation = validator.validate_asimov1_production_checkpoint(
        tmp_path,
        min_steps=1_000_000,
        require_inference_check=True,
    )

    assert validation["ok"] is False
    assert validation["checks"]["inference_check"] is False


def test_production_checkpoint_validator_cli(tmp_path: Path) -> None:
    _write_checkpoint(tmp_path, steps=128)

    proc = subprocess.run(
        [
            sys.executable,
            "packages/robot/scripts/validate_asimov1_production_checkpoint.py",
            str(tmp_path),
            "--min-steps",
            "128",
        ],
        cwd=Path(__file__).resolve().parents[4],
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    assert json.loads(proc.stdout)["ok"] is True
