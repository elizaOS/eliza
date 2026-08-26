"""Exercises the trajectory collector's executable planning boundaries."""

from __future__ import annotations

import json
from pathlib import Path

import collect_trajectories as c


def _manifest(path: Path, run_id: str) -> dict:
    return json.loads((path / run_id / c.MANIFEST_NAME).read_text(encoding="utf-8"))


def _clear_opus_env(monkeypatch) -> None:
    for key in c.OPUS_MODEL_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def test_dry_run_plans_only_current_scenario_entry_points(tmp_path: Path) -> None:
    run_id = "unit-dry-run"
    code = c.main(
        [
            "--dry-run",
            "--provider",
            "cerebras-dev",
            "--model",
            "dev-model",
            "--suites",
            "live-scenarios,scenario-runner",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
            "--max-cost-usd",
            "1.25",
            "--scenario-filter",
            "scenario-a,scenario-b",
        ]
    )

    assert code == 0
    manifest = _manifest(tmp_path, run_id)
    commands = {command["suite"]: command for command in manifest["commands"]}
    assert set(commands) == {"live-scenarios", "scenario-runner"}
    assert commands["live-scenarios"]["env_overrides"]["SCENARIO_FILTER"] == (
        "scenario-a,scenario-b"
    )
    assert commands["scenario-runner"]["command"][0:4] == [
        "bun",
        "--bun",
        "packages/scenario-runner/src/cli.ts",
        "run",
    ]
    assert all(command["supports_cost_cap"] is False for command in commands.values())
    assert manifest["cost_caps"]["max_cost_usd"] == 1.25
    assert manifest["cost_caps"]["recorded_only_for_suites"] == [
        "live-scenarios",
        "scenario-runner",
    ]


def test_manifest_handoff_requires_native_export_before_training(
    tmp_path: Path,
) -> None:
    run_id = "prepare-handoff"
    code = c.main(
        [
            "--dry-run",
            "--provider",
            "env",
            "--suites",
            "live-scenarios",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
        ]
    )

    assert code == 0
    manifest = _manifest(tmp_path, run_id)
    prepare = manifest["downstream_inputs"]["prepare_eliza1_trajectory_dataset"]
    native_export_path = str(tmp_path / run_id / "exports" / c.NATIVE_EXPORT_FILENAME)
    assert prepare["ready_input_paths"] == []
    assert prepare["pending_input_paths"] == [native_export_path]
    assert prepare["input_paths"] == [native_export_path]
    assert native_export_path in prepare["command"]
    assert "--strict-privacy" in prepare["command"]


def test_removed_lifeops_suite_is_rejected_without_planning_a_command(
    tmp_path: Path,
) -> None:
    run_id = "removed-suite"
    code = c.main(
        [
            "--dry-run",
            "--suites",
            "lifeops-bench",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
        ]
    )

    assert code == 2
    manifest = _manifest(tmp_path, run_id)
    assert manifest["commands"] == []
    assert manifest["validationErrors"] == ["unknown suite(s): lifeops-bench"]


def test_non_dry_run_refuses_opus_model_before_execution(
    tmp_path: Path, monkeypatch
) -> None:
    _clear_opus_env(monkeypatch)
    run_id = "opus-blocked"
    code = c.main(
        [
            "--execute",
            "--provider",
            "anthropic",
            "--model",
            "claude-opus-4-7",
            "--suites",
            "live-scenarios",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
        ]
    )

    assert code == 2
    manifest = _manifest(tmp_path, run_id)
    assert "refusing to execute Opus" in " ".join(manifest["validationErrors"])
    assert manifest["commands"][0]["status"] == "blocked"


def test_non_dry_run_blocks_opus_model_from_environment(
    tmp_path: Path, monkeypatch
) -> None:
    _clear_opus_env(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_LARGE_MODEL", "claude-opus-4-7")
    run_id = "opus-env-blocked"
    code = c.main(
        [
            "--execute",
            "--provider",
            "env",
            "--suites",
            "live-scenarios",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
        ]
    )

    assert code == 2
    manifest = _manifest(tmp_path, run_id)
    assert "ANTHROPIC_LARGE_MODEL" in " ".join(manifest["validationErrors"])


def test_non_dry_run_rejects_non_positive_accounting_cap(
    tmp_path: Path, monkeypatch
) -> None:
    _clear_opus_env(monkeypatch)
    run_id = "bad-cost-cap"
    code = c.main(
        [
            "--execute",
            "--provider",
            "env",
            "--suites",
            "live-scenarios",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
            "--max-cost-usd",
            "0",
        ]
    )

    assert code == 2
    assert _manifest(tmp_path, run_id)["validationErrors"] == [
        "--max-cost-usd must be greater than 0"
    ]


def test_non_dry_run_requires_explicit_anthropic_model(
    tmp_path: Path, monkeypatch
) -> None:
    _clear_opus_env(monkeypatch)
    run_id = "anthropic-needs-model"
    code = c.main(
        [
            "--execute",
            "--provider",
            "anthropic",
            "--suites",
            "live-scenarios",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
        ]
    )

    assert code == 2
    assert _manifest(tmp_path, run_id)["validationErrors"] == [
        "provider label 'anthropic' requires --model to avoid an Opus default"
    ]
