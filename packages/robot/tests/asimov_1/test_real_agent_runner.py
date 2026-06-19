from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import run_asimov1_real_agent as runner  # noqa: E402


def _production_report(**kwargs) -> dict:
    return {
        "ok": kwargs.get("require_inference_check") is True,
        "production_regime": "alberta_streaming",
        "max_metric_steps": 150_000_000,
        "checks": {
            "inference_check": kwargs.get("require_inference_check") is True,
            "manifest_mjcf_asset_provenance": True,
            "manifest_asset_manifest_provenance": True,
        },
    }


def _args(tmp_path: Path, **overrides) -> argparse.Namespace:
    values = {
        "checkpoint": None,
        "hardware_evidence": None,
        "production_min_steps": 1_000_000,
        "require_inference": False,
        "task": "walk_forward",
        "max_steps": 1,
        "hz": 10.0,
        "url": "",
        "token": "",
        "allow_motion": False,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


def test_real_agent_runner_preflight_plan_does_not_require_motion(tmp_path: Path) -> None:
    report = runner._preflight(_args(tmp_path))

    assert report["ok"] is False
    assert report["checks"]["allow_motion"] is False
    assert report["checks"]["checkpoint_provided"] is False
    assert report["checks"]["hardware_evidence_provided"] is False


def test_real_agent_runner_requires_valid_evidence_before_motion(monkeypatch, tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    hardware.write_text("{}", encoding="utf-8")

    monkeypatch.setattr(
        runner,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **kwargs: _production_report(**kwargs),
    )
    monkeypatch.setattr(
        runner,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": False},
    )

    report = runner._preflight(
        _args(
            tmp_path,
            checkpoint=checkpoint,
            hardware_evidence=hardware,
            url="wss://asimov.example.invalid",
            token="token",
            allow_motion=True,
        )
    )

    assert report["ok"] is False
    assert report["checks"]["production_checkpoint"] is True
    assert report["checks"]["hardware_evidence"] is False


def test_real_agent_runner_preflight_accepts_complete_motion_contract(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    hardware.write_text("{}", encoding="utf-8")

    monkeypatch.setattr(
        runner,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **kwargs: _production_report(**kwargs),
    )
    monkeypatch.setattr(
        runner,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": True},
    )

    report = runner._preflight(
        _args(
            tmp_path,
            checkpoint=checkpoint,
            hardware_evidence=hardware,
            url="wss://asimov.example.invalid",
            token="token",
            allow_motion=True,
        )
    )

    assert report["ok"] is True
    assert all(report["checks"].values())


def test_real_agent_runner_evidence_binds_motion_inputs(monkeypatch, tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    out = tmp_path / "run.json"
    checkpoint.mkdir(parents=True)
    (checkpoint / "manifest.json").write_text(
        '{"profile_id": "asimov-1", "ckpt": "policy_brax.pkl"}',
        encoding="utf-8",
    )
    (checkpoint / "training_job.json").write_text('{"ok": true}', encoding="utf-8")
    (checkpoint / "config.json").write_text('{"ok": true}', encoding="utf-8")
    (checkpoint / "metrics.json").write_text('[{"steps": 1}]', encoding="utf-8")
    (checkpoint / "inference_check.json").write_text('{"ok": true}', encoding="utf-8")
    (checkpoint / "policy_brax.pkl").write_bytes(b"policy")
    hardware.write_text('{"ok": true}', encoding="utf-8")

    monkeypatch.setattr(
        runner,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **kwargs: _production_report(**kwargs),
    )
    monkeypatch.setattr(
        runner,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": True},
    )

    args = _args(
        tmp_path,
        checkpoint=checkpoint,
        hardware_evidence=hardware,
        production_min_steps=150_000_000,
        url="wss://asimov.example.invalid",
        token="token",
        allow_motion=False,
        out=out,
    )
    preflight = runner._preflight(args)
    evidence = runner._run_evidence(args=args, preflight=preflight, motion=None)
    report = {**preflight, "motion_executed": False, "run_evidence": evidence}
    runner._write_report(out, report)
    saved = json.loads(out.read_text(encoding="utf-8"))

    assert saved["run_evidence"]["schema"] == "asimov-1-real-agent-run-v1"
    assert saved["run_evidence"]["checkpoint"] == str(checkpoint.resolve())
    assert saved["run_evidence"]["hardware_evidence"] == str(hardware.resolve())
    assert saved["run_evidence"]["checkpoint_manifest_sha256"] == hashlib.sha256(
        (checkpoint / "manifest.json").read_bytes()
    ).hexdigest()
    assert saved["run_evidence"]["checkpoint_training_job_sha256"] == hashlib.sha256(
        (checkpoint / "training_job.json").read_bytes()
    ).hexdigest()
    assert saved["run_evidence"]["checkpoint_config_sha256"] == hashlib.sha256(
        (checkpoint / "config.json").read_bytes()
    ).hexdigest()
    assert saved["run_evidence"]["checkpoint_metrics_sha256"] == hashlib.sha256(
        (checkpoint / "metrics.json").read_bytes()
    ).hexdigest()
    assert saved["run_evidence"]["checkpoint_inference_check_sha256"] == hashlib.sha256(
        (checkpoint / "inference_check.json").read_bytes()
    ).hexdigest()
    assert saved["run_evidence"]["checkpoint_policy"] == str(
        (checkpoint / "policy_brax.pkl").resolve()
    )
    assert saved["run_evidence"]["checkpoint_policy_sha256"] == hashlib.sha256(
        (checkpoint / "policy_brax.pkl").read_bytes()
    ).hexdigest()
    assert saved["run_evidence"]["hardware_evidence_sha256"] == hashlib.sha256(
        hardware.read_bytes()
    ).hexdigest()
    assert saved["run_evidence"]["production_min_steps"] == 150_000_000
    assert saved["run_evidence"]["production_validation"]["ok"] is True
    assert (
        saved["run_evidence"]["production_validation"]["checks"][
            "manifest_mjcf_asset_provenance"
        ]
        is True
    )
    assert saved["run_evidence"]["livekit_url_configured"] is True
    assert saved["run_evidence"]["livekit_token_configured"] is True
    assert saved["run_evidence"]["motion_executed"] is False


def test_real_agent_runner_evidence_accepts_alberta_checkpoint_without_brax_sidecars(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = tmp_path / "hardware.json"
    out = tmp_path / "run.json"
    checkpoint.mkdir(parents=True)
    (checkpoint / "manifest.json").write_text(
        json.dumps(
            {
                "profile_id": "asimov-1",
                "regime": "alberta_streaming",
                "ckpt": "alberta_policy.npz",
            }
        ),
        encoding="utf-8",
    )
    (checkpoint / "alberta_policy.npz").write_bytes(b"alberta-policy")
    hardware.write_text('{"ok": true}', encoding="utf-8")

    monkeypatch.setattr(
        runner,
        "validate_asimov1_production_checkpoint",
        lambda *_args, **kwargs: _production_report(**kwargs),
    )
    monkeypatch.setattr(
        runner,
        "validate_asimov1_real_hardware_evidence",
        lambda *_args, **_kwargs: {"ok": True},
    )

    args = _args(
        tmp_path,
        checkpoint=checkpoint,
        hardware_evidence=hardware,
        production_min_steps=150_000_000,
        url="wss://asimov.example.invalid",
        token="token",
        allow_motion=False,
        out=out,
    )
    preflight = runner._preflight(args)
    evidence = runner._run_evidence(args=args, preflight=preflight, motion=None)
    report = {**preflight, "motion_executed": False, "run_evidence": evidence}
    runner._write_report(out, report)
    saved = json.loads(out.read_text(encoding="utf-8"))

    assert saved["run_evidence"]["checkpoint_manifest_sha256"] == hashlib.sha256(
        (checkpoint / "manifest.json").read_bytes()
    ).hexdigest()
    assert saved["run_evidence"]["checkpoint_training_job_sha256"] is None
    assert saved["run_evidence"]["checkpoint_config_sha256"] is None
    assert saved["run_evidence"]["checkpoint_metrics_sha256"] is None
    assert saved["run_evidence"]["checkpoint_inference_check_sha256"] is None
    assert saved["run_evidence"]["checkpoint_policy"] == str(
        (checkpoint / "alberta_policy.npz").resolve()
    )
    assert saved["run_evidence"]["checkpoint_policy_sha256"] == hashlib.sha256(
        (checkpoint / "alberta_policy.npz").read_bytes()
    ).hexdigest()
    assert saved["run_evidence"]["production_ok"] is True
    assert saved["run_evidence"]["production_validation"]["ok"] is True
    assert (
        saved["run_evidence"]["production_validation"]["checks"][
            "manifest_asset_manifest_provenance"
        ]
        is True
    )
