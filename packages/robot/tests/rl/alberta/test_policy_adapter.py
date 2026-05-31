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
from eliza_robot.rl.alberta.cbp_agent import (
    AlbertaCBPController,
    CBPControllerConfig,
    RetentionConfig,
)
from eliza_robot.rl.alberta.checkpoint import save_state_npz
from eliza_robot.rl.alberta.features import FeatureConfig
from eliza_robot.rl.alberta.train_robot import (
    DEFAULT_HIWONDER_SINE_FEEDBACK,
    _action_scale_gate_passed,
    _build_action_scale_schedule,
    _build_locomotion_prior_residual_schedule,
    _initial_action_scale_for_training,
    _physical_checks,
    _promotion_blocker,
    _promotion_passed,
    _resolve_locomotion_prior_feedback,
    _telemetry_sample_from_info,
    steps_per_task_from_total,
    train_robot,
)
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


def _write_tiny_cbp_alberta_checkpoint(
    path: Path,
    *,
    profile_id: str,
    output_dim: int,
    hidden_sizes: tuple[int, ...] = (8, 4),
) -> None:
    controller_cfg = CBPControllerConfig(
        obs_dim=49,
        action_dim=2,
        hidden_sizes=hidden_sizes,
        gamma=0.5,
        actor_step_size=1e-3,
        critic_step_size=2e-3,
        log_sigma_init=-1.0,
        normalize=False,
        obgd_kappa=2.0,
        retention=RetentionConfig(
            mode="multihead",
            n_slots=4,
            embed_dim=4,
            trunk_step_scale=0.5,
            proto_seed=123,
        ),
        seed=0,
    )
    controller = AlbertaCBPController(controller_cfg)
    save_state_npz(path / "alberta_policy.npz", controller.state_dict())
    manifest = {
        "regime": "alberta_streaming",
        "controller_type": "cbp",
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
            "type": "cbp_stream_ac_v1",
            "obs_dim": controller_cfg.obs_dim,
            "action_dim": controller_cfg.action_dim,
            "hidden_sizes": list(controller_cfg.hidden_sizes),
            "gamma": controller_cfg.gamma,
            "actor_step_size": controller_cfg.actor_step_size,
            "critic_step_size": controller_cfg.critic_step_size,
            "actor_lamda": controller_cfg.actor_lamda,
            "critic_lamda": controller_cfg.critic_lamda,
            "log_sigma_init": controller_cfg.log_sigma_init,
            "log_sigma_min": controller_cfg.log_sigma_min,
            "log_sigma_max": controller_cfg.log_sigma_max,
            "learn_log_sigma": controller_cfg.learn_log_sigma,
            "action_low": controller_cfg.action_low,
            "action_high": controller_cfg.action_high,
            "obgd_kappa": controller_cfg.obgd_kappa,
            "sparsity": controller_cfg.sparsity,
            "leaky_relu_slope": controller_cfg.leaky_relu_slope,
            "use_layer_norm": controller_cfg.use_layer_norm,
            "normalize": controller_cfg.normalize,
            "normalizer_decay": controller_cfg.normalizer_decay,
            "seed": controller_cfg.seed,
            "cbp": {
                "enabled": controller_cfg.cbp.enabled,
                "decay_rate": controller_cfg.cbp.decay_rate,
                "replacement_rate": controller_cfg.cbp.replacement_rate,
                "maturity_threshold": controller_cfg.cbp.maturity_threshold,
            },
            "retention": {
                "mode": controller_cfg.retention.mode,
                "n_slots": controller_cfg.retention.n_slots,
                "embed_dim": controller_cfg.retention.embed_dim,
                "trunk_step_scale": controller_cfg.retention.trunk_step_scale,
                "trunk_freeze_after": controller_cfg.retention.trunk_freeze_after,
                "proto_seed": controller_cfg.retention.proto_seed,
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


def test_alberta_cbp_policy_adapter_loads_flat_npz_and_pads_output(
    tmp_path: Path,
) -> None:
    _write_tiny_cbp_alberta_checkpoint(
        tmp_path,
        profile_id="test-robot",
        output_dim=5,
        hidden_sizes=(8, 4),
    )

    policy = TextConditionedPolicy(tmp_path)
    action, task = policy.act("stand_up", np.zeros(45, dtype=np.float32))

    assert task == "stand_up"
    assert action.shape == (5,)
    assert np.isfinite(action).all()
    assert np.allclose(action[2:], 0.0)


def test_strict_policy_manifest_rejects_missing_production_fields(
    tmp_path: Path,
) -> None:
    _write_tiny_alberta_checkpoint(tmp_path, profile_id="test-robot", output_dim=5)
    manifest_path = tmp_path / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    del manifest["profile_id"]
    del manifest["output_dim"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    policy = TextConditionedPolicy(tmp_path)
    assert policy.manifest.profile_id == "hiwonder-ainex"

    with pytest.raises(ValueError, match="profile_id, output_dim"):
        TextConditionedPolicy(tmp_path, strict_manifest=True)


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


def test_train_robot_goal_sample_uses_tracked_motion_torso_height_and_carries_contacts() -> None:
    sample = _telemetry_sample_from_info(
        1.25,
        {
            "root_x": 0.0,
            "root_y": 0.0,
            "torso_z": 0.2,
            "tracked_x": 0.31,
            "tracked_y": 0.02,
            "tracked_z": 0.27,
            "root_yaw": 0.1,
            "imu_roll": 0.01,
            "imu_pitch": 0.02,
            "left_foot_contact": True,
            "right_foot_contact": False,
            "stand_height_m": 0.25,
        },
    )

    assert sample.torso_x_m == 0.0
    assert sample.torso_y_m == 0.0
    assert sample.torso_z_m == 0.2
    assert sample.extra["left_foot_contact"] is True
    assert sample.extra["right_foot_contact"] is False
    assert sample.extra["root_x_m"] == 0.0
    assert sample.extra["tracked_x_m"] == 0.31
    assert sample.extra["tracked_y_m"] == 0.02
    assert sample.extra["tracked_z_m"] == 0.27


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
    assert manifest["action_scale"] == 0.3
    assert manifest["action_scale_schedule"]["schema"] == "alberta-action-scale-schedule-v1"
    assert manifest["action_scale_schedule"]["initial_scale"] == 0.15
    assert manifest["action_scale_schedule"]["target_scale"] == 0.3
    assert manifest["action_scale_schedule"]["final_scale"] >= 0.15
    assert (
        manifest["locomotion_prior_residual_scale_schedule"]["schema"]
        == "alberta-locomotion-prior-residual-schedule-v1"
    )
    assert manifest["history"][0]["action_scale_start"] == 0.15
    assert manifest["phase_promotion"]["phases"][0]["action_scale_target"] == 0.3
    assert manifest["eval_episodes"] == 1
    assert manifest["seed"] == 123
    assert manifest["domain_rand"] is False
    assert manifest["controller_type"] == "linear"
    assert manifest["controller"]["type"] == "linear_stream_ac_v1"
    assert manifest["controller"]["gamma"] == 0.97
    assert manifest["controller"]["normalize"] is True
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


def test_train_robot_cbp_manifest_is_bridge_loadable(
    tmp_path: Path,
) -> None:
    pytest.importorskip("mujoco")
    profile_id = "hiwonder-ainex"

    manifest = train_robot(
        profile_id,
        ["stand_up"],
        1,
        tmp_path,
        controller_type="cbp",
        pca_dim=32,
        episode_steps=4,
        eval_episodes=1,
        seed=123,
        domain_rand=False,
        cbp_hidden_sizes=(8,),
        cbp_retention_mode="multihead",
        cbp_retention_slots=4,
    )

    assert manifest["regime"] == "alberta_streaming"
    assert manifest["controller_type"] == "cbp"
    assert manifest["controller"]["type"] == "cbp_stream_ac_v1"
    assert manifest["controller"]["hidden_sizes"] == [8]
    assert manifest["controller"]["cbp"]["enabled"] is True
    assert manifest["controller"]["retention"]["mode"] == "multihead"
    assert manifest["controller"]["retention"]["embed_dim"] == 32
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


def test_phase_promotion_requires_physical_success() -> None:
    assert _promotion_passed(
        {"success_rate": 1.0, "physical_success": True},
        1.0,
    )
    assert _promotion_blocker(
        {"success_rate": 1.0, "physical_success": True},
        1.0,
    ) is None

    assert not _promotion_passed(
        {"success_rate": 1.0, "physical_success": False},
        1.0,
    )
    assert (
        _promotion_blocker({"success_rate": 1.0, "physical_success": False}, 1.0)
        == "phase_physical_success_missing"
    )

    assert not _promotion_passed(
        {"success_rate": 0.5, "physical_success": True},
        1.0,
    )
    assert (
        _promotion_blocker({"success_rate": 0.5, "physical_success": True}, 1.0)
        == "phase_success_rate_below_threshold"
    )


def test_action_scale_schedule_starts_stable_and_requires_no_fall_physical_gate() -> None:
    schedule = _build_action_scale_schedule(
        target_scale=0.3,
        initial_scale=None,
        increment=0.05,
        min_success_rate=1.0,
    )

    assert schedule["schema"] == "alberta-action-scale-schedule-v1"
    assert schedule["enabled"] is True
    assert schedule["initial_scale"] == 0.15
    assert schedule["target_scale"] == 0.3
    assert schedule["criteria"] == {
        "failure_rate_lte": 0.0,
        "physical_success_or_stable_partial_progress": True,
        "success_rate_gte": 1.0,
    }
    assert _action_scale_gate_passed(
        {"success_rate": 1.0, "failure_rate": 0.0, "physical_success": True},
        task_id="walk_forward",
        min_success_rate=1.0,
    )
    assert not _action_scale_gate_passed(
        {"success_rate": 1.0, "failure_rate": 0.5, "physical_success": True},
        task_id="walk_forward",
        min_success_rate=1.0,
    )


def test_action_scale_schedule_can_require_full_physical_success_only() -> None:
    schedule = _build_action_scale_schedule(
        target_scale=0.3,
        initial_scale=0.28,
        increment=0.05,
        min_success_rate=1.0,
        allow_stable_partial_progress=False,
    )

    assert schedule["mode"] == "full_physical_success_gate_ramp"
    assert schedule["criteria"] == {
        "failure_rate_lte": 0.0,
        "success_rate_gte": 1.0,
        "physical_success": True,
    }


def test_locomotion_prior_training_starts_at_validated_prior_scale() -> None:
    assert (
        _initial_action_scale_for_training(
            target_scale=0.3,
            requested_initial_scale=None,
            locomotion_action_prior="hiwonder_sine",
        )
        == 0.28
    )
    assert (
        _initial_action_scale_for_training(
            target_scale=0.2,
            requested_initial_scale=None,
            locomotion_action_prior="hiwonder_sine",
        )
        == 0.2
    )
    assert (
        _initial_action_scale_for_training(
            target_scale=0.3,
            requested_initial_scale=None,
            locomotion_action_prior="none",
        )
        is None
    )


def test_locomotion_prior_residual_schedule_starts_at_zero_for_prior() -> None:
    schedule = _build_locomotion_prior_residual_schedule(
        target_scale=0.25,
        initial_scale=None,
        increment=0.05,
        locomotion_action_prior="hiwonder_sine",
    )

    assert schedule["schema"] == "alberta-locomotion-prior-residual-schedule-v1"
    assert schedule["enabled"] is True
    assert schedule["initial_scale"] == 0.0
    assert schedule["target_scale"] == 0.25
    assert schedule["increment"] == 0.05


def test_physical_checks_use_episode_max_yaw_for_walk_forward() -> None:
    checks = _physical_checks(
        "walk_forward",
        {
            "tracked_delta_x_m": {"min": 0.31, "max": 0.31, "mean": 0.31, "final": 0.31},
            "tracked_delta_y_m": {"min": 0.0, "max": 0.0, "mean": 0.0, "final": 0.0},
            "delta_yaw_rad": {"min": 0.0, "max": 0.1, "mean": 0.0, "final": 0.1},
            "max_abs_delta_yaw_rad": {
                "min": 0.0,
                "max": 0.43,
                "mean": 0.2,
                "final": 0.43,
            },
            "tracked_z_m": {"min": 0.2, "max": 0.2, "mean": 0.2, "final": 0.2},
        },
    )

    assert checks["tracked_delta_x_forward"] is True
    assert checks["yaw_drift_bound"] is False


def test_physical_checks_require_clearance_slip_and_no_self_collision_for_walk() -> None:
    checks = _physical_checks(
        "walk_forward",
        {
            "tracked_delta_x_m": {"min": 0.0, "max": 0.35, "mean": 0.35, "final": 0.35},
            "tracked_delta_y_m": {"min": 0.0, "max": 0.0, "mean": 0.0, "final": 0.0},
            "delta_yaw_rad": {"min": 0.0, "max": 0.0, "mean": 0.0, "final": 0.0},
            "max_abs_delta_yaw_rad": {"min": 0.0, "max": 0.0, "mean": 0.0, "final": 0.0},
            "tracked_z_m": {"min": 0.3, "max": 0.3, "mean": 0.3, "final": 0.3},
            "max_swing_foot_clearance_m": {
                "min": 0.0,
                "max": 0.012,
                "mean": 0.012,
                "final": 0.012,
            },
            "max_foot_slip_m_s": {"min": 0.0, "max": 0.5, "mean": 0.5, "final": 0.5},
            "max_self_collision_count": {"min": 0.0, "max": 1.0, "mean": 1.0, "final": 1.0},
        },
    )

    assert checks["tracked_delta_x_forward"] is True
    assert checks["min_swing_foot_clearance_m"] is False
    assert checks["max_foot_slip_m_s"] is False
    assert checks["max_self_collision_count"] is False
    assert not _action_scale_gate_passed(
        {
            "success_rate": 0.0,
            "failure_rate": 0.0,
            "physical_success": False,
            "physical_checks": {
                "no_fall": True,
                "tracked_lateral_drift_bound": True,
                "yaw_drift_bound": True,
            },
            "movement_summary": {
                "tracked_delta_x_m": {
                    "min": 0.0,
                    "max": 0.0,
                    "mean": 0.0,
                    "final": 0.0,
                },
            },
        },
        task_id="walk_forward",
        min_success_rate=1.0,
    )


def test_hiwonder_sine_training_defaults_to_stabilizing_feedback() -> None:
    assert _resolve_locomotion_prior_feedback(
        locomotion_action_prior="hiwonder_sine",
        pitch=None,
        roll=None,
        yaw=None,
    ) == (
        DEFAULT_HIWONDER_SINE_FEEDBACK["pitch"],
        DEFAULT_HIWONDER_SINE_FEEDBACK["roll"],
        DEFAULT_HIWONDER_SINE_FEEDBACK["yaw"],
    )
    assert _resolve_locomotion_prior_feedback(
        locomotion_action_prior="hiwonder_sine",
        pitch=0.0,
        roll=0.0,
        yaw=0.0,
    ) == (0.0, 0.0, 0.0)
    assert _resolve_locomotion_prior_feedback(
        locomotion_action_prior="none",
        pitch=None,
        roll=None,
        yaw=None,
    ) == (0.0, 0.0, 0.0)


@pytest.mark.parametrize(
    ("task_id", "series_key", "check_key", "min_value", "max_value"),
    (
        ("walk_forward", "tracked_delta_x_m", "tracked_delta_x_forward", 0.0, 0.35),
        ("walk_backward", "tracked_delta_x_m", "tracked_delta_x_backward", -0.25, 0.0),
        ("sidestep_left", "tracked_delta_y_m", "tracked_delta_y_left", 0.0, 0.25),
        ("sidestep_right", "tracked_delta_y_m", "tracked_delta_y_right", -0.25, 0.0),
        ("turn_left", "delta_yaw_rad", "delta_yaw_left", 0.0, 0.75),
        ("turn_right", "delta_yaw_rad", "delta_yaw_right", -0.75, 0.0),
    ),
)
def test_physical_checks_use_signed_motion_extrema(
    task_id: str,
    series_key: str,
    check_key: str,
    min_value: float,
    max_value: float,
) -> None:
    summary = {
        "tracked_delta_x_m": {"min": 0.0, "max": 0.0, "mean": 0.0, "final": 0.0},
        "tracked_delta_y_m": {"min": 0.0, "max": 0.0, "mean": 0.0, "final": 0.0},
        "delta_yaw_rad": {"min": 0.0, "max": 0.0, "mean": 0.0, "final": 0.0},
        "max_abs_delta_yaw_rad": {"min": 0.0, "max": 0.0, "mean": 0.0, "final": 0.0},
        "tracked_z_m": {"min": 0.3, "max": 0.3, "mean": 0.3, "final": 0.3},
        "tracked_translation_drift_m": {"min": 0.0, "max": 0.0, "mean": 0.0, "final": 0.0},
    }
    summary[series_key] = {
        "min": min_value,
        "max": max_value,
        "mean": 0.0,
        "final": 0.0,
    }

    assert _physical_checks(task_id, summary)[check_key] is True


@pytest.mark.parametrize(
    ("task_id", "series_key", "min_value", "max_value"),
    (
        ("walk_forward", "tracked_delta_x_m", 0.0, 0.08),
        ("walk_backward", "tracked_delta_x_m", -0.08, 0.0),
        ("sidestep_left", "tracked_delta_y_m", 0.0, 0.08),
        ("sidestep_right", "tracked_delta_y_m", -0.08, 0.0),
    ),
)
def test_action_scale_partial_progress_uses_signed_motion_extrema(
    task_id: str,
    series_key: str,
    min_value: float,
    max_value: float,
) -> None:
    drift_key = (
        "tracked_lateral_drift_bound"
        if task_id in {"walk_forward", "walk_backward"}
        else "tracked_forward_drift_bound"
    )

    assert _action_scale_gate_passed(
        {
            "success_rate": 0.0,
            "failure_rate": 0.0,
            "physical_success": False,
            "physical_checks": {
                "no_fall": True,
                "min_alternating_foot_contacts": True,
                drift_key: True,
                "yaw_drift_bound": True,
            },
            "movement_summary": {
                series_key: {
                    "min": min_value,
                    "max": max_value,
                    "mean": 0.0,
                    "final": 0.0,
                },
            },
        },
        task_id=task_id,
        min_success_rate=1.0,
    )
    assert _action_scale_gate_passed(
        {
            "success_rate": 0.0,
            "failure_rate": 0.0,
            "physical_success": False,
            "physical_checks": {
                "no_fall": True,
                "min_alternating_foot_contacts": True,
                "tracked_lateral_drift_bound": True,
                "yaw_drift_bound": True,
            },
            "movement_summary": {
                "tracked_delta_x_m": {
                    "min": 0.08,
                    "max": 0.08,
                    "mean": 0.08,
                    "final": 0.08,
                },
            },
        },
        task_id="walk_forward",
        min_success_rate=1.0,
    )
    assert not _action_scale_gate_passed(
        {
            "success_rate": 0.0,
            "failure_rate": 0.0,
            "physical_success": False,
            "physical_checks": {
                "no_fall": True,
                "tracked_lateral_drift_bound": True,
                "yaw_drift_bound": True,
            },
            "movement_summary": {
                "tracked_delta_x_m": {
                    "min": 0.08,
                    "max": 0.08,
                    "mean": 0.08,
                    "final": 0.08,
                },
            },
        },
        task_id="walk_forward",
        min_success_rate=1.0,
    )
    assert not _action_scale_gate_passed(
        {
            "success_rate": 0.0,
            "failure_rate": 0.0,
            "physical_success": False,
            "physical_checks": {
                "no_fall": True,
                "min_alternating_foot_contacts": False,
                "tracked_lateral_drift_bound": True,
                "yaw_drift_bound": True,
            },
            "movement_summary": {
                "tracked_delta_x_m": {
                    "min": 0.08,
                    "max": 0.08,
                    "mean": 0.08,
                    "final": 0.08,
                },
            },
        },
        task_id="walk_forward",
        min_success_rate=1.0,
    )
    assert not _action_scale_gate_passed(
        {
            "success_rate": 0.0,
            "failure_rate": 0.0,
            "physical_success": False,
            "physical_checks": {
                "no_fall": True,
                "tracked_lateral_drift_bound": True,
                "yaw_drift_bound": True,
            },
            "movement_summary": {
                "tracked_delta_x_m": {
                    "min": 0.0,
                    "max": 0.08,
                    "mean": 0.04,
                    "final": 0.08,
                },
            },
        },
        task_id="walk_forward",
        min_success_rate=1.0,
    )
    assert not _action_scale_gate_passed(
        {
            "success_rate": 0.0,
            "failure_rate": 1.0,
            "physical_success": False,
            "physical_checks": {
                "no_fall": False,
                "tracked_lateral_drift_bound": True,
                "yaw_drift_bound": True,
            },
            "movement_summary": {
                "tracked_delta_x_m": {
                    "min": 0.0,
                    "max": 0.12,
                    "mean": 0.12,
                    "final": 0.12,
                },
            },
        },
        task_id="walk_forward",
        min_success_rate=1.0,
    )


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

    proprio = _proprio_from_telemetry(telemetry, profile, proprio_dim=50)

    assert proprio[:6].tolist() == pytest.approx([0.1, -0.2, 0.3, 0.0, 0.0, 1.0])
    assert proprio[6:20].tolist() == pytest.approx([0.0] * 14)
    qpos_start = 20
    assert proprio[qpos_start : qpos_start + len(leg_joints)].tolist() == pytest.approx(
        [float(i + 1) for i in range(len(leg_joints))]
    )
    qvel_start = qpos_start + len(leg_joints)
    assert proprio[qvel_start : qvel_start + len(leg_joints)].tolist() == pytest.approx(
        [float((i + 1) * 10) for i in range(len(leg_joints))]
    )
    # last_action block defaults to zero when not supplied
    last_start = qvel_start + len(leg_joints)
    assert proprio[last_start : last_start + len(leg_joints)].tolist() == pytest.approx(
        [0.0] * len(leg_joints)
    )


def test_profile_proprio_fills_last_action_when_supplied() -> None:
    profile = load_profile("unitree-h1")
    leg_joints = [j.name for j in profile.kinematics.joints if j.group == "LEG"]
    n = len(leg_joints)
    telemetry = {
        "joint_positions": {name: 0.0 for name in leg_joints},
        "joint_velocities": {name: 0.0 for name in leg_joints},
    }
    last_action = [0.25 * (i + 1) for i in range(n)]
    proprio = _proprio_from_telemetry(
        telemetry, profile, proprio_dim=20 + 3 * n, last_action=last_action
    )
    last_start = 20 + 2 * n
    assert proprio[last_start : last_start + n].tolist() == pytest.approx(last_action)


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
