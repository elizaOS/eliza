"""Planner prompt overrides fail closed before any benchmark model call."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from eliza_lifeops_bench.agents._planner_prompt import (
    load_planner_system_prompt,
)


def test_unset_override_uses_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LIFEOPS_PLANNER_PROMPT_FILE", raising=False)

    assert load_planner_system_prompt("default prompt") == "default prompt"


def test_loads_plain_text_and_optimizer_json(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    text_path = tmp_path / "planner.txt"
    text_path.write_text("  text prompt  \n", encoding="utf-8")
    monkeypatch.setenv("LIFEOPS_PLANNER_PROMPT_FILE", str(text_path))
    assert load_planner_system_prompt("default") == "text prompt"

    json_path = tmp_path / "planner.json"
    json_path.write_text(
        json.dumps({"prompt": "  optimized prompt  "}),
        encoding="utf-8",
    )
    monkeypatch.setenv("LIFEOPS_PLANNER_PROMPT_FILE", str(json_path))
    assert load_planner_system_prompt("default") == "optimized prompt"


@pytest.mark.parametrize(
    ("filename", "content", "message"),
    [
        ("empty.txt", " \n", "empty prompt"),
        ("malformed.json", "{", "not valid JSON"),
        ("array.json", "[]", "JSON object"),
        ("missing.json", '{"score": 1}', "non-empty prompt"),
        ("empty.json", '{"prompt": "  "}', "non-empty prompt"),
    ],
)
def test_invalid_override_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    filename: str,
    content: str,
    message: str,
) -> None:
    path = tmp_path / filename
    path.write_text(content, encoding="utf-8")
    monkeypatch.setenv("LIFEOPS_PLANNER_PROMPT_FILE", str(path))

    with pytest.raises(ValueError, match=message):
        load_planner_system_prompt("default")


def test_missing_override_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    path = tmp_path / "does-not-exist.txt"
    monkeypatch.setenv("LIFEOPS_PLANNER_PROMPT_FILE", str(path))

    with pytest.raises(RuntimeError, match="failed to read"):
        load_planner_system_prompt("default")
