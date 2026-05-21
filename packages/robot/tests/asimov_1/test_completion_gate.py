from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import validate_asimov1_completion as completion  # noqa: E402


def _write(path: Path, payload: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _e2e_report(path: Path, checkpoint: Path, hardware: Path) -> Path:
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
            "steps": steps,
        },
    )


def test_completion_gate_requires_all_final_artifacts(monkeypatch, tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    e2e = _e2e_report(tmp_path / "e2e.json", checkpoint, hardware)

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
        production_min_steps=150_000_000,
    )

    assert report["ok"] is True
    assert all(report["checks"].values())
    assert report["missing_e2e_steps"] == []


def test_completion_gate_fails_when_e2e_did_not_reference_checkpoint(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    other_checkpoint = tmp_path / "other"
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    e2e = _e2e_report(tmp_path / "e2e.json", other_checkpoint, hardware)

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
        production_min_steps=150_000_000,
    )

    assert report["ok"] is False
    assert report["checks"]["e2e_references_checkpoint"] is False


def test_completion_gate_fails_without_required_e2e_step(monkeypatch, tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    e2e_payload = {
        "ok": True,
        "profile_id": "asimov-1",
        "production_checkpoint": str(checkpoint.resolve()),
        "real_hardware_evidence": str(hardware.resolve()),
        "steps": [
            {"name": name, "passed": True}
            for name in sorted(completion.REQUIRED_E2E_STEPS - {"asimov_real_hardware_evidence"})
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
        production_min_steps=150_000_000,
    )

    assert report["ok"] is False
    assert report["checks"]["e2e_required_steps_present"] is False
    assert report["missing_e2e_steps"] == ["asimov_real_hardware_evidence"]


def test_completion_gate_requires_real_agent_production_ready(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoint"
    hardware = _write(tmp_path / "hardware.json", {"ok": True})
    e2e = _e2e_report(tmp_path / "e2e.json", checkpoint, hardware)
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
        production_min_steps=150_000_000,
    )

    assert report["ok"] is False
    assert report["checks"]["e2e_readiness_production_ready"] is False
