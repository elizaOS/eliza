from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.constants import (  # noqa: E402
    ASIMOV1_GENERATED_MANIFEST,
    ASIMOV1_GENERATED_MJCF,
)
from scripts import validate_asimov1_real_agent_run as validator  # noqa: E402
from scripts.validate_asimov1_real_agent_run import validate_asimov1_real_agent_run  # noqa: E402

TASKS = [
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
]


def _sha256(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def _telemetry(sequence: int) -> dict:
    return {
        "mode": "STAND",
        "sequence": sequence,
        "timestamp_us": 100 + sequence,
        "fw_timestamp_us": 90 + sequence,
        "error_flags": 0,
        "fw_age_ms": 2,
        "joint_position_count": 25,
        "joint_velocity_count": 25,
        "imu_quat_count": 4,
        "imu_gyro_count": 3,
        "imu_gravity_count": 3,
    }


def _write_bound_inputs(checkpoint: Path, hardware: Path) -> None:
    checkpoint.mkdir(parents=True, exist_ok=True)
    (checkpoint / "training_job.json").write_text(
        json.dumps(
            {
                "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
                "mjcf_xml_sha256": _sha256(ASIMOV1_GENERATED_MJCF),
                "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
                "asset_manifest_sha256": _sha256(ASIMOV1_GENERATED_MANIFEST),
            }
        ),
        encoding="utf-8",
    )
    manifest = {
        "regime": "brax_ppo",
        "curriculum_version": 1,
        "pca_dim": 8,
        "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
        "mjcf_xml_sha256": _sha256(ASIMOV1_GENERATED_MJCF),
        "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
        "asset_manifest_sha256": _sha256(ASIMOV1_GENERATED_MANIFEST),
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
    (checkpoint / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (checkpoint / "metrics.json").write_text(
        json.dumps([{"steps": 150_000_000, "reward": 1.25}]),
        encoding="utf-8",
    )
    (checkpoint / "config.json").write_text(
        json.dumps(
            {
                "profile_id": "asimov-1",
                "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
                "mjcf_xml_sha256": _sha256(ASIMOV1_GENERATED_MJCF),
                "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
                "asset_manifest_sha256": _sha256(ASIMOV1_GENERATED_MANIFEST),
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
    policy = checkpoint / "policy_brax.pkl"
    policy.write_bytes(b"not-empty")
    (checkpoint / "inference_check.json").write_text(
        json.dumps(
            {
                "ok": True,
                "checkpoint": str(checkpoint.resolve()),
                "policy_artifact": str(policy.resolve()),
                "policy_artifact_sha256": _sha256(policy),
                "manifest": {
                    "profile_id": "asimov-1",
                    "regime": "brax_ppo",
                    "obs_dim": 53,
                    "proprio_dim": 45,
                    "text_dim": 8,
                    "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
                    "mjcf_xml_sha256": _sha256(ASIMOV1_GENERATED_MJCF),
                    "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
                    "asset_manifest_sha256": _sha256(ASIMOV1_GENERATED_MANIFEST),
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
    hardware.write_text(
        json.dumps(
            {
                "schema": "asimov-1-real-hardware-evidence-v1",
                "ok": True,
                "profile_id": "asimov-1",
                "evidence": "real_hardware_livekit_control",
                "checks": {
                    "strict_preflight": True,
                    "telemetry_probe_completed": True,
                    "telemetry_probe_ok": True,
                    "command_probe_completed": True,
                    "command_probe_ok": True,
                    "non_default_motion_requires_flags": True,
                },
                "stages": [
                    {
                        "name": "strict_preflight",
                        "ok": True,
                        "report": {
                            "ok": True,
                            "profile_id": "asimov-1",
                            "target": "asimov-real",
                            "backend": "asimov_remote",
                        },
                    },
                    {
                        "name": "telemetry_only",
                        "ok": True,
                        "report": {
                            "ok": True,
                            "profile_id": "asimov-1",
                            "probe": "telemetry_only",
                            "command_messages_published": 0,
                            "checks": {"connected": True, "telemetry_received": True},
                            "telemetry": _telemetry(1),
                        },
                    },
                    {
                        "name": "staged_real_command",
                        "ok": True,
                        "report": {
                            "ok": True,
                            "profile_id": "asimov-1",
                            "probe": "staged_real_command",
                            "commands_sent": ["mode:DAMP"],
                            "non_default_motion_stages_enabled": {
                                "stand": False,
                                "zero_velocity": False,
                            },
                            "checks": {
                                "connected": True,
                                "telemetry_before_commands": True,
                                "telemetry_after_commands": True,
                                "damp_command_sent": True,
                                "stand_requires_flag": True,
                                "zero_velocity_requires_flag": True,
                            },
                            "telemetry_before": _telemetry(2),
                            "telemetry_after": _telemetry(3),
                        },
                    },
                ],
            }
        ),
        encoding="utf-8",
    )


def _write_report(
    path: Path,
    *,
    checkpoint: Path,
    hardware: Path,
    allow_motion: bool = True,
    motion_executed: bool = True,
    motion_ok: bool | None = True,
) -> Path:
    _write_bound_inputs(checkpoint, hardware)
    production = validator.validate_asimov1_production_checkpoint(
        checkpoint,
        min_steps=150_000_000,
        require_inference_check=True,
    )
    path.write_text(
        json.dumps(
            {
                "ok": True,
                "profile_id": "asimov-1",
                "motion_executed": motion_executed,
                "run_evidence": {
                    "schema": "asimov-1-real-agent-run-v1",
                    "profile_id": "asimov-1",
                    "checkpoint": str(checkpoint.resolve()),
                    "hardware_evidence": str(hardware.resolve()),
                    "checkpoint_manifest_sha256": _sha256(checkpoint / "manifest.json"),
                    "checkpoint_training_job_sha256": _sha256(
                        checkpoint / "training_job.json"
                    ),
                    "checkpoint_config_sha256": _sha256(checkpoint / "config.json"),
                    "checkpoint_metrics_sha256": _sha256(checkpoint / "metrics.json"),
                    "checkpoint_inference_check_sha256": _sha256(
                        checkpoint / "inference_check.json"
                    ),
                    "checkpoint_policy": str((checkpoint / "policy_brax.pkl").resolve()),
                    "checkpoint_policy_sha256": _sha256(checkpoint / "policy_brax.pkl"),
                    "hardware_evidence_sha256": _sha256(hardware),
                    "production_min_steps": 150_000_000,
                    "task": "walk_forward",
                    "max_steps": 100,
                    "hz": 10.0,
                    "allow_motion": allow_motion,
                    "motion_executed": motion_executed,
                    "livekit_url_configured": True,
                    "livekit_token_configured": True,
                    "production_ok": True,
                    "production_validation": {
                        "ok": production["ok"],
                        "production_regime": production.get("production_regime"),
                        "max_metric_steps": production.get("max_metric_steps"),
                        "checks": production.get("checks"),
                    },
                    "hardware_ok": True,
                    "motion_ok": motion_ok,
                },
            }
        ),
        encoding="utf-8",
    )
    return path


def _write_alberta_report(path: Path, *, checkpoint: Path, hardware: Path) -> Path:
    _write_bound_inputs(checkpoint, hardware)
    for name in (
        "training_job.json",
        "policy_brax.pkl",
        "metrics.json",
        "config.json",
        "inference_check.json",
    ):
        candidate = checkpoint / name
        if candidate.exists():
            candidate.unlink()
    (checkpoint / "alberta_policy.npz").write_bytes(b"alberta-policy")
    (checkpoint / "manifest.json").write_text(
        json.dumps(
            {
                "regime": "alberta_streaming",
                "profile_id": "asimov-1",
                "ckpt": "alberta_policy.npz",
            }
        ),
        encoding="utf-8",
    )
    path.write_text(
        json.dumps(
            {
                "ok": True,
                "profile_id": "asimov-1",
                "motion_executed": True,
                "run_evidence": {
                    "schema": "asimov-1-real-agent-run-v1",
                    "profile_id": "asimov-1",
                    "checkpoint": str(checkpoint.resolve()),
                    "hardware_evidence": str(hardware.resolve()),
                    "checkpoint_manifest_sha256": _sha256(checkpoint / "manifest.json"),
                    "checkpoint_training_job_sha256": None,
                    "checkpoint_config_sha256": None,
                    "checkpoint_metrics_sha256": None,
                    "checkpoint_inference_check_sha256": None,
                    "checkpoint_policy": str((checkpoint / "alberta_policy.npz").resolve()),
                    "checkpoint_policy_sha256": _sha256(checkpoint / "alberta_policy.npz"),
                    "hardware_evidence_sha256": _sha256(hardware),
                    "production_min_steps": 150_000_000,
                    "task": "walk_forward",
                    "max_steps": 100,
                    "hz": 10.0,
                    "allow_motion": True,
                    "motion_executed": True,
                    "livekit_url_configured": True,
                    "livekit_token_configured": True,
                    "production_ok": True,
                    "production_validation": {
                        "ok": True,
                        "production_regime": None,
                        "max_metric_steps": 150_000_000,
                        "checks": None,
                    },
                    "hardware_ok": True,
                    "motion_ok": True,
                },
            }
        ),
        encoding="utf-8",
    )
    return path


def test_real_agent_run_validator_accepts_bound_motion_report(tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    report_path = _write_report(tmp_path / "run.json", checkpoint=checkpoint, hardware=hardware)

    report = validate_asimov1_real_agent_run(
        report_path,
        checkpoint=checkpoint,
        hardware_evidence=hardware,
        require_motion=True,
        require_allow_motion=True,
    )

    assert report["ok"] is True
    assert all(report["checks"].values())


def test_real_agent_run_validator_accepts_alberta_checkpoint_without_brax_sidecars(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    report_path = _write_alberta_report(
        tmp_path / "run.json",
        checkpoint=checkpoint,
        hardware=hardware,
    )
    monkeypatch.setattr(
        validator,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **_kwargs: {"ok": True, "max_metric_steps": 150_000_000},
    )

    report = validate_asimov1_real_agent_run(
        report_path,
        checkpoint=checkpoint,
        hardware_evidence=hardware,
        require_motion=True,
        require_allow_motion=True,
    )

    assert report["ok"] is True
    assert report["checkpoint_regime"] == "alberta_streaming"
    assert report["checks"]["checkpoint_training_job_present"] is True
    assert report["checks"]["checkpoint_config_present"] is True
    assert report["checks"]["checkpoint_metrics_present"] is True
    assert report["checks"]["checkpoint_inference_check_present"] is True
    assert report["checks"]["checkpoint_policy_hash_matches"] is True


def test_real_agent_run_validator_uses_archived_paths_without_cli_overrides(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    report_path = _write_report(tmp_path / "run.json", checkpoint=checkpoint, hardware=hardware)

    report = validate_asimov1_real_agent_run(
        report_path,
        require_motion=True,
        require_allow_motion=True,
    )

    assert report["ok"] is True
    assert report["checkpoint"] == str(checkpoint.resolve())
    assert report["hardware_evidence"] == str(hardware.resolve())
    assert report["checks"]["checkpoint_manifest_hash_matches"] is True
    assert report["checks"]["checkpoint_training_job_hash_matches"] is True
    assert report["checks"]["checkpoint_config_hash_matches"] is True
    assert report["checks"]["checkpoint_metrics_hash_matches"] is True
    assert report["checks"]["checkpoint_policy_hash_matches"] is True
    assert report["checks"]["hardware_evidence_hash_matches"] is True


def test_real_agent_run_validator_rejects_unbound_or_plan_only_report(tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    other_checkpoint = tmp_path / "other"
    report_path = _write_report(
        tmp_path / "run.json",
        checkpoint=other_checkpoint,
        hardware=hardware,
        allow_motion=False,
        motion_executed=False,
        motion_ok=None,
    )

    report = validate_asimov1_real_agent_run(
        report_path,
        checkpoint=checkpoint,
        hardware_evidence=hardware,
        require_motion=True,
        require_allow_motion=True,
    )

    assert report["ok"] is False
    assert report["checks"]["checkpoint_matches"] is False
    assert report["checks"]["allow_motion"] is False
    assert report["checks"]["motion_executed"] is False


def test_real_agent_run_validator_rejects_missing_archived_inputs(tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    report_path = _write_report(tmp_path / "run.json", checkpoint=checkpoint, hardware=hardware)
    (checkpoint / "manifest.json").unlink()

    report = validate_asimov1_real_agent_run(
        report_path,
        require_motion=True,
        require_allow_motion=True,
    )

    assert report["ok"] is False
    assert report["checks"]["checkpoint_manifest_present"] is False
    assert report["checks"]["checkpoint_manifest_hash_matches"] is False


def test_real_agent_run_validator_rejects_stale_hardware_hash(tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    report_path = _write_report(tmp_path / "run.json", checkpoint=checkpoint, hardware=hardware)
    hardware.write_text('{"ok": false, "profile_id": "asimov-1"}', encoding="utf-8")

    report = validate_asimov1_real_agent_run(
        report_path,
        checkpoint=checkpoint,
        hardware_evidence=hardware,
        require_motion=True,
        require_allow_motion=True,
    )

    assert report["ok"] is False
    assert report["checks"]["hardware_evidence_hash_matches"] is False


def test_real_agent_run_validator_rejects_stale_checkpoint_manifest_hash(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    report_path = _write_report(tmp_path / "run.json", checkpoint=checkpoint, hardware=hardware)
    (checkpoint / "manifest.json").write_text('{"profile_id": "other"}', encoding="utf-8")

    report = validate_asimov1_real_agent_run(
        report_path,
        checkpoint=checkpoint,
        hardware_evidence=hardware,
        require_motion=True,
        require_allow_motion=True,
    )

    assert report["ok"] is False
    assert report["checks"]["checkpoint_manifest_hash_matches"] is False


def test_real_agent_run_validator_rejects_stale_checkpoint_policy_hash(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    report_path = _write_report(tmp_path / "run.json", checkpoint=checkpoint, hardware=hardware)
    (checkpoint / "policy_brax.pkl").write_bytes(b"changed-policy")

    report = validate_asimov1_real_agent_run(
        report_path,
        checkpoint=checkpoint,
        hardware_evidence=hardware,
        require_motion=True,
        require_allow_motion=True,
    )

    assert report["ok"] is False
    assert report["checks"]["checkpoint_policy_hash_matches"] is False


def test_real_agent_run_validator_rejects_stale_checkpoint_training_hashes(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    report_path = _write_report(tmp_path / "run.json", checkpoint=checkpoint, hardware=hardware)
    (checkpoint / "training_job.json").write_text('{"changed": true}', encoding="utf-8")

    report = validate_asimov1_real_agent_run(
        report_path,
        checkpoint=checkpoint,
        hardware_evidence=hardware,
        require_motion=True,
        require_allow_motion=True,
    )

    assert report["ok"] is False
    assert report["checks"]["checkpoint_training_job_hash_matches"] is False


def test_real_agent_run_validator_revalidates_referenced_checkpoint(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    report_path = _write_report(tmp_path / "run.json", checkpoint=checkpoint, hardware=hardware)
    metrics = json.loads((checkpoint / "metrics.json").read_text(encoding="utf-8"))
    metrics[0]["steps"] = 8
    (checkpoint / "metrics.json").write_text(json.dumps(metrics), encoding="utf-8")

    report = validate_asimov1_real_agent_run(
        report_path,
        checkpoint=checkpoint,
        hardware_evidence=hardware,
        require_motion=True,
        require_allow_motion=True,
    )

    assert report["ok"] is False
    assert report["checks"]["production_revalidates"] is False


def test_real_agent_run_validator_revalidates_referenced_hardware_evidence(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    report_path = _write_report(tmp_path / "run.json", checkpoint=checkpoint, hardware=hardware)
    payload = json.loads(hardware.read_text(encoding="utf-8"))
    payload["stages"][1]["report"]["command_messages_published"] = 1
    hardware.write_text(json.dumps(payload), encoding="utf-8")

    report = validate_asimov1_real_agent_run(
        report_path,
        checkpoint=checkpoint,
        hardware_evidence=hardware,
        require_motion=True,
        require_allow_motion=True,
    )

    assert report["ok"] is False
    assert report["checks"]["hardware_revalidates"] is False
