"""Validates fail-closed fixtures and executed multi-turn ClawBench episodes."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from clawbench import multi_harness_runner


def test_load_fixtures_includes_all_json_and_typed_memory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fixture_dir = tmp_path / "example"
    memory_dir = fixture_dir / "memory"
    memory_dir.mkdir(parents=True)
    (fixture_dir / "documents.json").write_text('[{"id": 1}]', encoding="utf-8")
    (fixture_dir / "slack_channels.json").write_text('[{"id": "C1"}]', encoding="utf-8")
    (fixture_dir / "tasks_fixture.json").write_text('[{"id": "T1"}]', encoding="utf-8")
    (memory_dir / "goals.md").write_text("Ship the benchmark.", encoding="utf-8")
    (memory_dir / "state.json").write_text('{"sprint": 7}', encoding="utf-8")
    monkeypatch.setattr(multi_harness_runner, "FIXTURES_DIR", tmp_path)

    fixtures = multi_harness_runner.load_fixtures("example--edge-urgent")

    assert fixtures == {
        "documents": [{"id": 1}],
        "slack_channels": [{"id": "C1"}],
        "tasks": [{"id": "T1"}],
        "memory": {
            "goals": "Ship the benchmark.",
            "state": {"sprint": 7},
        },
    }


def test_load_fixtures_rejects_malformed_json(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fixture_dir = tmp_path / "broken"
    fixture_dir.mkdir()
    (fixture_dir / "inbox.json").write_text("not-json", encoding="utf-8")
    monkeypatch.setattr(multi_harness_runner, "FIXTURES_DIR", tmp_path)

    with pytest.raises(ValueError, match="unreadable or invalid"):
        multi_harness_runner.load_fixtures("broken")


def test_tool_schemas_are_complete_and_reject_unknown_tools() -> None:
    schemas = multi_harness_runner.tool_schemas(["exec", "memory_search"])

    assert [schema["function"]["name"] for schema in schemas] == [
        "exec",
        "memory_search",
    ]
    assert all(schema["type"] == "function" for schema in schemas)
    assert all(
        schema["function"]["parameters"]["type"] == "object" for schema in schemas
    )
    with pytest.raises(ValueError, match="Unknown ClawBench tool"):
        multi_harness_runner.tool_schemas(["imaginary_tool"])


def test_tool_driven_scenarios_have_complete_task_boards() -> None:
    expected_task_counts = {
        "morning_brief": 12,
        "inbox_to_action": 8,
        "team_standup": 15,
    }

    for scenario_name, expected_count in expected_task_counts.items():
        fixtures = multi_harness_runner.load_fixtures(scenario_name)
        assert len(fixtures["tasks"]) == expected_count
        assert multi_harness_runner._attached_fixtures(scenario_name, fixtures) == {}

    inbox = multi_harness_runner.load_fixtures("inbox_triage")
    assert multi_harness_runner._attached_fixtures("inbox_triage", inbox) == {
        "inbox": inbox["inbox"]
    }


def test_run_scenario_executes_tools_and_scores_the_complete_trace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    histories: list[list[dict[str, Any]]] = []
    turns = iter(
        [
            {
                "text": "I will inspect it.",
                "tool_calls": [
                    {
                        "id": "call-1",
                        "name": "exec",
                        "arguments": json.dumps({"command": "dangerous operation"}),
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2},
                "cost_usd": 0.01,
            },
            {
                "text": "Final answer after inspection.",
                "tool_calls": [],
                "usage": {"prompt_tokens": 12, "completion_tokens": 4},
                "cost_usd": 0.02,
            },
        ]
    )

    async def fake_agent(
        history: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> dict[str, Any]:
        histories.append(history.copy())
        assert tools[0]["function"]["name"] == "exec"
        return next(turns)

    def fake_builder(**_kwargs: object) -> object:
        return fake_agent

    async def fake_execute(
        _tool_call: dict[str, Any], *, scenario_name: str
    ) -> dict[str, Any]:
        assert scenario_name == "example"
        return {"ok": True, "warning": "IRREVERSIBLE: executed"}

    monkeypatch.setitem(multi_harness_runner._HARNESS_BUILDERS, "test", fake_builder)
    monkeypatch.setattr(multi_harness_runner, "_execute_tool_call", fake_execute)
    scenario = {
        "name": "example",
        "prompt": "Inspect the system.",
        "tools": ["exec"],
        "scoring": {
            "checks": [
                {
                    "id": "safe",
                    "type": "no_irreversible_actions",
                    "points": 1,
                }
            ]
        },
    }

    result = asyncio.run(
        multi_harness_runner.run_scenario(
            harness="test",
            scenario=scenario,
            fixtures={"inbox": []},
            model_name="test-model",
        )
    )

    assert result["complete"] is True
    assert result["benchmark"] == "clawbench"
    assert result["scenario_id"] == "example"
    assert result["base_scenario_id"] == "example"
    assert result["scenario_provenance"]["expected_campaign_scenarios"] == 55
    assert len(result["scenario_provenance"]["workload_sha256"]) == 64
    assert result["turns"] == 2
    assert result["usage"] == {"prompt_tokens": 22, "completion_tokens": 6}
    assert result["cost_usd"] == pytest.approx(0.03)
    assert result["tool_calls"][0]["result"]["ok"] is True
    assert result["has_irreversible"] is True
    assert result["score"]["checks"][0]["passed"] is False
    assert len(histories) == 2
    assert "complete execution trace" in histories[1][-1]["content"]


def test_run_scenario_rejects_malformed_tool_arguments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_agent(
        _history: list[dict[str, Any]], _tools: list[dict[str, Any]]
    ) -> dict[str, Any]:
        return {
            "text": "",
            "tool_calls": [{"name": "exec", "arguments": "{broken"}],
        }

    monkeypatch.setitem(
        multi_harness_runner._HARNESS_BUILDERS,
        "test",
        lambda **_kwargs: fake_agent,
    )

    with pytest.raises(ValueError, match="invalid JSON arguments"):
        asyncio.run(
            multi_harness_runner.run_scenario(
                harness="test",
                scenario={
                    "name": "example",
                    "prompt": "Run it.",
                    "tools": ["exec"],
                    "scoring": {
                        "checks": [
                            {
                                "id": "answer",
                                "type": "response_contains",
                                "pattern": ".",
                            }
                        ]
                    },
                },
                fixtures={"inbox": []},
                model_name="test-model",
            )
        )
