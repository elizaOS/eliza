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
from scripts import validate_asimov1_completion as completion  # noqa: E402

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


def _maybe_sha256(path: Path) -> str | None:
    return _sha256(path) if path.is_file() else None


def _write(path: Path, payload: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


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


def _write_valid_checkpoint(checkpoint: Path) -> None:
    checkpoint.mkdir(parents=True, exist_ok=True)
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
    (checkpoint / "manifest.template.json").write_text(json.dumps(manifest), encoding="utf-8")
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


def _write_valid_hardware(hardware: Path) -> None:
    _write(
        hardware,
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
        },
    )


def _agent_run_report(path: Path, checkpoint: Path, hardware: Path) -> Path:
    _write_valid_checkpoint(checkpoint)
    _write_valid_hardware(hardware)
    return _write(
        path,
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
                "allow_motion": True,
                "motion_executed": True,
                "production_ok": True,
                "hardware_ok": True,
                "livekit_url_configured": True,
                "livekit_token_configured": True,
                "motion_ok": True,
            },
        },
    )


def _full_training_run_report(path: Path, checkpoint: Path) -> Path:
    _write_valid_checkpoint(checkpoint)
    return _write(
        path,
        {
            "schema": "asimov-1-full-training-run-v1",
            "profile_id": "asimov-1",
            "job_dir": str(checkpoint.resolve()),
            "ok": True,
            "artifact_sha256": {
                name: _sha256(checkpoint / name)
                for name in (
                    "training_job.json",
                    "manifest.template.json",
                    "policy_brax.pkl",
                    "manifest.json",
                    "metrics.json",
                    "config.json",
                    "inference_check.json",
                )
            },
            "input_asset_sha256": {
                "mjcf_xml": _sha256(ASIMOV1_GENERATED_MJCF),
                "asset_manifest": _sha256(ASIMOV1_GENERATED_MANIFEST),
            },
            "training": {"ok": True},
            "post_training_validation": {
                "ok": True,
                "steps": [
                    {
                        "passed": True,
                        "argv": [
                            "python3",
                            "scripts/verify_brax_text_policy.py",
                            "--profile",
                            "asimov-1",
                            "--require-proprio-dim",
                            "45",
                            "--require-action-dim",
                            "12",
                            "--require-output-dim",
                            "25",
                            "--require-critic-obs-dim",
                            "62",
                            "--require-policy-obs-key",
                            "state",
                            "--require-value-obs-key",
                            "privileged_state",
                        ],
                        "parsed": {"ok": True},
                    },
                    {
                        "passed": True,
                        "argv": [
                            "python3",
                            "scripts/validate_asimov1_production_checkpoint.py",
                            str(checkpoint.resolve()),
                            "--min-steps",
                            "150000000",
                            "--require-inference-check",
                        ],
                        "parsed": {"ok": True, "checks": {"inference_check": True}},
                    },
                ],
            },
        },
    )


def _e2e_report(
    path: Path,
    checkpoint: Path,
    hardware: Path,
    full_training_run: Path,
    agent_run: Path,
) -> Path:
    steps = [{"name": name, "passed": True} for name in sorted(completion.REQUIRED_E2E_STEPS)]
    for step in steps:
        if step["name"] == "asimov_real_agent_readiness":
            step["parsed"] = {
                "production_ready": True,
                "require_production": True,
                "require_hardware": True,
                "checkpoint": str(checkpoint.resolve()),
                "hardware_evidence": str(hardware.resolve()),
            }
    return _write(
        path,
        {
            "ok": True,
            "profile_id": "asimov-1",
            "production_min_steps": 150_000_000,
            "production_checkpoint": str(checkpoint.resolve()),
            "real_hardware_evidence": str(hardware.resolve()),
            "full_training_run": str(full_training_run.resolve()),
            "real_agent_run": str(agent_run.resolve()),
            "artifact_sha256": {
                "workspace_promotion_plan": None,
                "real_hardware_evidence": _sha256(hardware),
                "production_checkpoint_manifest": _maybe_sha256(checkpoint / "manifest.json"),
                "production_checkpoint_training_job": _maybe_sha256(
                    checkpoint / "training_job.json"
                ),
                "production_checkpoint_config": _maybe_sha256(checkpoint / "config.json"),
                "production_checkpoint_metrics": _maybe_sha256(checkpoint / "metrics.json"),
                "production_checkpoint_inference_check": _maybe_sha256(
                    checkpoint / "inference_check.json"
                ),
                "production_checkpoint_policy": _maybe_sha256(checkpoint / "policy_brax.pkl"),
                "full_training_run": _sha256(full_training_run),
                "real_agent_run": _sha256(agent_run),
            },
            "steps": steps,
        },
    )


def _write_alberta_checkpoint(checkpoint: Path) -> None:
    checkpoint.mkdir(parents=True, exist_ok=True)
    manifest = {
        "regime": "alberta_streaming",
        "profile_id": "asimov-1",
        "ckpt": "alberta_policy.npz",
    }
    (checkpoint / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (checkpoint / "alberta_policy.npz").write_bytes(b"alberta-policy")


def _alberta_e2e_report(
    path: Path,
    checkpoint: Path,
    hardware: Path,
    full_training_run: Path,
    agent_run: Path,
    *,
    sidecar_hash: str | None = None,
) -> Path:
    steps = [{"name": name, "passed": True} for name in sorted(completion.REQUIRED_E2E_STEPS)]
    for step in steps:
        if step["name"] == "asimov_real_agent_readiness":
            step["parsed"] = {
                "production_ready": True,
                "require_production": True,
                "require_hardware": True,
                "checkpoint": str(checkpoint.resolve()),
                "hardware_evidence": str(hardware.resolve()),
            }
    return _write(
        path,
        {
            "ok": True,
            "profile_id": "asimov-1",
            "production_min_steps": 150_000_000,
            "production_checkpoint": str(checkpoint.resolve()),
            "real_hardware_evidence": str(hardware.resolve()),
            "full_training_run": str(full_training_run.resolve()),
            "real_agent_run": str(agent_run.resolve()),
            "artifact_sha256": {
                "workspace_promotion_plan": None,
                "real_hardware_evidence": _sha256(hardware),
                "production_checkpoint_manifest": _sha256(checkpoint / "manifest.json"),
                "production_checkpoint_training_job": sidecar_hash,
                "production_checkpoint_config": None,
                "production_checkpoint_metrics": None,
                "production_checkpoint_inference_check": None,
                "production_checkpoint_policy": _sha256(checkpoint / "alberta_policy.npz"),
                "full_training_run": _sha256(full_training_run),
                "real_agent_run": _sha256(agent_run),
            },
            "steps": steps,
        },
    )


def test_completion_gate_requires_all_final_artifacts(monkeypatch, tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    agent_run = _agent_run_report(tmp_path / "agent-run.json", checkpoint, hardware)
    full_training_run = _full_training_run_report(tmp_path / "full-training-run.json", checkpoint)
    e2e = _e2e_report(tmp_path / "e2e.json", checkpoint, hardware, full_training_run, agent_run)

    production_kwargs: dict = {}

    def fake_production(*_args, **kwargs):
        production_kwargs.update(kwargs)
        return {"ok": True, "max_metric_steps": 150_000_000}

    monkeypatch.setattr(completion, "validate_asimov1_production_checkpoint", fake_production)
    monkeypatch.setattr(
        completion,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": True},
    )

    report = completion.validate_asimov1_completion(
        e2e_report=e2e,
        production_checkpoint=checkpoint,
        hardware_evidence=hardware,
        full_training_run=full_training_run,
        real_agent_run=agent_run,
        production_min_steps=150_000_000,
    )

    assert report["ok"] is True
    assert all(report["checks"].values())
    assert report["missing_e2e_steps"] == []
    assert production_kwargs["require_inference_check"] is True


def test_completion_gate_accepts_alberta_checkpoint_without_brax_sidecars(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    _write_alberta_checkpoint(checkpoint)
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    full_training_run = _write(tmp_path / "full-training-run.json", {"ok": True})
    agent_run = _write(tmp_path / "agent-run.json", {"ok": True})
    e2e = _alberta_e2e_report(
        tmp_path / "e2e.json",
        checkpoint,
        hardware,
        full_training_run,
        agent_run,
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **_kwargs: {"ok": True, "max_metric_steps": 150_000_000},
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": True},
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_full_training_run",
        lambda *_args, **_kwargs: {"ok": True},
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_real_agent_run",
        lambda *_args, **_kwargs: {"ok": True},
    )

    report = completion.validate_asimov1_completion(
        e2e_report=e2e,
        production_checkpoint=checkpoint,
        hardware_evidence=hardware,
        full_training_run=full_training_run,
        real_agent_run=agent_run,
        production_min_steps=150_000_000,
    )

    assert report["ok"] is True
    assert report["checkpoint_regime"] == "alberta_streaming"
    assert report["checks"]["e2e_checkpoint_training_job_hash"] is True
    assert report["checks"]["e2e_checkpoint_config_hash"] is True
    assert report["checks"]["e2e_checkpoint_metrics_hash"] is True
    assert report["checks"]["e2e_checkpoint_inference_check_hash"] is True
    assert report["checks"]["e2e_checkpoint_policy_hash"] is True


def test_completion_gate_rejects_archived_alberta_sidecar_hash_without_sidecar(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    _write_alberta_checkpoint(checkpoint)
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    full_training_run = _write(tmp_path / "full-training-run.json", {"ok": True})
    agent_run = _write(tmp_path / "agent-run.json", {"ok": True})
    e2e = _alberta_e2e_report(
        tmp_path / "e2e.json",
        checkpoint,
        hardware,
        full_training_run,
        agent_run,
        sidecar_hash="0" * 64,
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **_kwargs: {"ok": True, "max_metric_steps": 150_000_000},
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": True},
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_full_training_run",
        lambda *_args, **_kwargs: {"ok": True},
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_real_agent_run",
        lambda *_args, **_kwargs: {"ok": True},
    )

    report = completion.validate_asimov1_completion(
        e2e_report=e2e,
        production_checkpoint=checkpoint,
        hardware_evidence=hardware,
        full_training_run=full_training_run,
        real_agent_run=agent_run,
        production_min_steps=150_000_000,
    )

    assert report["ok"] is False
    assert report["checks"]["e2e_checkpoint_training_job_hash"] is False


def test_completion_gate_fails_when_e2e_did_not_reference_checkpoint(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    other_checkpoint = tmp_path / "other"
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    agent_run = _agent_run_report(tmp_path / "agent-run.json", checkpoint, hardware)
    full_training_run = _full_training_run_report(tmp_path / "full-training-run.json", checkpoint)
    e2e = _e2e_report(tmp_path / "e2e.json", other_checkpoint, hardware, full_training_run, agent_run)

    monkeypatch.setattr(
        completion,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **_kwargs: {"ok": True, "max_metric_steps": 150_000_000},
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": True},
    )

    report = completion.validate_asimov1_completion(
        e2e_report=e2e,
        production_checkpoint=checkpoint,
        hardware_evidence=hardware,
        full_training_run=full_training_run,
        real_agent_run=agent_run,
        production_min_steps=150_000_000,
    )

    assert report["ok"] is False
    assert report["checks"]["e2e_references_checkpoint"] is False


def test_completion_gate_fails_without_required_e2e_step(monkeypatch, tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    agent_run = _agent_run_report(tmp_path / "agent-run.json", checkpoint, hardware)
    full_training_run = _full_training_run_report(tmp_path / "full-training-run.json", checkpoint)
    e2e_payload = {
        "ok": True,
        "profile_id": "asimov-1",
        "production_checkpoint": str(checkpoint.resolve()),
        "real_hardware_evidence": str(hardware.resolve()),
        "full_training_run": str(full_training_run.resolve()),
        "real_agent_run": str(agent_run.resolve()),
        "steps": [
            {"name": name, "passed": True}
            for name in sorted(completion.REQUIRED_E2E_STEPS - {"asimov_full_training_run"})
        ],
    }
    e2e = _write(tmp_path / "e2e.json", e2e_payload)

    monkeypatch.setattr(
        completion,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **_kwargs: {"ok": True, "max_metric_steps": 150_000_000},
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": True},
    )

    report = completion.validate_asimov1_completion(
        e2e_report=e2e,
        production_checkpoint=checkpoint,
        hardware_evidence=hardware,
        full_training_run=full_training_run,
        real_agent_run=agent_run,
        production_min_steps=150_000_000,
    )

    assert report["ok"] is False
    assert report["checks"]["e2e_required_steps_present"] is False
    assert report["missing_e2e_steps"] == ["asimov_full_training_run"]


def test_completion_gate_requires_real_agent_production_ready(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    agent_run = _agent_run_report(tmp_path / "agent-run.json", checkpoint, hardware)
    full_training_run = _full_training_run_report(tmp_path / "full-training-run.json", checkpoint)
    e2e = _e2e_report(tmp_path / "e2e.json", checkpoint, hardware, full_training_run, agent_run)
    payload = json.loads(e2e.read_text(encoding="utf-8"))
    for step in payload["steps"]:
        if step["name"] == "asimov_real_agent_readiness":
            step["parsed"]["production_ready"] = False
    e2e.write_text(json.dumps(payload), encoding="utf-8")

    monkeypatch.setattr(
        completion,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **_kwargs: {"ok": True, "max_metric_steps": 150_000_000},
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": True},
    )

    report = completion.validate_asimov1_completion(
        e2e_report=e2e,
        production_checkpoint=checkpoint,
        hardware_evidence=hardware,
        full_training_run=full_training_run,
        real_agent_run=agent_run,
        production_min_steps=150_000_000,
    )

    assert report["ok"] is False
    assert report["checks"]["e2e_readiness_production_ready"] is False


def test_completion_gate_requires_bound_real_agent_run(monkeypatch, tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    other_hardware = _write(tmp_path / "other-hardware.json", {"ok": True})
    agent_run = _agent_run_report(tmp_path / "agent-run.json", checkpoint, other_hardware)
    full_training_run = _full_training_run_report(tmp_path / "full-training-run.json", checkpoint)
    e2e = _e2e_report(tmp_path / "e2e.json", checkpoint, hardware, full_training_run, agent_run)

    monkeypatch.setattr(
        completion,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **_kwargs: {"ok": True, "max_metric_steps": 150_000_000},
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": True},
    )

    report = completion.validate_asimov1_completion(
        e2e_report=e2e,
        production_checkpoint=checkpoint,
        hardware_evidence=hardware,
        full_training_run=full_training_run,
        real_agent_run=agent_run,
        production_min_steps=150_000_000,
    )

    assert report["ok"] is False
    assert report["checks"]["real_agent_run"] is False


def test_completion_gate_requires_bound_full_training_run(monkeypatch, tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    agent_run = _agent_run_report(tmp_path / "agent-run.json", checkpoint, hardware)
    full_training_run = _full_training_run_report(tmp_path / "full-training-run.json", checkpoint)
    e2e = _e2e_report(tmp_path / "e2e.json", checkpoint, hardware, full_training_run, agent_run)
    (checkpoint / "metrics.json").write_text("stale\n", encoding="utf-8")

    monkeypatch.setattr(
        completion,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **_kwargs: {"ok": True, "max_metric_steps": 150_000_000},
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": True},
    )

    report = completion.validate_asimov1_completion(
        e2e_report=e2e,
        production_checkpoint=checkpoint,
        hardware_evidence=hardware,
        full_training_run=full_training_run,
        real_agent_run=agent_run,
        production_min_steps=150_000_000,
    )

    assert report["ok"] is False
    assert report["checks"]["full_training_run"] is False


def test_completion_gate_rejects_stale_e2e_artifact_hashes(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    agent_run = _agent_run_report(tmp_path / "agent-run.json", checkpoint, hardware)
    full_training_run = _full_training_run_report(tmp_path / "full-training-run.json", checkpoint)
    e2e = _e2e_report(tmp_path / "e2e.json", checkpoint, hardware, full_training_run, agent_run)
    payload = json.loads(e2e.read_text(encoding="utf-8"))
    payload["artifact_sha256"]["real_agent_run"] = "0" * 64
    e2e.write_text(json.dumps(payload), encoding="utf-8")

    monkeypatch.setattr(
        completion,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **_kwargs: {"ok": True, "max_metric_steps": 150_000_000},
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": True},
    )

    report = completion.validate_asimov1_completion(
        e2e_report=e2e,
        production_checkpoint=checkpoint,
        hardware_evidence=hardware,
        full_training_run=full_training_run,
        real_agent_run=agent_run,
        production_min_steps=150_000_000,
    )

    assert report["ok"] is False
    assert report["checks"]["e2e_real_agent_run_hash"] is False


def test_completion_gate_rejects_stale_e2e_checkpoint_training_hashes(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    agent_run = _agent_run_report(tmp_path / "agent-run.json", checkpoint, hardware)
    full_training_run = _full_training_run_report(tmp_path / "full-training-run.json", checkpoint)
    e2e = _e2e_report(tmp_path / "e2e.json", checkpoint, hardware, full_training_run, agent_run)
    payload = json.loads(e2e.read_text(encoding="utf-8"))
    payload["artifact_sha256"]["production_checkpoint_training_job"] = "0" * 64
    e2e.write_text(json.dumps(payload), encoding="utf-8")

    monkeypatch.setattr(
        completion,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **_kwargs: {"ok": True, "max_metric_steps": 150_000_000},
    )
    monkeypatch.setattr(
        completion,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": True},
    )

    report = completion.validate_asimov1_completion(
        e2e_report=e2e,
        production_checkpoint=checkpoint,
        hardware_evidence=hardware,
        full_training_run=full_training_run,
        real_agent_run=agent_run,
        production_min_steps=150_000_000,
    )

    assert report["ok"] is False
    assert report["checks"]["e2e_checkpoint_training_job_hash"] is False
