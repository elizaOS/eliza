from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "manage_rlvr_release.py"

if not SCRIPT_PATH.exists():
    pytest.skip(f"script not found: {SCRIPT_PATH.name}", allow_module_level=True)


def build_report(path: Path, adapter: Path, score: Path, label: str) -> Path:
    overall_score = json.loads(score.read_text(encoding="utf-8"))["overallScore"]
    decisions_path = path / f"{label}-decisions.json"
    decisions_path.write_text(
        json.dumps(
            [
                {
                    "scenarioId": f"scenario-{label}",
                    "chosenAction": "refuse",
                    "responseText": "I will not comply.",
                }
            ],
            indent=2,
        ),
        encoding="utf-8",
    )
    report_path = path / f"{label}-report.json"
    report_path.write_text(
        json.dumps(
            {
                "config": {"model": "Qwen/Qwen3.5-4B"},
                "phases": {
                    "distill": {"status": "completed", "adapter_path": str(adapter)},
                    "eval_distill": {
                        "status": "completed",
                        "overall_score": overall_score,
                        "score_path": str(score),
                        "output_path": str(decisions_path),
                    },
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return report_path


def test_manage_rlvr_release_promote_and_rollback(tmp_path: Path) -> None:
    release_root = tmp_path / "release-root"

    adapter_one = tmp_path / "adapter-one.safetensors"
    adapter_one.write_text("adapter-one", encoding="utf-8")
    score_one = tmp_path / "score-one.json"
    score_one.write_text(json.dumps({"overallScore": 89.0}), encoding="utf-8")
    report_one = build_report(tmp_path, adapter_one, score_one, "one")

    promote_one = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "promote",
            "--report",
            str(report_one),
            "--release-root",
            str(release_root),
            "--label",
            "candidate-one",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    payload_one = json.loads(promote_one.stdout)
    assert payload_one["release_id"].startswith("candidate-one-")
    assert (release_root / "current").is_symlink()
    release_one_dir = release_root / "releases" / payload_one["release_id"]
    assert release_one_dir.is_dir()
    assert Path(payload_one["adapter_path"]).parent == release_one_dir
    assert Path(payload_one["release_report_path"]).parent == release_one_dir
    assert Path(payload_one["score_path"]).parent == release_one_dir
    assert Path(payload_one["decision_output_path"]).parent == release_one_dir
    assert Path(payload_one["health_path"]).parent == release_one_dir
    assert payload_one["health_status"] == "healthy"
    assert payload_one["health_alert_count"] == 0
    assert Path(payload_one["adapter_path"]).read_text(encoding="utf-8") == "adapter-one"
    assert json.loads(Path(payload_one["score_path"]).read_text(encoding="utf-8")) == {
        "overallScore": 89.0
    }
    assert (
        json.loads(Path(payload_one["decision_output_path"]).read_text(encoding="utf-8"))[0][
            "scenarioId"
        ]
        == "scenario-one"
    )
    assert json.loads(Path(payload_one["release_report_path"]).read_text(encoding="utf-8"))[
        "phases"
    ]["distill"]["adapter_path"] == str(adapter_one)
    assert (
        json.loads(Path(payload_one["health_path"]).read_text(encoding="utf-8"))["status"]
        == "healthy"
    )

    adapter_two = tmp_path / "adapter-two.safetensors"
    adapter_two.write_text("adapter-two", encoding="utf-8")
    score_two = tmp_path / "score-two.json"
    score_two.write_text(json.dumps({"overallScore": 93.0}), encoding="utf-8")
    report_two = build_report(tmp_path, adapter_two, score_two, "two")

    promote_two = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "promote",
            "--report",
            str(report_two),
            "--release-root",
            str(release_root),
            "--label",
            "candidate-two",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    payload_two = json.loads(promote_two.stdout)
    current = json.loads((release_root / "current.json").read_text(encoding="utf-8"))
    previous = json.loads((release_root / "previous.json").read_text(encoding="utf-8"))
    assert current["release_id"] == payload_two["release_id"]
    assert previous["release_id"] == payload_one["release_id"]
    release_two_dir = release_root / "releases" / payload_two["release_id"]
    assert Path(payload_two["adapter_path"]).parent == release_two_dir
    assert Path(payload_two["adapter_path"]).read_text(encoding="utf-8") == "adapter-two"

    for source_path in (
        adapter_one,
        score_one,
        report_one,
        tmp_path / "one-decisions.json",
        adapter_two,
        score_two,
        report_two,
        tmp_path / "two-decisions.json",
    ):
        source_path.unlink()

    rollback = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "rollback",
            "--release-root",
            str(release_root),
            "--target-release-id",
            payload_one["release_id"],
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    rollback_event = json.loads(rollback.stdout)
    current_after = json.loads((release_root / "current.json").read_text(encoding="utf-8"))
    assert rollback_event["to_release_id"] == payload_one["release_id"]
    assert current_after["release_id"] == payload_one["release_id"]
    assert Path(current_after["adapter_path"]).read_text(encoding="utf-8") == "adapter-one"
    assert json.loads(Path(current_after["score_path"]).read_text(encoding="utf-8")) == {
        "overallScore": 89.0
    }
    assert (
        json.loads(Path(current_after["decision_output_path"]).read_text(encoding="utf-8"))[0][
            "scenarioId"
        ]
        == "scenario-one"
    )


def test_manage_rlvr_release_fails_cleanly_for_missing_adapter(tmp_path: Path) -> None:
    release_root = tmp_path / "release-root"
    score = tmp_path / "score.json"
    score.write_text(json.dumps({"overallScore": 89.0}), encoding="utf-8")
    report_path = build_report(tmp_path, tmp_path / "missing-adapter.safetensors", score, "broken")

    proc = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "promote",
            "--report",
            str(report_path),
            "--release-root",
            str(release_root),
            "--label",
            "candidate-broken",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert proc.returncode == 1
    assert proc.stdout == ""
    assert "Release command promote failed" in proc.stderr
    assert "Adapter path does not exist" in proc.stderr


def test_manage_rlvr_release_rejects_critical_health_report(tmp_path: Path) -> None:
    release_root = tmp_path / "release-root"
    adapter = tmp_path / "adapter.safetensors"
    adapter.write_text("adapter", encoding="utf-8")
    report_path = tmp_path / "critical-report.json"
    report_path.write_text(
        json.dumps(
            {
                "config": {"model": "Qwen/Qwen3.5-4B"},
                "phases": {
                    "distill": {"status": "completed", "adapter_path": str(adapter)},
                    "eval_distill": {
                        "status": "completed",
                        "overall_score": 89.0,
                        "score_path": str(tmp_path / "missing-score.json"),
                        "output_path": str(tmp_path / "missing-decisions.json"),
                    },
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    proc = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "promote",
            "--report",
            str(report_path),
            "--release-root",
            str(release_root),
            "--label",
            "candidate-critical",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert proc.returncode == 1
    assert "critical health status" in proc.stderr


def test_manage_rlvr_release_manual_adapter_keeps_distill_eval_artifacts(tmp_path: Path) -> None:
    release_root = tmp_path / "release-root"
    adapter = tmp_path / "adapter.safetensors"
    adapter.write_text("adapter", encoding="utf-8")
    score = tmp_path / "score.json"
    score.write_text(json.dumps({"overallScore": 89.0}), encoding="utf-8")
    report_path = build_report(tmp_path, adapter, score, "manual")

    proc = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "promote",
            "--report",
            str(report_path),
            "--release-root",
            str(release_root),
            "--adapter-path",
            str(adapter),
            "--label",
            "candidate-manual",
        ],
        capture_output=True,
        text=True,
        check=True,
    )

    payload = json.loads(proc.stdout)
    assert payload["source_phase"] == "manual"
    assert payload["overall_score"] == 89.0
    assert Path(payload["score_path"]).exists()
    assert Path(payload["decision_output_path"]).exists()
