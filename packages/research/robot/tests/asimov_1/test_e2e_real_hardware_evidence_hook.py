from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import validate_asimov1_e2e as e2e  # noqa: E402


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _fake_success_run(calls: list[str]):
    def fake_run(name: str, argv: list[str], *, cwd: Path = e2e.ROOT) -> dict:
        calls.append(name)
        stdout = ""
        if name == "bridge_targets":
            stdout = "asimov asimov_mock asimov-mujoco asimov_mujoco asimov-real asimov_remote"
        return {
            "name": name,
            "argv": argv,
            "returncode": 0,
            "stdout": stdout,
            "stderr": "",
            "passed": True,
            "parsed": {"ok": True},
        }

    return fake_run


def test_e2e_gate_validates_real_hardware_evidence_when_provided(
    monkeypatch,
    tmp_path: Path,
) -> None:
    evidence_path = tmp_path / "hardware.json"
    calls: list[str] = []
    monkeypatch.setattr(e2e, "_run", _fake_success_run(calls))

    report = e2e.run_asimov1_e2e(
        tmp_path / "out",
        steps=1,
        seed=7,
        real_hardware_evidence=evidence_path,
    )

    assert report["ok"] is True
    assert report["real_hardware_evidence"] == str(evidence_path.resolve())
    assert calls[-1] == "asimov_real_hardware_evidence"
    assert all(report["launch_checks"].values())
    evidence_step = report["steps"][-1]
    assert evidence_step["argv"][-1] == str(evidence_path.resolve())
    readiness_step = next(step for step in report["steps"] if step["name"] == "asimov_real_agent_readiness")
    assert "--hardware-evidence" in readiness_step["argv"]
    assert str(evidence_path.resolve()) in readiness_step["argv"]
    assert "--require-hardware" in readiness_step["argv"]


def test_e2e_gate_validates_production_checkpoint_when_provided(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint_path = tmp_path / "checkpoint"
    calls: list[str] = []
    monkeypatch.setattr(e2e, "_run", _fake_success_run(calls))

    report = e2e.run_asimov1_e2e(
        tmp_path / "out",
        steps=1,
        seed=7,
        production_checkpoint=checkpoint_path,
        production_min_steps=123,
    )

    assert report["ok"] is True
    assert report["production_checkpoint"] == str(checkpoint_path.resolve())
    assert report["production_min_steps"] == 123
    assert calls[-1] == "asimov_production_checkpoint"
    assert all(report["launch_checks"].values())
    checkpoint_step = report["steps"][-1]
    assert checkpoint_step["argv"][-4:] == [
        str(checkpoint_path.resolve()),
        "--min-steps",
        "123",
        "--require-inference-check",
    ]
    readiness_step = next(step for step in report["steps"] if step["name"] == "asimov_real_agent_readiness")
    assert "--checkpoint" in readiness_step["argv"]
    assert str(checkpoint_path.resolve()) in readiness_step["argv"]
    assert "--production-min-steps" in readiness_step["argv"]
    assert "123" in readiness_step["argv"]
    assert "--require-production" in readiness_step["argv"]


def test_e2e_gate_validates_real_agent_run_when_provided(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint_path = tmp_path / "checkpoint"
    evidence_path = tmp_path / "hardware.json"
    run_path = tmp_path / "real-agent-run.json"
    calls: list[str] = []
    monkeypatch.setattr(e2e, "_run", _fake_success_run(calls))

    report = e2e.run_asimov1_e2e(
        tmp_path / "out",
        steps=1,
        seed=7,
        production_checkpoint=checkpoint_path,
        real_hardware_evidence=evidence_path,
        real_agent_run=run_path,
    )

    assert report["ok"] is True
    assert report["real_agent_run"] == str(run_path.resolve())
    assert calls[-1] == "asimov_real_agent_run"
    run_step = report["steps"][-1]
    assert "scripts/validate_asimov1_real_agent_run.py" in run_step["argv"]
    assert str(run_path.resolve()) in run_step["argv"]
    assert "--require-allow-motion" in run_step["argv"]
    assert "--require-motion" in run_step["argv"]
    assert "--checkpoint" in run_step["argv"]
    assert str(checkpoint_path.resolve()) in run_step["argv"]
    assert "--hardware-evidence" in run_step["argv"]
    assert str(evidence_path.resolve()) in run_step["argv"]


def test_e2e_gate_validates_full_training_run_when_provided(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint_path = tmp_path / "checkpoint"
    full_training_run = tmp_path / "full-training-run.json"
    calls: list[str] = []
    monkeypatch.setattr(e2e, "_run", _fake_success_run(calls))

    report = e2e.run_asimov1_e2e(
        tmp_path / "out",
        steps=1,
        seed=7,
        production_checkpoint=checkpoint_path,
        full_training_run=full_training_run,
    )

    assert report["ok"] is True
    assert report["full_training_run"] == str(full_training_run.resolve())
    assert calls[-1] == "asimov_full_training_run"
    run_step = report["steps"][-1]
    assert "scripts/validate_asimov1_full_training_run.py" in run_step["argv"]
    assert str(full_training_run.resolve()) in run_step["argv"]
    assert "--job-dir" in run_step["argv"]
    assert str(checkpoint_path.resolve()) in run_step["argv"]


def test_e2e_gate_runs_controller_contract(monkeypatch, tmp_path: Path) -> None:
    calls: list[str] = []
    monkeypatch.setattr(e2e, "_run", _fake_success_run(calls))

    report = e2e.run_asimov1_e2e(
        tmp_path / "out",
        steps=1,
        seed=7,
    )

    assert report["ok"] is True
    assert "asimov_controller_contract" in calls
    controller_step = next(
        step for step in report["steps"] if step["name"] == "asimov_controller_contract"
    )
    assert "scripts/validate_asimov1_controller_contract.py" in controller_step["argv"]


def test_e2e_gate_uses_alberta_checkpoint_for_internal_sim_gate(
    monkeypatch,
    tmp_path: Path,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(e2e, "_run", _fake_success_run(calls))

    report = e2e.run_asimov1_e2e(
        tmp_path / "out",
        steps=1,
        seed=7,
    )

    assert report["ok"] is True
    train_step = next(step for step in report["steps"] if step["name"] == "alberta_checkpoint")
    assert "--smoke" not in train_step["argv"]
    assert "--profile" in train_step["argv"]
    assert "asimov-1" in train_step["argv"]
    assert "--tasks" in train_step["argv"]
    assert "stand_up" in train_step["argv"]
    assert "walk_forward" in train_step["argv"]
    gate_step = next(step for step in report["steps"] if step["name"] == "asimov_sim_gate")
    assert str((tmp_path / "out" / "checkpoint").resolve()) in gate_step["argv"]


def test_e2e_gate_validates_workspace_promotion_when_provided(
    monkeypatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "edit-workspace"
    calls: list[str] = []
    monkeypatch.setattr(e2e, "_run", _fake_success_run(calls))

    report = e2e.run_asimov1_e2e(
        tmp_path / "out",
        steps=1,
        seed=7,
        workspace_promotion=workspace,
        require_promotion_applied=True,
    )

    assert report["ok"] is True
    assert report["workspace_promotion"] == str(workspace.resolve())
    assert report["require_promotion_applied"] is True
    assert calls[-1] == "asimov_workspace_promotion"
    promotion_step = report["steps"][-1]
    assert promotion_step["argv"][-3:] == [
        "--workspace",
        str(workspace.resolve()),
        "--require-applied",
    ]
    assert promotion_step["argv"][-1] == "--require-applied"


def test_e2e_report_binds_optional_artifact_hashes(
    monkeypatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "edit-workspace"
    workspace.mkdir()
    promotion_plan = workspace / "asimov_promotion_plan.json"
    promotion_plan.write_text('{"ok": true}', encoding="utf-8")
    hardware = tmp_path / "hardware.json"
    hardware.write_text('{"ok": true}', encoding="utf-8")
    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()
    (checkpoint / "manifest.json").write_text(
        json.dumps({"ckpt": "policy_brax.pkl"}),
        encoding="utf-8",
    )
    (checkpoint / "training_job.json").write_text('{"ok": true}', encoding="utf-8")
    (checkpoint / "config.json").write_text('{"ok": true}', encoding="utf-8")
    (checkpoint / "metrics.json").write_text('[{"steps": 1}]', encoding="utf-8")
    (checkpoint / "inference_check.json").write_text('{"ok": true}', encoding="utf-8")
    (checkpoint / "policy_brax.pkl").write_bytes(b"policy")
    full_training_run = tmp_path / "full-training-run.json"
    full_training_run.write_text('{"ok": true}', encoding="utf-8")
    real_agent_run = tmp_path / "real-agent-run.json"
    real_agent_run.write_text('{"ok": true}', encoding="utf-8")
    calls: list[str] = []
    monkeypatch.setattr(e2e, "_run", _fake_success_run(calls))

    report = e2e.run_asimov1_e2e(
        tmp_path / "out",
        steps=1,
        seed=7,
        workspace_promotion=workspace,
        real_hardware_evidence=hardware,
        production_checkpoint=checkpoint,
        full_training_run=full_training_run,
        real_agent_run=real_agent_run,
    )

    hashes = report["artifact_sha256"]
    assert hashes["workspace_promotion_plan"] == _sha256(promotion_plan)
    assert hashes["real_hardware_evidence"] == _sha256(hardware)
    assert hashes["production_checkpoint_manifest"] == _sha256(checkpoint / "manifest.json")
    assert hashes["production_checkpoint_training_job"] == _sha256(
        checkpoint / "training_job.json"
    )
    assert hashes["production_checkpoint_config"] == _sha256(checkpoint / "config.json")
    assert hashes["production_checkpoint_metrics"] == _sha256(checkpoint / "metrics.json")
    assert hashes["production_checkpoint_inference_check"] == _sha256(
        checkpoint / "inference_check.json"
    )
    assert hashes["production_checkpoint_policy"] == _sha256(checkpoint / "policy_brax.pkl")
    assert hashes["full_training_run"] == _sha256(full_training_run)
    assert hashes["real_agent_run"] == _sha256(real_agent_run)
