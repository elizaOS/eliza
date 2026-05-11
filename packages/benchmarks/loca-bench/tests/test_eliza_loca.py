from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from eliza_loca.run_cerebras import build_command, build_env, main, parse_args
from eliza_loca.trajectory_audit import audit_output_dir
from eliza_loca.long_context import (
    CONTEXT_TIERS,
    audit_long_context_trajectory,
    build_long_context_trajectory,
    compact_with_summary_tail,
    write_loca_output,
)


def _args(**overrides):
    defaults = {
        "config": "task-configs/debug.json",
        "strategy": "react",
        "model": "gpt-oss-120b",
        "base_url": "https://api.cerebras.ai/v1",
        "output_dir": "/tmp/loca-out",
        "max_workers": 1,
        "max_tool_uses": 5,
        "max_steps": None,
        "max_tokens": 2048,
        "timeout": 123,
        "max_retries": 2,
        "initial_retry_delay": 0.5,
        "max_context_size": 8192,
        "reset_size": 4096,
        "reset_ratio": 0.5,
        "memory_warning_threshold": 0.7,
        "keep_thinking": 0,
        "context_reset": False,
        "context_summary": True,
        "context_awareness": True,
        "thinking_reset": True,
        "reasoning_effort": "low",
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_cerebras_wrapper_builds_loca_command() -> None:
    command = build_command(_args())

    assert command[:3]
    assert command[2:] == [
        "loca.cli.main",
        "run",
        "--config-file",
        command[5],
        "--strategy",
        "react",
        "--model",
        "gpt-oss-120b",
        "--output-dir",
        str(Path("/tmp/loca-out").resolve()),
        "--max-workers",
        "1",
        "--max-tool-uses",
        "5",
        "--max-tokens",
        "2048",
        "--timeout",
        "123",
        "--max-retries",
        "2",
        "--initial-retry-delay",
        "0.5",
        "--max-context-size",
        "8192",
        "--reset-size",
        "4096",
        "--reset-ratio",
        "0.5",
        "--memory-warning-threshold",
        "0.7",
        "--keep-thinking",
        "0",
        "--no-context-reset",
        "--context-summary",
        "--context-awareness",
        "--thinking-reset",
        "--reasoning-effort",
        "low",
    ]


def test_cerebras_wrapper_env_maps_key_and_base_url(monkeypatch) -> None:
    monkeypatch.setenv("CEREBRAS_API_KEY", "test-cerebras-key")
    monkeypatch.delenv("LOCA_OPENAI_API_KEY", raising=False)

    env = build_env(_args())

    assert env["LOCA_OPENAI_API_KEY"] == "test-cerebras-key"
    assert env["LOCA_OPENAI_BASE_URL"] == "https://api.cerebras.ai/v1"
    assert env["LOCA_QUIET"] == "1"


def test_cerebras_wrapper_dry_run_does_not_require_api_key(monkeypatch, capsys) -> None:
    monkeypatch.delenv("CEREBRAS_API_KEY", raising=False)
    monkeypatch.delenv("LOCA_OPENAI_API_KEY", raising=False)
    monkeypatch.setattr(
        "sys.argv",
        ["run_cerebras.py", "--dry-run", "--output-dir", "/tmp/loca-dry-run"],
    )

    assert main() == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["command"][2:4] == ["loca.cli.main", "run"]
    assert "--output-dir" in payload["command"]


def test_cerebras_wrapper_rejects_reset_and_summary_at_parse(monkeypatch) -> None:
    monkeypatch.setattr(
        "sys.argv",
        ["run_cerebras.py", "--context-reset", "--context-summary", "--dry-run"],
    )

    with pytest.raises(SystemExit):
        parse_args()


def test_cerebras_wrapper_rejects_reset_and_summary_at_command_build() -> None:
    with pytest.raises(ValueError, match="mutually exclusive"):
        build_command(_args(context_reset=True, context_summary=True))


def test_cerebras_wrapper_passes_max_steps_when_set() -> None:
    command = build_command(_args(max_steps=17))

    assert "--max-steps" in command
    assert command[command.index("--max-steps") + 1] == "17"


def test_trajectory_audit_accepts_complete_synthetic_run(tmp_path) -> None:
    root = tmp_path / "run"
    task_dir = root / "tasks" / "DemoTask" / "state0"
    task_dir.mkdir(parents=True)
    trajectory = {
        "schema_version": "loca_traj_v1",
        "conversation": {
            "messages": [{"role": "user", "content": "done"}],
            "full_messages_history": [
                {"role": "user", "content": "start"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{"id": "call_1", "function": {"name": "claim_done"}}],
                },
                {"role": "tool", "tool_call_id": "call_1", "content": "ok"},
            ],
        },
        "events": {"reset": [], "summary": [{"step": 2}], "trim": [], "thinking_reset": []},
        "metrics": {"accuracy": 1.0, "total_steps": 2, "completed": True},
        "provider_payload": {
            "usage_tracking": [
                {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}
            ]
        },
    }
    (task_dir / "trajectory.json").write_text(json.dumps(trajectory), encoding="utf-8")
    (task_dir / "eval.json").write_text(
        json.dumps({"status": "success", "accuracy": 1.0, "steps": 2, "feedback": ""}),
        encoding="utf-8",
    )
    (task_dir / "token_stats.json").write_text(
        json.dumps({"usage_tracking": trajectory["provider_payload"]["usage_tracking"]}),
        encoding="utf-8",
    )
    (root / "results.json").write_text(
        json.dumps({"summary": {"avg_accuracy": 1.0, "total_api_tokens": 120}}),
        encoding="utf-8",
    )
    (root / "all_trajectories.json").write_text(
        json.dumps({"DemoTask": {"state0": trajectory}}),
        encoding="utf-8",
    )

    audit = audit_output_dir(root, include_previews=True)

    assert audit["summary"]["issue_count"] == 0
    assert audit["summary"]["trajectory_count"] == 1
    assert audit["context_events"]["summary"] == 1
    assert audit["token_totals"]["total_tokens"] == 120
    assert audit["previews"]


def test_trajectory_audit_counts_summary_skip_events(tmp_path) -> None:
    root = tmp_path / "run"
    task_dir = root / "tasks" / "DemoTask" / "state0"
    task_dir.mkdir(parents=True)
    trajectory = {
        "schema_version": "loca_traj_v1",
        "conversation": {
            "messages": [{"role": "user", "content": "done"}],
            "full_messages_history": [{"role": "user", "content": "start"}],
        },
        "events": {
            "reset": [],
            "summary": [{"step": 2}],
            "summary_skip": [{"step": 3, "reason": "summary_cooldown_steps"}],
            "trim": [],
            "thinking_reset": [],
        },
        "metrics": {"accuracy": 1.0, "total_steps": 2, "completed": True},
        "provider_payload": {
            "usage_tracking": [
                {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}
            ]
        },
    }
    (task_dir / "trajectory.json").write_text(json.dumps(trajectory), encoding="utf-8")
    (task_dir / "eval.json").write_text(
        json.dumps({"status": "success", "accuracy": 1.0, "steps": 2, "feedback": ""}),
        encoding="utf-8",
    )
    (task_dir / "token_stats.json").write_text(
        json.dumps({"usage_tracking": trajectory["provider_payload"]["usage_tracking"]}),
        encoding="utf-8",
    )
    (root / "results.json").write_text(
        json.dumps({"summary": {"avg_accuracy": 1.0, "total_api_tokens": 120}}),
        encoding="utf-8",
    )
    (root / "all_trajectories.json").write_text(
        json.dumps({"DemoTask": {"state0": trajectory}}),
        encoding="utf-8",
    )

    audit = audit_output_dir(root)

    assert audit["summary"]["issue_count"] == 0
    assert audit["context_events"]["summary"] == 1
    assert audit["context_events"]["summary_skip"] == 1


def test_trajectory_audit_flags_missing_required_outputs(tmp_path) -> None:
    audit = audit_output_dir(tmp_path)

    issue_names = {issue["issue"] for issue in audit["issues"]}
    assert "missing_results_json" in issue_names
    assert "missing_all_trajectories_json" in issue_names
    assert "empty_output" in issue_names


def test_trajectory_audit_allow_empty_suppresses_empty_output_only(tmp_path) -> None:
    audit = audit_output_dir(tmp_path, allow_empty=True)

    issue_names = {issue["issue"] for issue in audit["issues"]}
    assert "empty_output" not in issue_names
    assert "missing_results_json" in issue_names
    assert "missing_all_trajectories_json" in issue_names


def test_trajectory_audit_compares_metadata_total_tasks(tmp_path) -> None:
    root = tmp_path / "run"
    task_dir = root / "tasks" / "DemoTask" / "state0"
    task_dir.mkdir(parents=True)
    trajectory = {
        "schema_version": "loca_traj_v1",
        "conversation": {
            "messages": [{"role": "user", "content": "done"}],
            "full_messages_history": [{"role": "user", "content": "start"}],
        },
        "events": {"reset": [], "summary": [], "trim": [], "thinking_reset": []},
        "provider_payload": {
            "usage_tracking": [
                {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}
            ]
        },
    }
    (task_dir / "trajectory.json").write_text(json.dumps(trajectory), encoding="utf-8")
    (task_dir / "eval.json").write_text(json.dumps({"status": "success"}), encoding="utf-8")
    (task_dir / "token_stats.json").write_text(json.dumps({}), encoding="utf-8")
    (root / "results.json").write_text(
        json.dumps({"metadata": {"total_tasks": 2}, "summary": {}}),
        encoding="utf-8",
    )
    (root / "all_trajectories.json").write_text(
        json.dumps({"DemoTask": {"state0": trajectory}}),
        encoding="utf-8",
    )

    audit = audit_output_dir(root)

    mismatches = [
        issue
        for issue in audit["issues"]
        if issue["issue"] == "metadata_total_tasks_mismatch"
    ]
    assert {issue["source"] for issue in mismatches} == {"aggregate", "per_task"}
    assert audit["summary"]["metadata_total_tasks"] == 2


def test_trajectory_audit_flags_secret_leaks_and_bad_summary_events(tmp_path) -> None:
    root = tmp_path / "run"
    task_dir = root / "tasks" / "DemoTask" / "state0"
    task_dir.mkdir(parents=True)
    trajectory = {
        "schema_version": "loca_traj_v1",
        "conversation": {
            "messages": [{"role": "user", "content": "api_key=test-secret-value"}],
            "full_messages_history": [{"role": "user", "content": "start"}],
        },
        "events": {
            "reset": [],
            "summary": [
                {
                    "messages_before_count": 3,
                    "messages_after_count": 4,
                    "summary_tail_count": 2,
                    "summary_tail": [{"role": "user", "content": "tail"}],
                    "summary_user_message": {"role": "assistant", "content": "summary"},
                    "summary_response_original": {"role": "tool", "content": "summary"},
                }
            ],
            "trim": [],
            "thinking_reset": [],
        },
        "provider_payload": {
            "usage_tracking": [
                {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}
            ]
        },
    }
    (task_dir / "trajectory.json").write_text(json.dumps(trajectory), encoding="utf-8")
    (task_dir / "eval.json").write_text(json.dumps({"status": "success"}), encoding="utf-8")
    (task_dir / "token_stats.json").write_text(json.dumps({}), encoding="utf-8")
    (root / "results.json").write_text(json.dumps({"summary": {}}), encoding="utf-8")
    (root / "all_trajectories.json").write_text(
        json.dumps({"DemoTask": {"state0": trajectory}}),
        encoding="utf-8",
    )

    audit = audit_output_dir(root)

    issue_names = {issue["issue"] for issue in audit["issues"]}
    assert "secret_leak_detected" in issue_names
    assert "summary_event_message_count_increased" in issue_names
    assert "summary_event_invalid_summary_user_role" in issue_names
    assert "summary_event_invalid_summary_response_role" in issue_names
    assert "summary_event_tail_count_mismatch" in issue_names


def test_trajectory_audit_checks_active_messages_for_tool_pairing(tmp_path) -> None:
    root = tmp_path / "run"
    task_dir = root / "tasks" / "DemoTask" / "state0"
    task_dir.mkdir(parents=True)
    trajectory = {
        "schema_version": "loca_traj_v1",
        "conversation": {
            "messages": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{"id": "missing_result", "function": {"name": "lookup"}}],
                }
            ],
            "full_messages_history": [{"role": "user", "content": "start"}],
        },
        "events": {"reset": [], "summary": [], "trim": [], "thinking_reset": []},
        "provider_payload": {
            "usage_tracking": [
                {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
            ]
        },
    }
    (task_dir / "trajectory.json").write_text(json.dumps(trajectory), encoding="utf-8")
    (task_dir / "eval.json").write_text(json.dumps({"status": "success"}), encoding="utf-8")
    (task_dir / "token_stats.json").write_text(json.dumps({}), encoding="utf-8")
    (root / "results.json").write_text(json.dumps({"summary": {}}), encoding="utf-8")
    (root / "all_trajectories.json").write_text(
        json.dumps({"DemoTask": {"state0": trajectory}}),
        encoding="utf-8",
    )

    audit = audit_output_dir(root)

    assert {
        issue.get("scope")
        for issue in audit["issues"]
        if issue["issue"] == "unpaired_tool_call_or_result"
    } == {"messages"}


def test_context_summary_trigger_has_hysteresis() -> None:
    pytest.importorskip("fire")
    from inference.run_react import select_summary_tail, should_generate_context_summary

    first_should_summarize, first_reason = should_generate_context_summary(
        total_tokens=13_000,
        reset_size=12_000,
        messages_count=11,
        step_count=3,
        max_context_size=20_000,
        max_tokens=4_096,
    )
    assert first_should_summarize is True
    assert first_reason == "first_over_reset_size"

    static_should_summarize, static_reason = should_generate_context_summary(
        total_tokens=12_184,
        reset_size=12_000,
        messages_tokens=1_081,
        tools_tokens=11_103,
        messages_count=11,
        step_count=3,
        max_context_size=20_000,
        max_tokens=4_096,
    )
    assert static_should_summarize is False
    assert static_reason == "static_overhead_dominated"

    last_summary = {"step": 3, "messages_after_count": 2}
    cooldown_should_summarize, cooldown_reason = should_generate_context_summary(
        total_tokens=13_000,
        reset_size=12_000,
        messages_count=6,
        step_count=4,
        last_summary_event=last_summary,
        max_context_size=20_000,
        max_tokens=4_096,
    )
    assert cooldown_should_summarize is False
    assert cooldown_reason == "summary_cooldown_steps"

    hard_limit_should_summarize, hard_limit_reason = should_generate_context_summary(
        total_tokens=16_500,
        reset_size=12_000,
        messages_count=6,
        step_count=4,
        last_summary_event=last_summary,
        max_context_size=20_000,
        max_tokens=4_096,
    )
    assert hard_limit_should_summarize is True
    assert hard_limit_reason == "hard_context_limit"

    tail = select_summary_tail(
        [
            {"role": "tool", "tool_call_id": "old", "content": "orphan"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_1"}]},
            {"role": "tool", "tool_call_id": "call_1", "content": "raw facts"},
            {"role": "user", "content": "token usage"},
        ],
        max_messages=4,
    )
    assert tail[0]["role"] == "assistant"
    assert tail[1]["tool_call_id"] == "call_1"

    split_tail = select_summary_tail(
        [
            {"role": "user", "content": "old"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_2"}]},
            {"role": "tool", "tool_call_id": "call_2", "content": "raw facts"},
            {"role": "user", "content": "latest"},
        ],
        max_messages=2,
    )
    assert split_tail[0]["role"] == "assistant"
    assert split_tail[1]["tool_call_id"] == "call_2"


def test_react_api_token_metrics_sum_totals_and_expose_maxima() -> None:
    pytest.importorskip("fire")
    from inference.run_react import compute_api_token_metrics

    metrics = compute_api_token_metrics(
        [
            {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
            {"prompt_tokens": 80, "completion_tokens": 30, "total_tokens": 110},
            {"prompt_tokens": 150, "completion_tokens": 10, "total_tokens": 90},
        ]
    )

    assert metrics["api_prompt_tokens"] == 330
    assert metrics["api_completion_tokens"] == 60
    assert metrics["api_total_tokens"] == 320
    assert metrics["api_max_prompt_tokens"] == 150
    assert metrics["api_max_total_tokens"] == 120


def test_react_final_status_requires_terminal_success_or_clear_reward() -> None:
    pytest.importorskip("fire")
    from inference.run_react import determine_final_status

    assert (
        determine_final_status(terminated=True, truncated=False, reward=0.0)
        == "success"
    )
    assert (
        determine_final_status(terminated=False, truncated=True, reward=0.0)
        == "truncated"
    )
    assert (
        determine_final_status(terminated=True, truncated=True, reward=0.5)
        == "truncated"
    )
    assert (
        determine_final_status(terminated=False, truncated=True, reward=1.0)
        == "success"
    )
    assert (
        determine_final_status(terminated=False, truncated=False, reward=0.0)
        == "error"
    )


def test_react_run_metrics_persist_done_flags_and_stop_reason() -> None:
    pytest.importorskip("fire")
    from inference.run_react import build_run_metrics

    metrics = build_run_metrics(
        accuracy=0.5,
        total_steps=7,
        completed=True,
        terminated=False,
        truncated=True,
        stop_reason="max_steps",
        status="truncated",
    )

    assert metrics["terminated"] is False
    assert metrics["truncated"] is True
    assert metrics["stop_reason"] == "max_steps"
    assert metrics["status"] == "truncated"


def test_long_context_generator_builds_million_token_compacted_fixture(tmp_path) -> None:
    trajectory = build_long_context_trajectory(
        target_tokens=1_000_000,
        tier="1m",
        turns=240,
        needle_count=24,
    )
    compacted = compact_with_summary_tail(trajectory, tail_messages=12)
    audit = audit_long_context_trajectory(compacted)

    assert audit["estimated_full_history_tokens"] >= 950_000
    assert audit["estimated_current_tokens"] < audit["estimated_full_history_tokens"]
    assert audit["compression"]["within_current_token_ratio"] is True
    assert audit["compression"]["within_current_token_limit"] is True
    assert audit["needle_count"] == 24
    assert audit["record_count"] == 120
    assert audit["preserved_record_count"] == 72
    assert audit["missing_current_needles"] == []
    assert audit["missing_full_history_needles"] == []
    assert audit["missing_current_records"] == []
    assert audit["missing_full_history_records"] == []
    assert audit["summary_events"] == 1
    assert audit["failure_count"] == 0

    write_loca_output(tmp_path, compacted)
    output_audit = audit_output_dir(tmp_path)
    assert output_audit["summary"]["issue_count"] == 0
    assert output_audit["summary"]["trajectory_count"] == 1


def test_long_context_tier_builds_128k_fixture_with_realistic_records() -> None:
    trajectory = build_long_context_trajectory(
        target_tokens=CONTEXT_TIERS["128k"],
        tier="128k",
        turns=400,
        needle_count=8,
    )
    compacted = compact_with_summary_tail(trajectory, tail_messages=8)
    audit = audit_long_context_trajectory(compacted)
    records = trajectory["metadata"]["long_context"]["records"]

    assert trajectory["metadata"]["long_context"]["tier"] == "128k"
    assert audit["estimated_full_history_tokens"] >= 120_000
    assert audit["failure_count"] == 0
    assert {record["kind"] for record in records} == {
        "conflicting_update",
        "rescinded_decision",
        "tool_observation",
        "distractor",
    }
    assert any(record["should_preserve"] is False for record in records)
    assert any("LOCA_TOOL_OBSERVATION" in record["value"] for record in records)


def test_long_context_lossy_summary_mode_is_caught() -> None:
    trajectory = build_long_context_trajectory(
        target_tokens=40_000,
        turns=48,
        needle_count=6,
    )
    compacted = compact_with_summary_tail(trajectory, tail_messages=0, summary_mode="lossy")
    audit = audit_long_context_trajectory(compacted)

    assert audit["failure_count"] > 0
    assert audit["missing_current_needles"] == ["needle_000"]
    assert audit["missing_current_records"]
    assert audit["missing_full_history_needles"] == []
    assert audit["missing_full_history_records"] == []


def test_long_context_audit_enforces_current_token_threshold() -> None:
    trajectory = build_long_context_trajectory(
        target_tokens=40_000,
        turns=40,
        needle_count=4,
    )
    compacted = compact_with_summary_tail(trajectory, tail_messages=12)
    audit = audit_long_context_trajectory(compacted, max_current_tokens=100)

    assert audit["compression"]["within_current_token_limit"] is False
    assert audit["failures"]["current_token_limit_exceeded"]
    assert audit["failure_count"] > 0


def test_long_context_audit_catches_missing_compacted_needle() -> None:
    trajectory = build_long_context_trajectory(
        target_tokens=20_000,
        turns=40,
        needle_count=4,
    )
    compacted = compact_with_summary_tail(trajectory, tail_messages=0)
    needle = compacted["metadata"]["long_context"]["needles"][0]
    compacted["conversation"]["messages"][0]["content"] = compacted["conversation"][
        "messages"
    ][0]["content"].replace(needle["value"], "[DROPPED]")

    audit = audit_long_context_trajectory(compacted)

    assert audit["missing_current_needles"] == [needle["key"]]
    assert audit["missing_full_history_needles"] == []
