from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from eliza_loca.run_cerebras import build_command, build_env
from eliza_loca.trajectory_audit import audit_output_dir


def _args(**overrides):
    defaults = {
        "config": "task-configs/debug.json",
        "strategy": "react",
        "model": "gpt-oss-120b",
        "base_url": "https://api.cerebras.ai/v1",
        "output_dir": "/tmp/loca-out",
        "max_workers": 1,
        "max_tool_uses": 5,
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
