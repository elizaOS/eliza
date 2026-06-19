from __future__ import annotations

import json
from pathlib import Path

from scripts.lib.eliza_record import DEFAULT_THOUGHT_LEAKS, is_default_thought_leak
from scripts.transform_purge_default_thoughts import (
    process_file,
    rewrite_expected_response,
)


def test_default_thought_leak_detection_matches_canonical_literals():
    assert "Reply to the user." in DEFAULT_THOUGHT_LEAKS
    assert is_default_thought_leak(' "Reply to the user." ')
    assert not is_default_thought_leak(None)
    assert not is_default_thought_leak("")
    assert not is_default_thought_leak("A real reasoning trace.")


def test_rewrite_expected_response_replaces_first_leak_line():
    rewritten, was_leaked = rewrite_expected_response(
        "thought: Reply to the user.\ntext: hi",
        "hello",
    )

    first_line = rewritten.splitlines()[0]
    assert was_leaked
    assert rewritten.endswith("\ntext: hi")
    assert "Reply to the user." not in first_line
    assert not is_default_thought_leak(first_line.removeprefix("thought: "))


def test_rewrite_expected_response_leaves_real_thoughts_unchanged():
    expected_response = "thought: answer from the supplied context\ntext: hi"
    rewritten, was_leaked = rewrite_expected_response(expected_response, "hello")

    assert not was_leaked
    assert rewritten == expected_response


def test_process_file_rewrites_jsonl_in_place(tmp_path: Path):
    path = tmp_path / "train.jsonl"
    path.write_text(
        json.dumps({
            "currentMessage": {"content": "hello"},
            "expectedResponse": "thought: Reply to the user.\ntext: hello",
        })
        + "\n",
        encoding="utf-8",
    )

    total, rewritten = process_file(path)
    record = json.loads(path.read_text(encoding="utf-8"))
    first_line = record["expectedResponse"].splitlines()[0]

    assert total == 1
    assert rewritten == 1
    assert "Reply to the user." not in first_line
