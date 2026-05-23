from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import run_asimov1_real_agent as runner  # noqa: E402


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
        lambda *_args, **_kwargs: {"ok": True},
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
        lambda *_args, **_kwargs: {"ok": True},
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
