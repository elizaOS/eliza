from __future__ import annotations

import hashlib
import inspect
import json
from pathlib import Path

import numpy as np
import pytest

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MANIFEST, ASIMOV1_GENERATED_MJCF
from eliza_robot.bridge.backends.mock_backend import MockBackend
from eliza_robot.curriculum.loader import load_curriculum
from eliza_robot.profiles.schema import load_profile
from eliza_robot.rl.alberta.agent import AlbertaContinualController, AlbertaControllerConfig
from eliza_robot.rl.alberta.features import FeatureConfig
from eliza_robot.rl.alberta.train_robot import steps_per_task_from_total, train_robot
from eliza_robot.rl.text_conditioned.inference_loop import (
    InferenceLoopConfig,
    _proprio_from_telemetry,
    run_inference,
)
from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy
from scripts.validate_asimov1_policy_loop import write_validation_checkpoint


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _raise_missing_encoder(*_args: object, **_kwargs: object) -> None:
    raise ModuleNotFoundError("sentence_transformers")


def _write_tiny_alberta_checkpoint(
    path: Path,
    *,
    profile_id: str,
    output_dim: int,
) -> None:
    feature_cfg = FeatureConfig(
        mode="sparse_gated",
        embed_dim=4,
        n_prototypes=8,
        gate_hard=True,
        proprio_random_dim=8,
        random_dim=16,
        seed=0,
    )
    controller_cfg = AlbertaControllerConfig(
        obs_dim=49,
        action_dim=2,
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
        "curriculum_version": 1,
        "pca_dim": 4,
        "active_tasks": ["stand_up", "walk_forward"],
        "obs_dim": 49,
        "proprio_dim": 45,
        "text_dim": 4,
        "action_dim": 2,
        "output_dim": output_dim,
        "profile_id": profile_id,
        "ckpt": "alberta_policy.npz",
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
    }
    (path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def test_alberta_streaming_policy_adapter_pads_to_full_robot_output(tmp_path: Path) -> None:
    _write_tiny_alberta_checkpoint(tmp_path, profile_id="test-robot", output_dim=5)

    policy = TextConditionedPolicy(tmp_path)
    action, task = policy.act("stand_up", np.zeros(45, dtype=np.float32))

    assert task == "stand_up"
    assert action.shape == (5,)
    assert np.isfinite(action).all()
    assert np.allclose(action[2:], 0.0)


def test_alberta_policy_adapter_fallback_matches_free_form_task_text(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_tiny_alberta_checkpoint(tmp_path, profile_id="test-robot", output_dim=5)
    monkeypatch.setattr(
        "eliza_robot.rl.text_conditioned.policy.project_text",
        _raise_missing_encoder,
    )

    policy = TextConditionedPolicy(tmp_path)
    task, _, sim = policy.resolve_task("please walk forward")
    action, acted_task = policy.act("walk-forward", np.zeros(45, dtype=np.float32))

    assert task == "walk_forward"
    assert sim == 1.0
    assert acted_task == "walk_forward"
    assert action.shape == (5,)


def test_asimov_policy_loop_validation_checkpoint_is_alberta_format(
    tmp_path: Path,
) -> None:
    write_validation_checkpoint(tmp_path, seed=0)
    manifest = json.loads((tmp_path / "manifest.json").read_text())

    assert manifest["regime"] == "alberta_streaming"
    assert manifest["profile_id"] == "asimov-1"
    assert manifest["ckpt"] == "alberta_policy.npz"
    assert manifest["output_dim"] == 25
    assert manifest["output_dim"] >= manifest["action_dim"]
    assert manifest["validation_checkpoint"] is True
    assert manifest["mjcf_xml"] == str(ASIMOV1_GENERATED_MJCF)
    assert manifest["asset_manifest"] == str(ASIMOV1_GENERATED_MANIFEST)
    assert manifest["mjcf_xml_sha256"] == _sha256(ASIMOV1_GENERATED_MJCF)
    assert manifest["asset_manifest_sha256"] == _sha256(ASIMOV1_GENERATED_MANIFEST)

    policy = TextConditionedPolicy(tmp_path)
    action, task = policy.act("walk_forward", np.zeros(45, dtype=np.float32))

    assert task == "walk_forward"
    assert action.shape == (25,)
    assert np.isfinite(action).all()


def test_train_robot_manifest_is_reproducible_and_bridge_loadable(
    tmp_path: Path,
) -> None:
    pytest.importorskip("mujoco")
    profile_id = "hiwonder-ainex"
    profile = load_profile(profile_id)
    curriculum = load_curriculum()

    manifest = train_robot(
        profile_id,
        ["stand_up"],
        1,
        tmp_path,
        pca_dim=32,
        episode_steps=4,
        eval_episodes=1,
        seed=123,
        domain_rand=False,
    )

    assert manifest["regime"] == "alberta_streaming"
    assert manifest["profile_id"] == profile_id
    assert manifest["profile_version"] == profile.version
    assert manifest["curriculum_version"] == curriculum.version
    assert manifest["steps_per_task"] == 1
    assert manifest["requested_total_steps"] == 1
    assert manifest["total_steps"] == 1
    assert manifest["episode_steps"] == 4
    assert manifest["eval_episodes"] == 1
    assert manifest["seed"] == 123
    assert manifest["domain_rand"] is False
    assert manifest["controller"]["actor_step_size"] == 5e-3
    assert manifest["controller"]["critic_step_size"] == 1e-2
    assert manifest["controller"]["actor_lamda"] == AlbertaControllerConfig.actor_lamda
    assert manifest["controller"]["critic_lamda"] == AlbertaControllerConfig.critic_lamda
    assert manifest["controller"]["log_sigma_min"] == AlbertaControllerConfig.log_sigma_min
    assert manifest["controller"]["log_sigma_max"] == AlbertaControllerConfig.log_sigma_max
    assert manifest["controller"]["normalizer_decay"] == AlbertaControllerConfig.normalizer_decay
    assert manifest["controller"]["decouple_global_bias"] is True
    assert manifest["output_dim"] == len(profile.kinematics.joints)
    assert manifest["output_dim"] >= manifest["action_dim"]
    assert (tmp_path / "alberta_policy.npz").is_file()
    assert (tmp_path / "manifest.json").is_file()

    policy = TextConditionedPolicy(tmp_path)
    action, task = policy.act("stand_up", np.zeros(manifest["proprio_dim"], dtype=np.float32))

    assert task == "stand_up"
    assert action.shape == (manifest["output_dim"],)
    assert np.isfinite(action).all()


def test_train_robot_asimov_manifest_binds_model_asset_provenance(
    tmp_path: Path,
) -> None:
    pytest.importorskip("mujoco")

    manifest = train_robot(
        "asimov-1",
        ["stand_up"],
        1,
        tmp_path,
        pca_dim=32,
        episode_steps=4,
        eval_episodes=1,
        seed=0,
        domain_rand=True,
    )

    assert manifest["profile_id"] == "asimov-1"
    assert manifest["mjcf_xml"] == str(ASIMOV1_GENERATED_MJCF)
    assert manifest["asset_manifest"] == str(ASIMOV1_GENERATED_MANIFEST)
    assert manifest["mjcf_xml_sha256"] == _sha256(ASIMOV1_GENERATED_MJCF)
    assert manifest["asset_manifest_sha256"] == _sha256(ASIMOV1_GENERATED_MANIFEST)


def test_steps_per_task_from_total_ceil_splits_multi_task_budget() -> None:
    assert steps_per_task_from_total(150_000_000, 7) == 21_428_572
    assert steps_per_task_from_total(30_000, 2) == 15_000
    assert steps_per_task_from_total(1, 7) == 1


def test_steps_per_task_from_total_rejects_invalid_budget() -> None:
    with pytest.raises(ValueError, match="total_steps"):
        steps_per_task_from_total(0, 1)
    with pytest.raises(ValueError, match="task_count"):
        steps_per_task_from_total(10, 0)


def test_train_robot_enables_domain_randomization_by_default() -> None:
    signature = inspect.signature(train_robot)
    assert signature.parameters["domain_rand"].default is True


def test_profile_proprio_uses_profile_leg_joint_order() -> None:
    profile = load_profile("unitree-h1")
    leg_joints = [j.name for j in profile.kinematics.joints if j.group == "LEG"]
    telemetry = {
        "imu_roll": 0.1,
        "imu_pitch": -0.2,
        "imu_yaw_rate": 0.3,
        "joint_positions": {name: float(i + 1) for i, name in enumerate(leg_joints)},
        "joint_velocities": {name: float((i + 1) * 10) for i, name in enumerate(leg_joints)},
    }

    proprio = _proprio_from_telemetry(telemetry, profile, proprio_dim=39)

    assert proprio[:6].tolist() == pytest.approx([0.1, -0.2, 0.3, 0.0, 0.0, 1.0])
    assert proprio[6:9].tolist() == pytest.approx([0.0, 0.0, 0.0])
    assert proprio[9 : 9 + len(leg_joints)].tolist() == pytest.approx(
        [float(i + 1) for i in range(len(leg_joints))]
    )
    qvel_start = 9 + len(leg_joints)
    assert proprio[qvel_start : qvel_start + len(leg_joints)].tolist() == pytest.approx(
        [float((i + 1) * 10) for i in range(len(leg_joints))]
    )


@pytest.mark.asyncio
async def test_inference_loop_runs_matching_profile_checkpoint(tmp_path: Path) -> None:
    _write_tiny_alberta_checkpoint(
        tmp_path,
        profile_id="hiwonder-ainex",
        output_dim=len(load_profile("hiwonder-ainex").kinematics.joints),
    )
    backend = MockBackend()
    await backend.connect()
    try:
        result = await run_inference(
            backend,
            tmp_path,
            "walk_forward",
            config=InferenceLoopConfig(
                hz=50.0,
                max_steps=1,
                profile_id="hiwonder-ainex",
            ),
        )
        events = await backend.poll_events()
    finally:
        await backend.shutdown()

    telemetry = next(e.data for e in events if e.event == "telemetry.basic")
    assert result["steps_completed"] == 1
    assert result["matched_task_id"] == "walk_forward"
    assert len(telemetry["joint_positions"]) == 24


@pytest.mark.asyncio
async def test_inference_loop_rejects_checkpoint_profile_mismatch(
    tmp_path: Path,
) -> None:
    _write_tiny_alberta_checkpoint(
        tmp_path,
        profile_id="hiwonder-ainex",
        output_dim=len(load_profile("hiwonder-ainex").kinematics.joints),
    )
    backend = MockBackend()
    await backend.connect()
    try:
        with pytest.raises(ValueError, match="checkpoint profile mismatch"):
            await run_inference(
                backend,
                tmp_path,
                "walk_forward",
                config=InferenceLoopConfig(
                    hz=50.0,
                    max_steps=1,
                    profile_id="unitree-g1",
                ),
            )
    finally:
        await backend.shutdown()
