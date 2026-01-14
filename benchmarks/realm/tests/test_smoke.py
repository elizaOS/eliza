"""
Smoke tests for REALM benchmark components.
"""

import os

from benchmarks.realm.cli import _parse_env_line, load_env_file
from benchmarks.realm.dataset import REALMDataset
from benchmarks.realm.plugin.actions import _parse_plan_json
from benchmarks.realm.types import REALMCategory, REALMTask


def test_parse_env_line_basic() -> None:
    assert _parse_env_line("FOO=bar") == ("FOO", "bar")
    assert _parse_env_line(" export FOO=bar ") == ("FOO", "bar")
    assert _parse_env_line("# comment") is None
    assert _parse_env_line("") is None
    assert _parse_env_line("NO_EQUALS") is None
    assert _parse_env_line('QUOTED="a b"') == ("QUOTED", "a b")


def test_load_env_file_does_not_override(monkeypatch, tmp_path) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text("FOO=fromfile\nBAR=fromfile\n", encoding="utf-8")

    monkeypatch.setenv("FOO", "already")
    loaded = load_env_file(env_path, override=False)

    assert os.environ["FOO"] == "already"
    assert os.environ["BAR"] == "fromfile"
    assert loaded["BAR"] == "fromfile"
    assert "FOO" not in loaded


def test_dataset_parse_task_validation() -> None:
    ds = REALMDataset()

    assert ds._parse_task({"id": "x"}) is None
    assert (
        ds._parse_task(
            {
                "id": "t1",
                "name": "Task",
                "description": "Desc",
                "goal": "Goal",
                "category": "sequential",
                "requirements": ["r1", "r2"],
                "constraints": {"max_steps": 3, "flag": True},
                "expected_outcome": "ok",
                "available_tools": ["tool1", "tool2"],
                "timeout_ms": 1234,
                "max_steps": 3,
                "difficulty": "easy",
            }
        )
        is not None
    )


def test_parse_plan_response_basic() -> None:
    task = REALMTask(
        id="t1",
        name="Task",
        description="Desc",
        goal="Goal",
        category=REALMCategory.SEQUENTIAL,
        requirements=[],
        constraints={},
        expected_outcome="",
        available_tools=["tool1", "tool2"],
        timeout_ms=1000,
        max_steps=2,
        difficulty="easy",
    )

    response = """```json
[
  {"action": "tool1", "description": "first", "parameters": {"step": 1}},
  {"action": "tool2", "parameters": {}}
]
```"""

    actions = _parse_plan_json(response, task.available_tools)
    assert [a["action"] for a in actions] == ["tool1", "tool2"]
    assert actions[0]["parameters"]["step"] == 1
