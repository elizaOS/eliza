"""Verify collection planning for the repository's supported scenario suites."""

from __future__ import annotations

import json
from pathlib import Path

import collect_trajectories as c


def _manifest(path: Path, run_id: str) -> dict:
    return json.loads((path / run_id / c.MANIFEST_NAME).read_text(encoding="utf-8"))


def _clear_opus_env(monkeypatch) -> None:
    for key in c.OPUS_MODEL_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def test_dry_run_manifest_records_supported_commands_and_outputs(tmp_path):
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
            "--scenario-filter",
            "scenario-a,scenario-b",
        ]
    )

    assert code == 0
    manifest = _manifest(tmp_path, run_id)
    assert manifest["schema"] == c.MANIFEST_SCHEMA
    assert manifest["version"] == c.MANIFEST_VERSION
    assert manifest["run"]["dryRun"] is True
    assert manifest["provider_label"] == "cerebras-dev"
    assert manifest["provider_model"] == "dev-model"
    assert manifest["provider"]["activeLabel"] == "cerebras-dev"
    assert "env" in manifest["provider"]["labels"]
    assert manifest["generated_at"]
    assert "git" in manifest and "worktree" in manifest
    assert manifest["suites"] == ["live-scenarios", "scenario-runner"]
    commands = {command["suite"]: command for command in manifest["commands"]}
    assert "scripts/run-live-scenarios.mjs" in commands["live-scenarios"]["command"]
    assert "packages/scenario-runner/src/cli.ts" in commands["scenario-runner"]["command"]
    assert commands["live-scenarios"]["env_overrides"]["CEREBRAS_MODEL"] == "dev-model"
    assert all(
        any(output["kind"] == "raw_trajectories_dir" for output in command["expected_outputs"])
        for command in commands.values()
    )


def test_manifest_exposes_native_export_as_prepare_input(tmp_path):
    run_id = "prepare-handoff"
    assert c.main(
        [
            "--dry-run",
            "--suites",
            "live-scenarios",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
        ]
    ) == 0

    manifest = _manifest(tmp_path, run_id)
    native_export = str(tmp_path / run_id / "exports" / c.NATIVE_EXPORT_FILENAME)
    prepare = manifest["downstream_inputs"]["prepare_eliza1_trajectory_dataset"]
    assert prepare["input_paths"] == [native_export]
    assert prepare["ready_input_paths"] == []
    assert prepare["pending_input_paths"] == [native_export]
    assert "--strict-privacy" in prepare["command"]


def test_lifeops_bench_suite_is_rejected(tmp_path):
    run_id = "removed-suite"
    assert c.main(
        [
            "--dry-run",
            "--suites",
            "lifeops-bench",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
        ]
    ) == 2
    assert _manifest(tmp_path, run_id)["validationErrors"] == [
        "unknown suite(s): lifeops-bench"
    ]


def test_help_does_not_advertise_removed_lifeops_capability():
    help_text = c.build_parser().format_help().lower()
    assert "lifeops" not in help_text
    assert "scenario-runner" in help_text


def test_scenario_runner_default_points_to_owned_fixture_directory():
    args = c.build_parser().parse_args([])
    assert args.scenario_root == "packages/scenario-runner/test/scenarios"


def test_non_dry_run_refuses_opus_model_before_execution(tmp_path, monkeypatch):
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
    assert manifest["validationErrors"] == [
        "refusing to execute Opus; use dry-run for Opus labels only"
    ]
    assert manifest["commands"][0]["status"] == "blocked"


def test_non_dry_run_blocks_opus_model_from_environment(tmp_path, monkeypatch):
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
    assert _manifest(tmp_path, run_id)["validationErrors"] == [
        "refusing to execute Opus from environment: ANTHROPIC_LARGE_MODEL"
    ]


def test_non_dry_run_requires_explicit_anthropic_model(tmp_path, monkeypatch):
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


def test_unknown_suite_is_reported_in_manifest(tmp_path):
    run_id = "unknown-suite"
    code = c.main(
        [
            "--dry-run",
            "--suites",
            "live-scenarios,unknown",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
        ]
    )
    assert code == 2
    manifest = _manifest(tmp_path, run_id)
    assert manifest["validationErrors"] == ["unknown suite(s): unknown"]
    assert manifest["commands"][0]["status"] == "blocked"
