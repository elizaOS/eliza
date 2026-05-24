"""Tests for the rlsecd external acceptance specification."""

from __future__ import annotations

import json
from pathlib import Path
from types import ModuleType
from typing import Any

from conftest import load_script

REPO_ROOT = Path(__file__).resolve().parents[1]
_SPEC_PATH = REPO_ROOT / "benchmarks" / "rlsecd_external_acceptance_spec.py"
_VALIDATOR_PATH = REPO_ROOT / "benchmarks" / "rlsecd_external_acceptance_validate.py"


def load_spec_module() -> ModuleType:
    return load_script(_SPEC_PATH, "rlsecd_external_acceptance_spec")


def load_validator_module() -> ModuleType:
    return load_script(_VALIDATOR_PATH, "rlsecd_external_acceptance_validate")


def unchecked_external_todos() -> list[str]:
    """Return unchecked external TODO text from the current project file."""
    todos: list[str] = []
    for line in (REPO_ROOT / "TODO.md").read_text(encoding="utf-8").splitlines():
        if line.startswith("- [ ] External:"):
            todos.append(line.removeprefix("- [ ] "))
    return todos


def test_acceptance_spec_covers_all_unchecked_external_todos() -> None:
    module = load_spec_module()
    spec = module.build_spec()
    spec_todos = [item["todo_text"] for item in spec["items"]]

    assert spec["schema"] == "alberta.rlsecd_external_acceptance_spec.v1"
    assert spec["status"] == "pending_external_repositories"
    assert spec_todos == unchecked_external_todos()


def test_each_acceptance_item_has_executable_proof_shape() -> None:
    module = load_spec_module()
    spec = module.build_spec()

    assert len(spec["items"]) == 8
    for item in spec["items"]:
        assert item["claim_scope"]
        assert item["required_repositories"]
        assert item["command_template"][0] == "python"
        assert item["required_artifacts"]
        assert item["required_metrics"]
        assert item["pass_conditions"]


def test_acceptance_spec_cli_writes_json_and_markdown(tmp_path: Path) -> None:
    module = load_spec_module()
    json_path = tmp_path / "spec.json"
    markdown_path = tmp_path / "spec.md"

    rendered = json.dumps(module.build_spec(), indent=2, sort_keys=True)
    json_path.write_text(rendered + "\n", encoding="utf-8")
    markdown_path.write_text(
        module.render_markdown(module.build_spec()),
        encoding="utf-8",
    )

    loaded = json.loads(json_path.read_text(encoding="utf-8"))
    markdown = markdown_path.read_text(encoding="utf-8")

    assert loaded["claim_scope"] == "remaining_external_alberta_plan_work"
    assert "# rlsecd External Acceptance Spec" in markdown
    assert "rlsecd_gym_control_horde_sarsa_daemon" in markdown


def write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write JSON after creating parents."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    """Write JSONL after creating parents."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(row) for row in rows) + "\n",
        encoding="utf-8",
    )


def write_complete_external_artifacts(root: Path) -> None:
    """Write a minimal passing external artifact set."""
    write_json(
        root / "outputs/rlsecd_gym_control/metrics.json",
        {
            "n_prediction_demons": 5,
            "n_control_actions": 6,
            "n_transitions": 1,
            "mean_reward": 1.0,
            "sarsa_td_error_final_window": 0.1,
            "uses_framework_sarsa_agent": True,
            "uses_framework_horde_learner": True,
        },
    )
    write_json(
        root / "outputs/rlsecd_gym_control/config.json",
        {
            "control_agent": "sarsa",
            "n_prediction_demons": 5,
            "n_control_actions": 6,
            "action_names": [
                "pass",
                "alert",
                "throttle",
                "block_source",
                "unblock",
                "isolate",
            ],
            "temporal_uniformity": True,
            "uses_framework_sarsa_agent": True,
            "uses_framework_horde_learner": True,
        },
    )
    write_jsonl(
        root / "outputs/rlsecd_gym_control/rollouts.jsonl",
        [
            {
                "step": 0,
                "state": [0.0],
                "action": 3,
                "reward": 1.0,
                "next_state": [1.0],
                "terminated": False,
                "policy_metadata": {"epsilon": 0.05},
            }
        ],
    )
    write_json(
        root / "outputs/rlsecd_throughput/metrics.json",
        {
            "n_events": 10,
            "events_per_second": 10.0,
            "wall_clock_s": 1.0,
            "parse_ms_p50": 1.0,
            "feature_ms_p50": 1.0,
            "learner_update_ms_p50": 1.0,
            "checkpoint_reporting_ms_p50": 1.0,
            "action_dispatch_ms_p50": 1.0,
            "stage_event_counts": {
                "parse": 10,
                "feature": 10,
                "learner_update": 10,
                "checkpoint_reporting": 10,
                "action_dispatch": 10,
            },
            "measured_real_daemon_path": True,
        },
    )
    write_json(
        root / "outputs/rlsecd_oracle_experience/manifest.json",
        {
            "n_records": 1,
            "schema": "rlsecd.oracle_experience.v1",
            "source_rollout_log": "outputs/rlsecd_gym_control/rollouts.jsonl",
            "source_rollout_record_count": 1,
            "exported_from_production_rollout": True,
        },
    )
    write_jsonl(
        root / "outputs/rlsecd_oracle_experience/records.jsonl",
        [
            {
                "state": [0.0],
                "action": 3,
                "reward": 1.0,
                "outcome": "blocked",
                "source_rollout_step": 0,
                "policy_metadata": {"epsilon": 0.05},
            }
        ],
    )
    (root / "outputs/idbd_mlp_100k/checkpoint").mkdir(parents=True)
    write_json(
        root / "outputs/idbd_mlp_100k/metrics.json",
        {
            "n_events": 100000,
            "final_window_loss": 0.1,
            "all_finite": True,
            "finite_components": {
                "predictions": True,
                "parameters": True,
                "traces": True,
                "step_sizes": True,
            },
            "mean_step_size": 0.01,
            "validation_batch_size": 8,
            "checkpoint_roundtrip_max_abs_diff": 0.0,
        },
    )
    (root / "outputs/idbd_mlp_1_6m/checkpoints").mkdir(parents=True)
    write_json(
        root / "outputs/idbd_mlp_1_6m/metrics.json",
        {
            "n_events": 1600000,
            "resumed_from_midpoint": True,
            "all_finite": True,
            "finite_components": {
                "predictions": True,
                "parameters": True,
                "traces": True,
                "step_sizes": True,
            },
            "events_per_second": 100.0,
            "max_rss_mb": 512.0,
            "final_window_loss": 0.1,
            "checkpoint_count": 2,
            "resume_final_loss_abs_diff": 0.0,
        },
    )
    (root / "outputs/rlsecd_checkpoint_v2").mkdir(parents=True)
    write_json(
        root / "outputs/rlsecd_checkpoint_v2/metrics.json",
        {
            "format_version": 2,
            "metadata_present": True,
            "learner_state_present": True,
            "optimizer_state_present": True,
            "normalizer_state_present": True,
            "restored_step_count_matches": True,
            "prediction_roundtrip_max_abs_diff": 0.0,
        },
    )
    write_json(
        root / "outputs/rlsecd_checkpoint_v2/metadata.json",
        {
            "schema": "alberta.rlsecd.security_agent_checkpoint.v2",
            "framework_checkpoint_schema": "alberta.framework.checkpoint.v1",
        },
    )
    write_json(
        root / "outputs/rlsecd_config_roundtrip/metrics.json",
        {
            "learner_config_roundtrip": True,
            "optimizer_config_roundtrip": True,
            "normalizer_config_roundtrip": True,
            "feature_schema_roundtrip": True,
            "security_agent_config_roundtrip": True,
            "serialized_component_types": {
                "learner": "HordeLearner",
                "optimizer": "IDBD",
                "normalizer": "EMANormalizer",
                "feature_schema": "SecurityFeatureSchema",
            },
            "unknown_config_keys": [],
            "dropped_config_keys": [],
            "restored_schema_version_matches": True,
            "prediction_roundtrip_max_abs_diff": 0.0,
        },
    )
    write_jsonl(
        root / "outputs/rlsecd_feature_relevance/metrics.jsonl",
        [
            {
                "feature_relevance_report_count": 2,
                "feature_relevance_interval_s": 60,
                "report_timestamp_s": 0.0,
                "top_feature_names": ["failed_login_rate"],
                "top_feature_relevance_values": [0.25],
                "report_nonblocking": True,
                "learner_updates_skipped_for_reporting": 0,
                "uses_framework_compute_feature_relevance": True,
                "latest_report_latency_ms": 1.0,
            },
            {
                "feature_relevance_report_count": 2,
                "feature_relevance_interval_s": 60,
                "report_timestamp_s": 60.0,
                "top_feature_names": ["failed_login_rate"],
                "top_feature_relevance_values": [0.3],
                "report_nonblocking": True,
                "learner_updates_skipped_for_reporting": 0,
                "uses_framework_compute_feature_relevance": True,
                "latest_report_latency_ms": 1.2,
            }
        ],
    )


def test_acceptance_validator_rejects_missing_artifacts(tmp_path: Path) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")

    status = validator.validate(spec_path, tmp_path)

    assert status["accepted"] is False
    assert status["n_items"] == 8
    assert status["n_passed"] == 0
    assert status["items"][0]["missing_artifacts"]


def test_current_validator_failures_match_unchecked_external_todos(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")

    status = validator.validate(spec_path, REPO_ROOT)
    failed_todos = [item["todo_text"] for item in status["items"] if not item["passed"]]

    assert status["schema"] == "alberta.rlsecd_external_acceptance_status.v1"
    assert status["n_items"] == len(unchecked_external_todos())
    assert failed_todos == unchecked_external_todos()
    assert status["accepted"] is False


def test_acceptance_validator_accepts_complete_artifact_set(tmp_path: Path) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)

    status = validator.validate(spec_path, tmp_path)

    assert status["accepted"] is True
    assert status["n_items"] == 8
    assert status["n_passed"] == 8
    assert all(item["passed"] for item in status["items"])


def test_acceptance_validator_rejects_incomplete_rollout_semantics(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_jsonl(
        tmp_path / "outputs/rlsecd_gym_control/rollouts.jsonl",
        [
            {
                "step": 0,
                "state": [0.0],
                "action": 99,
                "reward": 1.0,
                "next_state": [1.0],
                "terminated": False,
                "policy_metadata": {},
            }
        ],
    )

    status = validator.validate(spec_path, tmp_path)

    first_item = status["items"][0]
    assert status["accepted"] is False
    assert first_item["claim_scope"] == "rlsecd_gym_control_horde_sarsa_daemon"
    assert first_item["condition_passed"] is False


def test_acceptance_validator_rejects_duplicate_rollout_steps(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_jsonl(
        tmp_path / "outputs/rlsecd_gym_control/rollouts.jsonl",
        [
            {
                "step": 0,
                "state": [0.0],
                "action": 1,
                "reward": 0.0,
                "next_state": [1.0],
                "terminated": False,
                "policy_metadata": {},
            },
            {
                "step": 0,
                "state": [1.0],
                "action": 2,
                "reward": 1.0,
                "next_state": [2.0],
                "terminated": False,
                "policy_metadata": {},
            },
        ],
    )

    status = validator.validate(spec_path, tmp_path)

    first_item = status["items"][0]
    assert status["accepted"] is False
    assert first_item["condition_message"] == "rollout rows contain duplicate step ids"


def test_acceptance_validator_rejects_incomplete_rollout_transition(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_jsonl(
        tmp_path / "outputs/rlsecd_gym_control/rollouts.jsonl",
        [{"step": 0, "state": [0.0], "action": 1, "reward": 0.0}],
    )

    status = validator.validate(spec_path, tmp_path)

    first_item = status["items"][0]
    assert status["accepted"] is False
    assert first_item["condition_message"] == "rollout rows are missing transition fields"


def test_acceptance_validator_rejects_empty_gym_control_config(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(tmp_path / "outputs/rlsecd_gym_control/config.json", {"ok": True})

    status = validator.validate(spec_path, tmp_path)

    first_item = status["items"][0]
    assert status["accepted"] is False
    assert first_item["condition_message"] == (
        "gym-control config does not declare SARSA control"
    )


def test_acceptance_validator_rejects_wrong_security_gym_action_names(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_gym_control/config.json",
        {
            "control_agent": "sarsa",
            "n_prediction_demons": 5,
            "n_control_actions": 6,
            "action_names": ["pass", "alert", "throttle", "block", "unblock", "isolate"],
            "temporal_uniformity": True,
            "uses_framework_sarsa_agent": True,
            "uses_framework_horde_learner": True,
        },
    )

    status = validator.validate(spec_path, tmp_path)

    first_item = status["items"][0]
    assert status["accepted"] is False
    assert first_item["condition_message"] == (
        "gym-control config action_names do not match security-gym"
    )


def test_acceptance_validator_rejects_nonfinite_rollout_transition_values(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_jsonl(
        tmp_path / "outputs/rlsecd_gym_control/rollouts.jsonl",
        [
            {
                "step": 0,
                "state": [0.0],
                "action": 1,
                "reward": "1.0",
                "next_state": [1.0],
                "terminated": False,
                "policy_metadata": {},
            }
        ],
    )

    status = validator.validate(spec_path, tmp_path)
    first_item = status["items"][0]

    assert status["accepted"] is False
    assert first_item["condition_message"] == (
        "rollout rows have malformed transition payloads"
    )


def test_acceptance_validator_rejects_gym_control_transition_count_mismatch(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_gym_control/metrics.json",
        {
            "n_prediction_demons": 5,
            "n_control_actions": 6,
            "n_transitions": 2,
            "mean_reward": 1.0,
            "sarsa_td_error_final_window": 0.1,
            "uses_framework_sarsa_agent": True,
            "uses_framework_horde_learner": True,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    first_item = status["items"][0]

    assert status["accepted"] is False
    assert first_item["condition_message"] == (
        "gym-control n_transitions does not match rollout rows"
    )


def test_acceptance_validator_rejects_gym_control_without_framework_usage(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_gym_control/config.json",
        {
            "control_agent": "sarsa",
            "n_prediction_demons": 5,
            "n_control_actions": 6,
            "action_names": [
                "pass",
                "alert",
                "throttle",
                "block_source",
                "unblock",
                "isolate",
            ],
            "temporal_uniformity": True,
            "uses_framework_sarsa_agent": False,
            "uses_framework_horde_learner": True,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    first_item = status["items"][0]

    assert status["accepted"] is False
    assert first_item["condition_message"] == (
        "gym-control config does not prove framework SARSAAgent usage"
    )


def test_acceptance_validator_rejects_nonfinite_or_boolean_numeric_metrics(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_throughput/metrics.json",
        {
            "n_events": 10,
            "events_per_second": True,
            "wall_clock_s": 1.0,
            "parse_ms_p50": 1.0,
            "feature_ms_p50": 1.0,
            "learner_update_ms_p50": 1.0,
            "checkpoint_reporting_ms_p50": 1.0,
            "action_dispatch_ms_p50": 1.0,
            "stage_event_counts": {
                "parse": 10,
                "feature": 10,
                "learner_update": 10,
                "checkpoint_reporting": 10,
                "action_dispatch": 10,
            },
            "measured_real_daemon_path": True,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    throughput_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_end_to_end_daemon_throughput"
    )

    assert status["accepted"] is False
    assert throughput_item["condition_message"] == (
        "events_per_second is not positive and finite"
    )


def test_acceptance_validator_rejects_negative_daemon_stage_timing(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_throughput/metrics.json",
        {
            "n_events": 10,
            "events_per_second": 10.0,
            "wall_clock_s": 1.0,
            "parse_ms_p50": -1.0,
            "feature_ms_p50": 1.0,
            "learner_update_ms_p50": 1.0,
            "checkpoint_reporting_ms_p50": 1.0,
            "action_dispatch_ms_p50": 1.0,
            "stage_event_counts": {
                "parse": 10,
                "feature": 10,
                "learner_update": 10,
                "checkpoint_reporting": 10,
                "action_dispatch": 10,
            },
            "measured_real_daemon_path": True,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    throughput_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_end_to_end_daemon_throughput"
    )

    assert status["accepted"] is False
    assert throughput_item["condition_message"] == (
        "one or more daemon stage timings are negative or non-finite"
    )


def test_acceptance_validator_rejects_missing_throughput_event_count(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_throughput/metrics.json",
        {
            "n_events": True,
            "events_per_second": 10.0,
            "wall_clock_s": 1.0,
            "parse_ms_p50": 1.0,
            "feature_ms_p50": 1.0,
            "learner_update_ms_p50": 1.0,
            "checkpoint_reporting_ms_p50": 1.0,
            "action_dispatch_ms_p50": 1.0,
            "stage_event_counts": {
                "parse": 10,
                "feature": 10,
                "learner_update": 10,
                "checkpoint_reporting": 10,
                "action_dispatch": 10,
            },
            "measured_real_daemon_path": True,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    throughput_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_end_to_end_daemon_throughput"
    )

    assert status["accepted"] is False
    assert throughput_item["condition_message"] == "n_events is not a positive integer"


def test_acceptance_validator_rejects_partial_throughput_stage_counts(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_throughput/metrics.json",
        {
            "n_events": 10,
            "events_per_second": 10.0,
            "wall_clock_s": 1.0,
            "parse_ms_p50": 1.0,
            "feature_ms_p50": 1.0,
            "learner_update_ms_p50": 1.0,
            "checkpoint_reporting_ms_p50": 1.0,
            "action_dispatch_ms_p50": 1.0,
            "stage_event_counts": {
                "parse": 10,
                "feature": 10,
                "learner_update": 9,
                "checkpoint_reporting": 10,
                "action_dispatch": 10,
            },
            "measured_real_daemon_path": True,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    throughput_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_end_to_end_daemon_throughput"
    )

    assert status["accepted"] is False
    assert throughput_item["condition_message"] == (
        "stage_event_counts do not cover every measured event"
    )


def test_acceptance_validator_rejects_inconsistent_throughput_rate(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_throughput/metrics.json",
        {
            "n_events": 10,
            "events_per_second": 100.0,
            "wall_clock_s": 1.0,
            "parse_ms_p50": 1.0,
            "feature_ms_p50": 1.0,
            "learner_update_ms_p50": 1.0,
            "checkpoint_reporting_ms_p50": 1.0,
            "action_dispatch_ms_p50": 1.0,
            "stage_event_counts": {
                "parse": 10,
                "feature": 10,
                "learner_update": 10,
                "checkpoint_reporting": 10,
                "action_dispatch": 10,
            },
            "measured_real_daemon_path": True,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    throughput_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_end_to_end_daemon_throughput"
    )

    assert status["accepted"] is False
    assert throughput_item["condition_message"] == (
        "events_per_second is inconsistent with n_events/wall_clock_s"
    )


def test_acceptance_validator_rejects_oracle_manifest_count_mismatch(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_oracle_experience/manifest.json",
        {
            "n_records": 2,
            "schema": "rlsecd.oracle_experience.v1",
            "source_rollout_log": "outputs/rlsecd_gym_control/rollouts.jsonl",
            "source_rollout_record_count": 1,
            "exported_from_production_rollout": True,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    oracle_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_oracle_experience_export"
    )

    assert status["accepted"] is False
    assert oracle_item["condition_message"] == (
        "oracle manifest n_records does not match records JSONL"
    )


def test_acceptance_validator_rejects_oracle_without_production_provenance(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_oracle_experience/manifest.json",
        {
            "n_records": 1,
            "schema": "rlsecd.oracle_experience.v1",
            "source_rollout_log": "outputs/rlsecd_gym_control/rollouts.jsonl",
            "source_rollout_record_count": 1,
            "exported_from_production_rollout": False,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    oracle_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_oracle_experience_export"
    )

    assert status["accepted"] is False
    assert oracle_item["condition_message"] == (
        "oracle manifest does not prove production rollout provenance"
    )


def test_acceptance_validator_rejects_oracle_records_without_source_steps(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_jsonl(
        tmp_path / "outputs/rlsecd_oracle_experience/records.jsonl",
        [{"state": [0.0], "action": 3, "reward": 1.0, "outcome": "blocked"}],
    )

    status = validator.validate(spec_path, tmp_path)
    oracle_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_oracle_experience_export"
    )

    assert status["accepted"] is False
    assert oracle_item["condition_message"] == (
        "oracle experience rows lack required rollout fields"
    )


def test_acceptance_validator_rejects_oracle_source_count_mismatch(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_oracle_experience/manifest.json",
        {
            "n_records": 1,
            "schema": "rlsecd.oracle_experience.v1",
            "source_rollout_log": "outputs/rlsecd_gym_control/rollouts.jsonl",
            "source_rollout_record_count": 99,
            "exported_from_production_rollout": True,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    oracle_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_oracle_experience_export"
    )

    assert status["accepted"] is False
    assert oracle_item["condition_message"] == (
        "oracle source rollout record count does not match"
    )


def test_acceptance_validator_rejects_incomplete_idbd_finite_components(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/idbd_mlp_100k/metrics.json",
        {
            "n_events": 100000,
            "final_window_loss": 0.1,
            "all_finite": True,
            "finite_components": {
                "predictions": True,
                "parameters": True,
                "traces": True,
                "step_sizes": False,
            },
            "mean_step_size": 0.01,
            "validation_batch_size": 8,
            "checkpoint_roundtrip_max_abs_diff": 0.0,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    replay_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_idbd_mlp_100k_replay"
    )

    assert status["accepted"] is False
    assert replay_item["condition_message"] == (
        "finite_components does not prove every required component"
    )


def test_acceptance_validator_rejects_unverified_full_log_resume_equivalence(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/idbd_mlp_1_6m/metrics.json",
        {
            "n_events": 1600000,
            "resumed_from_midpoint": True,
            "all_finite": True,
            "finite_components": {
                "predictions": True,
                "parameters": True,
                "traces": True,
                "step_sizes": True,
            },
            "events_per_second": 100.0,
            "max_rss_mb": 512.0,
            "final_window_loss": 0.1,
            "checkpoint_count": 2,
            "resume_final_loss_abs_diff": 1e-3,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    replay_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_idbd_mlp_full_log_stability"
    )

    assert status["accepted"] is False
    assert replay_item["condition_message"] == (
        "full-log replay resume equivalence exceeded tolerance"
    )


def test_acceptance_validator_rejects_checkpoint_without_v2_metadata(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_checkpoint_v2/metadata.json",
        {"schema": "rlsecd.checkpoint.v1"},
    )

    status = validator.validate(spec_path, tmp_path)
    checkpoint_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_security_agent_orbax_checkpoint_v2"
    )

    assert status["accepted"] is False
    assert checkpoint_item["condition_message"] == (
        "checkpoint metadata schema is not v2"
    )


def test_acceptance_validator_rejects_checkpoint_missing_restored_state(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_checkpoint_v2/metrics.json",
        {
            "format_version": 2,
            "metadata_present": True,
            "learner_state_present": True,
            "optimizer_state_present": False,
            "normalizer_state_present": True,
            "restored_step_count_matches": True,
            "prediction_roundtrip_max_abs_diff": 0.0,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    checkpoint_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_security_agent_orbax_checkpoint_v2"
    )

    assert status["accepted"] is False
    assert checkpoint_item["condition_message"] == (
        "checkpoint optimizer state was not restored"
    )


def test_acceptance_validator_rejects_config_roundtrip_dropped_keys(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_json(
        tmp_path / "outputs/rlsecd_config_roundtrip/metrics.json",
        {
            "learner_config_roundtrip": True,
            "optimizer_config_roundtrip": True,
            "normalizer_config_roundtrip": True,
            "feature_schema_roundtrip": True,
            "security_agent_config_roundtrip": True,
            "serialized_component_types": {
                "learner": "HordeLearner",
                "optimizer": "IDBD",
                "normalizer": "EMANormalizer",
                "feature_schema": "SecurityFeatureSchema",
            },
            "unknown_config_keys": [],
            "dropped_config_keys": ["normalizer.decay"],
            "restored_schema_version_matches": True,
            "prediction_roundtrip_max_abs_diff": 0.0,
        },
    )

    status = validator.validate(spec_path, tmp_path)
    config_item = next(
        item
        for item in status["items"]
        if item["claim_scope"]
        == "rlsecd_security_agent_framework_config_serialization"
    )

    assert status["accepted"] is False
    assert config_item["condition_message"] == (
        "config roundtrip reported dropped config keys"
    )


def test_acceptance_validator_rejects_feature_relevance_skipped_updates(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_jsonl(
        tmp_path / "outputs/rlsecd_feature_relevance/metrics.jsonl",
        [
            {
                "feature_relevance_report_count": 2,
                "feature_relevance_interval_s": 60,
                "report_timestamp_s": 0.0,
                "top_feature_names": ["failed_login_rate"],
                "top_feature_relevance_values": [0.25],
                "report_nonblocking": True,
                "learner_updates_skipped_for_reporting": 1,
                "uses_framework_compute_feature_relevance": True,
                "latest_report_latency_ms": 1.0,
            },
            {
                "feature_relevance_report_count": 2,
                "feature_relevance_interval_s": 60,
                "report_timestamp_s": 60.0,
                "top_feature_names": ["failed_login_rate"],
                "top_feature_relevance_values": [0.3],
                "report_nonblocking": True,
                "learner_updates_skipped_for_reporting": 0,
                "uses_framework_compute_feature_relevance": True,
                "latest_report_latency_ms": 1.2,
            }
        ],
    )

    status = validator.validate(spec_path, tmp_path)
    relevance_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_feature_relevance_periodic_reporting"
    )

    assert status["accepted"] is False
    assert relevance_item["condition_message"] == (
        "feature relevance reporting skipped learner updates"
    )


def test_acceptance_validator_rejects_feature_relevance_not_using_framework(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_jsonl(
        tmp_path / "outputs/rlsecd_feature_relevance/metrics.jsonl",
        [
            {
                "feature_relevance_report_count": 2,
                "feature_relevance_interval_s": 60,
                "report_timestamp_s": 0.0,
                "top_feature_names": ["failed_login_rate"],
                "top_feature_relevance_values": [0.25],
                "report_nonblocking": True,
                "learner_updates_skipped_for_reporting": 0,
                "uses_framework_compute_feature_relevance": False,
                "latest_report_latency_ms": 1.0,
            },
            {
                "feature_relevance_report_count": 2,
                "feature_relevance_interval_s": 60,
                "report_timestamp_s": 60.0,
                "top_feature_names": ["failed_login_rate"],
                "top_feature_relevance_values": [0.3],
                "report_nonblocking": True,
                "learner_updates_skipped_for_reporting": 0,
                "uses_framework_compute_feature_relevance": True,
                "latest_report_latency_ms": 1.2,
            }
        ],
    )

    status = validator.validate(spec_path, tmp_path)
    relevance_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_feature_relevance_periodic_reporting"
    )

    assert status["accepted"] is False
    assert relevance_item["condition_message"] == (
        "feature relevance did not use framework diagnostics"
    )


def test_acceptance_validator_rejects_feature_relevance_single_report(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_jsonl(
        tmp_path / "outputs/rlsecd_feature_relevance/metrics.jsonl",
        [
            {
                "feature_relevance_report_count": 1,
                "feature_relevance_interval_s": 60,
                "report_timestamp_s": 0.0,
                "top_feature_names": ["failed_login_rate"],
                "top_feature_relevance_values": [0.25],
                "report_nonblocking": True,
                "learner_updates_skipped_for_reporting": 0,
                "uses_framework_compute_feature_relevance": True,
                "latest_report_latency_ms": 1.0,
            }
        ],
    )

    status = validator.validate(spec_path, tmp_path)
    relevance_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_feature_relevance_periodic_reporting"
    )

    assert status["accepted"] is False
    assert relevance_item["condition_message"] == (
        "fewer than two feature relevance reports were emitted"
    )


def test_acceptance_validator_rejects_feature_relevance_bad_cadence(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_jsonl(
        tmp_path / "outputs/rlsecd_feature_relevance/metrics.jsonl",
        [
            {
                "feature_relevance_report_count": 2,
                "feature_relevance_interval_s": 60,
                "report_timestamp_s": 0.0,
                "top_feature_names": ["failed_login_rate"],
                "top_feature_relevance_values": [0.25],
                "report_nonblocking": True,
                "learner_updates_skipped_for_reporting": 0,
                "uses_framework_compute_feature_relevance": True,
                "latest_report_latency_ms": 1.0,
            },
            {
                "feature_relevance_report_count": 2,
                "feature_relevance_interval_s": 60,
                "report_timestamp_s": 30.0,
                "top_feature_names": ["failed_login_rate"],
                "top_feature_relevance_values": [0.3],
                "report_nonblocking": True,
                "learner_updates_skipped_for_reporting": 0,
                "uses_framework_compute_feature_relevance": True,
                "latest_report_latency_ms": 1.2,
            },
        ],
    )

    status = validator.validate(spec_path, tmp_path)
    relevance_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_feature_relevance_periodic_reporting"
    )

    assert status["accepted"] is False
    assert relevance_item["condition_message"] == (
        "feature relevance report cadence is not approximately 60 seconds"
    )


def test_acceptance_validator_rejects_feature_relevance_mismatched_values(
    tmp_path: Path,
) -> None:
    spec_module = load_spec_module()
    validator = load_validator_module()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec_module.build_spec()), encoding="utf-8")
    write_complete_external_artifacts(tmp_path)
    write_jsonl(
        tmp_path / "outputs/rlsecd_feature_relevance/metrics.jsonl",
        [
            {
                "feature_relevance_report_count": 2,
                "feature_relevance_interval_s": 60,
                "report_timestamp_s": 0.0,
                "top_feature_names": ["failed_login_rate", "scan_rate"],
                "top_feature_relevance_values": [0.25],
                "report_nonblocking": True,
                "learner_updates_skipped_for_reporting": 0,
                "uses_framework_compute_feature_relevance": True,
                "latest_report_latency_ms": 1.0,
            },
            {
                "feature_relevance_report_count": 2,
                "feature_relevance_interval_s": 60,
                "report_timestamp_s": 60.0,
                "top_feature_names": ["failed_login_rate"],
                "top_feature_relevance_values": [0.3],
                "report_nonblocking": True,
                "learner_updates_skipped_for_reporting": 0,
                "uses_framework_compute_feature_relevance": True,
                "latest_report_latency_ms": 1.2,
            },
        ],
    )

    status = validator.validate(spec_path, tmp_path)
    relevance_item = next(
        item
        for item in status["items"]
        if item["claim_scope"] == "rlsecd_feature_relevance_periodic_reporting"
    )

    assert status["accepted"] is False
    assert relevance_item["condition_message"] == (
        "feature relevance rows lack finite named values"
    )
