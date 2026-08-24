"""Contract tests for the trajectory-collection planner and its manifest.

Deterministic and offline: every case drives ``collect_trajectories.main`` in
dry-run or validation-blocked mode and asserts against the manifest written
under ``tmp_path``, so no suite, provider, model, or judge is ever invoked.
"""

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
    assert manifest["schema"] == "eliza.trajectory_collection_manifest.v1"
    assert manifest["version"] == 1
    assert manifest["run_id"] == run_id
    assert manifest["run"]["dryRun"] is True
    assert manifest["provider_label"] == "cerebras-dev"
    assert manifest["provider_model"] == "dev-model"
    assert manifest["suites"] == ["live-scenarios", "scenario-runner"]
    assert manifest["cost_caps"]["max_cost_usd"] == 1.25
    assert manifest["costCaps"]["maxCostUsd"] == 1.25
    assert manifest["cost_caps"]["effective_max_cost_usd_by_suite"] == {
        "live-scenarios": None,
        "scenario-benchmark": None,
        "scenario-runner": None,
    }
    assert manifest["cost_caps"]["recorded_only_for_suites"] == [
        "live-scenarios",
        "scenario-runner",
    ]
    assert manifest["costCaps"]["scenarioRunnerEnforced"] is False
    assert manifest["generated_at"]
    assert "git" in manifest
    assert "worktree" in manifest
    assert manifest["provider"]["activeLabel"] == "cerebras-dev"
    assert manifest["provider"]["activeModel"] == "dev-model"
    assert "opus-placeholder" in manifest["provider"]["labels"]
    assert "openai-placeholder" in manifest["provider"]["labels"]

    commands = {command["suite"]: command for command in manifest["commands"]}
    live = commands["live-scenarios"]
    assert "packages/scripts/run-live-scenarios.mjs" in live["command"]
    assert "--run-dir" in live["command"]
    assert live["env_overrides"]["SCENARIO_FILTER"] == "scenario-a,scenario-b"
    assert "CEREBRAS_API_KEY" in live["env_requirements"][0]["one_of"]
    assert any(output["kind"] == "raw_trajectories_dir" for output in live["expected_outputs"])

    runner = commands["scenario-runner"]
    assert "packages/scenario-runner/src/cli.ts" in runner["command"]
    scenario_flag = runner["command"].index("--scenario")
    assert runner["command"][scenario_flag + 1] == "scenario-a,scenario-b"
    assert runner["env_overrides"]["CEREBRAS_MODEL"] == "dev-model"
    assert runner["env_overrides"]["ELIZA_COLLECTION_MAX_COST_USD"] == "1.25"
    assert runner["supports_cost_cap"] is False


def test_default_scenario_root_exists_in_the_repository(tmp_path):
    run_id = "default-scenario-root"
    code = c.main(
        [
            "--dry-run",
            "--suites",
            "scenario-runner",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
        ]
    )

    assert code == 0
    scenario_root = c.REPO_ROOT / c.DEFAULT_SCENARIO_ROOT
    assert scenario_root.is_dir()
    assert any(scenario_root.rglob("*.scenario.ts"))
    command = _manifest(tmp_path, run_id)["commands"][0]["command"]
    assert str(scenario_root) in command


def test_planned_scripts_and_owned_files_exist_in_the_repository(tmp_path):
    run_id = "planned-script-paths"
    code = c.main(
        [
            "--dry-run",
            "--suites",
            "live-scenarios,scenario-benchmark,scenario-runner",
            "--run-id",
            run_id,
            "--output-dir",
            str(tmp_path),
        ]
    )

    assert code == 0
    manifest = _manifest(tmp_path, run_id)
    assert {command["suite"] for command in manifest["commands"]} == c.SUITE_CHOICES

    planned: set[str] = set()
    for command in manifest["commands"]:
        planned.add(command["label"])
        planned.update(
            argument
            for argument in command["command"]
            if argument.endswith((".mjs", ".ts", ".py"))
            and not Path(argument).is_absolute()
        )

    assert planned == {
        "packages/scripts/run-live-scenarios.mjs",
        "packages/scripts/run-scenario-benchmark.mjs",
        "packages/scenario-runner/src/cli.ts",
    }
    for relative in sorted(planned):
        assert (c.REPO_ROOT / relative).is_file(), relative
    for relative in c.OWNED_FILES:
        assert (c.REPO_ROOT / relative).is_file(), relative


def test_manifest_exposes_downstream_prepare_inputs(tmp_path):
    run_id = "prepare-handoff"
    code = c.main(
        [
            "--dry-run",
            "--provider",
            "env",
            "--suites",
            "live-scenarios,scenario-runner",
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
        ("scenario-runner", "raw_trajectories_dir"),
    }

    prepare = manifest["downstream_inputs"]["prepare_eliza1_trajectory_dataset"]
    assert prepare["schema"] == "eliza.prepare_eliza1_trajectory_dataset.inputs.v1"
    assert Path(prepare["script"]).as_posix().endswith(
        "packages/training/scripts/prepare_eliza1_trajectory_dataset.py"
    )
    assert Path(prepare["collection_manifest"]).as_posix().endswith(
        f"{run_id}/{c.MANIFEST_NAME}"
    )
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
    assert prepare["input_paths"] == [native_export_path]
    assert prepare["pending_input_paths"] == [native_export_path]
    assert "ready_input_paths" not in prepare
    assert prepare["source_raw_trajectory_paths"] == [
        str(tmp_path / run_id / "trajectories")
    ]
    assert Path(prepare["output_dir"]).as_posix().endswith(
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
            "scenario-runner",
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
    assert "ELIZA_COLLECTION_MAX_COST_USD" not in command["env_overrides"]
    assert command["env_requirements"][0]["one_of"] == list(c.LIVE_PROVIDER_KEYS)
    assert manifest["cost_caps"]["max_cost_usd"] is None
    assert manifest["cost_caps"]["recorded_only_for_suites"] == ["scenario-runner"]
    assert all(
        effective is None
        for effective in manifest["cost_caps"][
            "effective_max_cost_usd_by_suite"
        ].values()
    )


def test_removed_lifeops_bench_suite_is_rejected(tmp_path):
    run_id = "retired-suite"
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
    assert manifest["validationErrors"] == ["unknown suite(s): lifeops-bench"]
    assert manifest["commands"] == []
    assert set(manifest["cost_caps"]["effective_max_cost_usd_by_suite"]) == set(
        c.SUITE_CHOICES
    )
    assert set(manifest["cost_caps"]["enforced_by_suite"]) == set(c.SUITE_CHOICES)
    assert "lifeopsBenchEffectiveMaxCostUsd" not in manifest["costCaps"]
    assert "lifeopsBenchEnforced" not in manifest["costCaps"]
    prepare = manifest["downstream_inputs"]["prepare_eliza1_trajectory_dataset"]
    assert "ready_input_paths" not in prepare
    assert "lifeops" not in json.dumps(manifest["expected_outputs"]).lower()


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
            "scenario-runner",
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
            "scenario-runner",
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
            "scenario-runner",
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
            "scenario-runner",
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
