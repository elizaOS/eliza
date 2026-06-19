from __future__ import annotations

import json
from pathlib import Path

import collect_trajectories as c


def _manifest(path: Path, run_id: str) -> dict:
    return json.loads((path / run_id / c.MANIFEST_NAME).read_text(encoding="utf-8"))


def _clear_opus_env(monkeypatch) -> None:
    for key in c.OPUS_MODEL_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def test_dry_run_manifest_records_commands_outputs_and_provider_labels(tmp_path):
    run_id = "unit-dry-run"
    code = c.main(
        [
            "--dry-run",
            "--provider",
            "cerebras-dev",
            "--model",
            "dev-model",
            "--suites",
            "live-scenarios,lifeops-bench",
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
    assert manifest["schema"] == "eliza.trajectory_collection_manifest.v1"
    assert manifest["version"] == 1
    assert manifest["run_id"] == run_id
    assert manifest["run"]["dryRun"] is True
    assert manifest["provider_label"] == "cerebras-dev"
    assert manifest["provider_model"] == "dev-model"
    assert manifest["suites"] == ["live-scenarios", "lifeops-bench"]
    assert manifest["cost_caps"]["max_cost_usd"] == 1.25
    assert manifest["cost_caps"]["effective_max_cost_usd_by_suite"][
        "lifeops-bench"
    ] == 1.25
    assert manifest["costCaps"]["lifeopsBenchEffectiveMaxCostUsd"] == 1.25
    assert manifest["generated_at"]
    assert "git" in manifest
    assert "worktree" in manifest
    assert manifest["provider"]["activeLabel"] == "cerebras-dev"
    assert manifest["provider"]["activeModel"] == "dev-model"
    assert "opus-placeholder" in manifest["provider"]["labels"]
    assert "openai-placeholder" in manifest["provider"]["labels"]

    commands = {command["suite"]: command for command in manifest["commands"]}
    live = commands["live-scenarios"]
    assert "scripts/run-live-scenarios.mjs" in live["command"]
    assert "--run-dir" in live["command"]
    assert live["env_overrides"]["SCENARIO_FILTER"] == "scenario-a,scenario-b"
    assert "CEREBRAS_API_KEY" in live["env_requirements"][0]["one_of"]
    assert any(output["kind"] == "raw_trajectories_dir" for output in live["expected_outputs"])

    bench = commands["lifeops-bench"]
    assert "--max-cost-usd" in bench["command"]
    assert "1.25" in bench["command"]
    assert bench["env_overrides"]["CEREBRAS_MODEL"] == "dev-model"


def test_manifest_exposes_downstream_prepare_inputs(tmp_path):
    run_id = "prepare-handoff"
    code = c.main(
        [
            "--dry-run",
            "--provider",
            "env",
            "--suites",
            "live-scenarios,lifeops-bench",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
        ]
    )

    assert code == 0
    manifest = _manifest(tmp_path, run_id)
    expected_outputs = manifest["expected_outputs"]
    assert {
        (output["suite"], output["kind"]) for output in expected_outputs
    } >= {
        ("live-scenarios", "raw_trajectories_dir"),
        ("lifeops-bench", "lifeops_bench_results_dir"),
    }

    prepare = manifest["downstream_inputs"]["prepare_eliza1_trajectory_dataset"]
    assert prepare["schema"] == "eliza.prepare_eliza1_trajectory_dataset.inputs.v1"
    assert prepare["script"].endswith(
        "packages/training/scripts/prepare_eliza1_trajectory_dataset.py"
    )
    assert prepare["collection_manifest"].endswith(f"{run_id}/{c.MANIFEST_NAME}")
    app_export = manifest["downstream_inputs"]["app_trajectory_export"]
    native_export_path = str(tmp_path / run_id / "exports" / c.NATIVE_EXPORT_FILENAME)
    assert app_export["endpoint"] == "/api/trajectories/export"
    assert app_export["request_body"] == {
        "format": "jsonl",
        "includePrompts": True,
        "jsonShape": "eliza_native_v1",
    }
    assert app_export["suggested_output_path"] == native_export_path
    assert app_export["source_raw_trajectory_paths"] == [
        str(tmp_path / run_id / "trajectories")
    ]
    assert prepare["input_paths"] == [
        native_export_path,
        str(tmp_path / run_id / "lifeops-bench"),
    ]
    assert prepare["ready_input_paths"] == [str(tmp_path / run_id / "lifeops-bench")]
    assert prepare["pending_input_paths"] == [native_export_path]
    assert prepare["source_raw_trajectory_paths"] == [
        str(tmp_path / run_id / "trajectories")
    ]
    assert prepare["output_dir"].endswith(
        f"packages/training/data/trajectory-runs/{run_id}"
    )
    assert "--strict-privacy" in prepare["command"]
    for input_path in prepare["input_paths"]:
        assert input_path in prepare["command"]


def test_cerebras_dev_without_model_does_not_pin_gpt_oss_default(tmp_path):
    run_id = "no-pin"
    code = c.main(
        [
            "--dry-run",
            "--provider",
            "cerebras-dev",
            "--suites",
            "lifeops-bench",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
        ]
    )

    assert code == 0
    manifest = _manifest(tmp_path, run_id)
    assert manifest["run"]["dryRun"] is True
    assert manifest["provider_model"] is None
    assert manifest["provider"]["activeModel"] is None
    command = manifest["commands"][0]
    joined = " ".join(command["command"])
    assert "gpt-oss-120b" not in joined
    manifest_without_repo_state = {
        key: value for key, value in manifest.items() if key not in {"git", "worktree"}
    }
    assert "gpt-oss-120b" not in json.dumps(manifest_without_repo_state)
    assert "CEREBRAS_MODEL" not in command["env_overrides"]
    assert command["env_requirements"] == []
    assert "configured-by-collector" in command["command"]
    assert manifest["cost_caps"]["max_cost_usd"] is None
    assert manifest["cost_caps"]["effective_max_cost_usd_by_suite"][
        "lifeops-bench"
    ] == c.DEFAULT_LIFEOPS_MAX_COST_USD
    assert str(c.DEFAULT_LIFEOPS_MAX_COST_USD).rstrip("0").rstrip(".") in command[
        "command"
    ]


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
            "lifeops-bench",
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
    assert manifest["commands"][0]["exit_code"] == 2


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
            "lifeops-bench",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
        ]
    )

    assert code == 2
    manifest = _manifest(tmp_path, run_id)
    assert manifest["validationErrors"] == [
        "refusing to execute Opus from environment: ANTHROPIC_LARGE_MODEL"
    ]
    assert manifest["commands"][0]["status"] == "blocked"


def test_non_dry_run_rejects_non_positive_cost_cap(tmp_path, monkeypatch):
    _clear_opus_env(monkeypatch)
    run_id = "bad-cost-cap"
    code = c.main(
        [
            "--execute",
            "--provider",
            "env",
            "--suites",
            "lifeops-bench",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
            "--max-cost-usd",
            "0",
        ]
    )

    assert code == 2
    manifest = _manifest(tmp_path, run_id)
    assert manifest["validationErrors"] == ["--max-cost-usd must be greater than 0"]
    assert manifest["commands"][0]["status"] == "blocked"


def test_non_dry_run_requires_explicit_anthropic_model(tmp_path, monkeypatch):
    _clear_opus_env(monkeypatch)
    run_id = "anthropic-needs-model"
    code = c.main(
        [
            "--execute",
            "--provider",
            "anthropic",
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
    assert manifest["validationErrors"] == [
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
