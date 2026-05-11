"""Tests for ``lib.trajectory_normalizer``.

The module is stdlib-only and is consumed by both Python tooling and
the Node-side viewer, so the tests pin the on-disk schema and the
edge-cases around Hermes' XML-tagged tool calls.
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path

import pytest

# Make `lib.trajectory_normalizer` importable when the test is run from
# anywhere — the package is not pip-installed.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib.trajectory_normalizer import (  # noqa: E402
    CanonicalEntry,
    align_by_step,
    cli,
    normalize_eliza_jsonl,
    normalize_hermes_samples_jsonl,
    normalize_openclaw_response,
    write_canonical_jsonl,
)


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")


def test_eliza_passthrough(tmp_path: Path) -> None:
    src = tmp_path / "eliza.jsonl"
    rows = [
        {
            "format": "eliza_native_v1",
            "boundary": "vercel_ai_sdk.generateText",
            "request": {"messages": [{"role": "user", "content": "hello"}]},
            "response": {"text": "hi"},
        },
        {
            "format": "eliza_native_v1",
            "boundary": "vercel_ai_sdk.streamText",
            "request": {"messages": [{"role": "user", "content": "again"}]},
            "response": {"text": "yo"},
        },
    ]
    _write_jsonl(src, rows)

    entries = normalize_eliza_jsonl(src, benchmark_id="b1", task_id="t1")
    assert len(entries) == 2
    assert entries[0].format == "eliza_native_v1"
    assert entries[0].boundary == "vercel_ai_sdk.generateText"
    assert entries[0].request == rows[0]["request"]
    assert entries[0].response == rows[0]["response"]
    assert entries[0].agent_id == "eliza"
    assert entries[0].benchmark_id == "b1"
    assert entries[0].task_id == "t1"
    assert entries[0].step_index == 0
    assert entries[1].step_index == 1
    assert entries[1].boundary == "vercel_ai_sdk.streamText"


def test_eliza_passthrough_skips_blank_and_malformed_lines(tmp_path: Path) -> None:
    src = tmp_path / "eliza.jsonl"
    src.write_text(
        "\n".join(
            [
                "",
                json.dumps(
                    {
                        "format": "eliza_native_v1",
                        "request": {"prompt": "p"},
                        "response": {"text": "r"},
                    }
                ),
                "{not valid json",
                "",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    entries = normalize_eliza_jsonl(src, benchmark_id="b", task_id="t")
    assert len(entries) == 1
    assert entries[0].step_index == 0


def test_eliza_passthrough_preserves_native_metadata_and_cache_stats(
    tmp_path: Path,
) -> None:
    src = tmp_path / "eliza.jsonl"
    row = {
        "format": "eliza_native_v1",
        "boundary": "vercel_ai_sdk.generateText",
        "scenarioId": "scenario-1",
        "batchId": "batch-1",
        "request": {"prompt": "p"},
        "response": {
            "text": "r",
            "usage": {
                "promptTokens": 100,
                "completionTokens": 20,
                "cacheReadInputTokens": 40,
            },
        },
        "metadata": {"suite": "loca", "seed": 7},
        "trajectoryTotals": {
            "promptTokens": 100,
            "completionTokens": 20,
            "cacheReadInputTokens": 40,
        },
        "cacheStats": {
            "totalInputTokens": 100,
            "cacheReadInputTokens": 40,
            "cacheReadCallCount": 1,
        },
    }
    _write_jsonl(src, [row])

    entry = normalize_eliza_jsonl(src, benchmark_id="b", task_id="t")[0]
    payload = json.loads(entry.to_json())

    assert entry.scenarioId == "scenario-1"
    assert entry.batchId == "batch-1"
    assert entry.metadata == {"suite": "loca", "seed": 7}
    assert entry.trajectoryTotals["cacheReadInputTokens"] == 40
    assert entry.cacheStats["cacheReadCallCount"] == 1
    assert payload["cacheStats"]["cacheReadInputTokens"] == 40


def test_openclaw_two_turn() -> None:
    response = {
        "messages": [
            {"role": "user", "content": "hi"},
            {
                "role": "assistant",
                "content": "hello",
                "tool_calls": [{"name": "f", "arguments": {}}],
            },
        ],
        "session_id": "abc",
    }
    entries = normalize_openclaw_response(
        response, benchmark_id="b", task_id="t", model="claude-opus-4-7"
    )
    assert len(entries) == 1
    e = entries[0]
    assert e.boundary == "openclaw_agent_v1"
    assert e.agent_id == "openclaw"
    assert e.model == "claude-opus-4-7"
    assert e.request["messages"] == [{"role": "user", "content": "hi"}]
    assert e.response["text"] == "hello"
    assert e.response["toolCalls"] == [
        {"name": "f", "arguments": {}, "id": "", "result": None}
    ]


def test_openclaw_openai_function_shape() -> None:
    """OpenClaw sometimes emits OpenAI's nested ``function`` shape with
    string-encoded ``arguments``. Both shapes must normalize to the
    same canonical form."""
    response = {
        "messages": [
            {"role": "user", "content": "do thing"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_42",
                        "type": "function",
                        "function": {
                            "name": "do_thing",
                            "arguments": json.dumps({"x": 1}),
                        },
                    }
                ],
            },
        ],
        "session_id": "abc",
    }
    entries = normalize_openclaw_response(response, benchmark_id="b", task_id="t")
    assert len(entries) == 1
    tc = entries[0].response["toolCalls"][0]
    assert tc == {
        "name": "do_thing",
        "arguments": {"x": 1},
        "id": "call_42",
        "result": None,
    }


def test_openclaw_multi_assistant_turn_step_index() -> None:
    response = {
        "messages": [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "a1"},
            {"role": "tool", "content": "t1"},
            {"role": "assistant", "content": "a2"},
        ]
    }
    entries = normalize_openclaw_response(response, benchmark_id="b", task_id="t")
    assert len(entries) == 2
    assert entries[0].step_index == 0
    assert entries[1].step_index == 1
    # The second assistant turn sees three prior messages.
    assert len(entries[1].request["messages"]) == 3
    assert entries[1].request["messages"][-1] == {"role": "tool", "content": "t1"}


def test_hermes_xml_tool_call_parses(tmp_path: Path) -> None:
    src = tmp_path / "samples.jsonl"
    row = {
        "messages": [
            {"from": "human", "value": "please call x"},
            {
                "from": "gpt",
                "value": 'sure\n<tool_call>{"name":"x","arguments":{"a":1}}</tool_call>',
            },
        ],
        "tools": [{"name": "x"}],
        "reward": 1.0,
    }
    _write_jsonl(src, [row])

    entries = normalize_hermes_samples_jsonl(src, benchmark_id="b", task_id="t")
    assert len(entries) == 1
    e = entries[0]
    assert e.boundary == "hermes_atropos_v1"
    assert e.agent_id == "hermes"
    # Prefix message rolls into request.messages with the role remapped.
    assert e.request["messages"] == [{"role": "user", "content": "please call x"}]
    # The cleaned content drops the tag and keeps the prefix text.
    assert e.response["text"] == "sure"
    assert e.response["toolCalls"] == [
        {"name": "x", "arguments": {"a": 1}, "id": "", "result": None}
    ]


def test_hermes_role_mapping(tmp_path: Path) -> None:
    src = tmp_path / "samples.jsonl"
    row = {
        "messages": [
            {"from": "system", "value": "be useful"},
            {"from": "human", "value": "hello"},
            {"from": "gpt", "value": '<tool_call>{"name":"f","arguments":{}}</tool_call>'},
            {"from": "tool", "value": {"ok": True}},
            {"from": "gpt", "value": "done"},
        ],
        "tools": [],
    }
    _write_jsonl(src, [row])

    entries = normalize_hermes_samples_jsonl(src, benchmark_id="b", task_id="t")
    assert len(entries) == 1
    msgs = entries[0].request["messages"]
    roles = [m["role"] for m in msgs]
    assert roles == ["system", "user", "assistant", "tool"]
    # The tool-role value was a dict — it must serialize to a string.
    assert msgs[-1]["content"] == json.dumps({"ok": True})
    # The final ``gpt`` turn is the response.
    assert entries[0].response["text"] == "done"
    assert "toolCalls" not in entries[0].response


def test_hermes_malformed_tool_call_dropped_silently(tmp_path: Path) -> None:
    src = tmp_path / "samples.jsonl"
    row = {
        "messages": [
            {"from": "human", "value": "do it"},
            {"from": "gpt", "value": "trying <tool_call>{not json}</tool_call>"},
        ],
        "tools": [],
    }
    _write_jsonl(src, [row])
    entries = normalize_hermes_samples_jsonl(src, benchmark_id="b", task_id="t")
    assert len(entries) == 1
    assert entries[0].response.get("text") == "trying"
    assert "toolCalls" not in entries[0].response


def test_hermes_unclosed_tool_call_tolerated(tmp_path: Path) -> None:
    """Hermes' own parser tolerates truncated `<tool_call>...` at EOS;
    we should too."""
    src = tmp_path / "samples.jsonl"
    row = {
        "messages": [
            {"from": "human", "value": "go"},
            {"from": "gpt", "value": '<tool_call>{"name":"truncated","arguments":{"k":2}}'},
        ],
        "tools": [],
    }
    _write_jsonl(src, [row])
    entries = normalize_hermes_samples_jsonl(src, benchmark_id="b", task_id="t")
    assert entries[0].response["toolCalls"] == [
        {"name": "truncated", "arguments": {"k": 2}, "id": "", "result": None}
    ]


def test_write_canonical_jsonl_roundtrips(tmp_path: Path) -> None:
    entries = [
        CanonicalEntry(
            boundary="openclaw_agent_v1",
            request={"messages": [{"role": "user", "content": "u"}]},
            response={"text": "a"},
            agent_id="openclaw",
            benchmark_id="b",
            task_id="t",
            step_index=0,
        ),
        CanonicalEntry(
            boundary="hermes_atropos_v1",
            request={"messages": []},
            response={
                "text": "x",
                "toolCalls": [
                    {"name": "f", "arguments": {"deep": {"k": [1, 2]}}, "id": "i", "result": None}
                ],
            },
            agent_id="hermes",
            benchmark_id="b",
            task_id="t",
            step_index=1,
        ),
        CanonicalEntry(
            boundary="vercel_ai_sdk.generateText",
            request={"prompt": "p", "messages": []},
            response={"text": "r"},
            agent_id="eliza",
            benchmark_id="b",
            task_id="t",
            step_index=2,
        ),
    ]
    out = tmp_path / "out.jsonl"
    written = write_canonical_jsonl(entries, out)
    assert written == 3

    raw = out.read_text(encoding="utf-8")
    lines = [ln for ln in raw.splitlines() if ln]
    assert len(lines) == 3
    # No trailing whitespace per line.
    for ln in lines:
        assert ln == ln.rstrip()
        assert "\n" not in ln

    parsed = [json.loads(ln) for ln in lines]
    for original, roundtrip in zip(entries, parsed):
        assert roundtrip == asdict(original)


def test_write_canonical_jsonl_creates_parent_dir(tmp_path: Path) -> None:
    out = tmp_path / "deep" / "nested" / "out.jsonl"
    written = write_canonical_jsonl([CanonicalEntry()], out)
    assert written == 1
    assert out.exists()


def test_align_by_step_unequal_length() -> None:
    a = [CanonicalEntry(step_index=i) for i in range(3)]
    b = [CanonicalEntry(step_index=i) for i in range(5)]
    pairs = align_by_step(a, b)
    assert len(pairs) == 5
    assert pairs[2][0] is a[2]
    assert pairs[3][0] is None
    assert pairs[3][1] is b[3]
    assert pairs[4][0] is None
    assert pairs[4][1] is b[4]


def test_align_by_step_empty() -> None:
    assert align_by_step([], []) == []


def test_canonical_entry_to_json_is_compact() -> None:
    e = CanonicalEntry(
        request={"messages": [{"role": "user", "content": "hi"}]},
        response={"text": "yo", "toolCalls": [{"name": "f", "arguments": {"k": 1}}]},
    )
    raw = e.to_json()
    # No whitespace separators.
    assert ": " not in raw
    assert ", " not in raw
    # Survives roundtrip.
    parsed = json.loads(raw)
    assert parsed["response"]["toolCalls"][0]["arguments"] == {"k": 1}


def test_cli_normalize_openclaw_from_json(tmp_path: Path) -> None:
    fixture = tmp_path / "openclaw.json"
    fixture.write_text(
        json.dumps(
            {
                "messages": [
                    {"role": "user", "content": "u1"},
                    {"role": "assistant", "content": "a1"},
                    {"role": "user", "content": "u2"},
                    {"role": "assistant", "content": "a2"},
                ],
                "session_id": "s",
            }
        ),
        encoding="utf-8",
    )
    out = tmp_path / "out.jsonl"
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "lib" / "trajectory_normalizer.py"),
            "normalize",
            "--agent",
            "openclaw",
            "--input",
            str(fixture),
            "--output",
            str(out),
            "--benchmark",
            "demo",
            "--task",
            "t1",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    raw = out.read_text(encoding="utf-8")
    lines = [ln for ln in raw.splitlines() if ln]
    assert len(lines) == 2
    parsed = [json.loads(ln) for ln in lines]
    assert parsed[0]["boundary"] == "openclaw_agent_v1"
    assert parsed[0]["benchmark_id"] == "demo"
    assert parsed[0]["task_id"] == "t1"
    assert parsed[0]["step_index"] == 0
    assert parsed[1]["step_index"] == 1


def test_cli_diff_outputs_aligned_pairs(tmp_path: Path) -> None:
    a_path = tmp_path / "a.jsonl"
    b_path = tmp_path / "b.jsonl"
    write_canonical_jsonl(
        [CanonicalEntry(step_index=i, agent_id="a") for i in range(2)], a_path
    )
    write_canonical_jsonl(
        [CanonicalEntry(step_index=i, agent_id="b") for i in range(3)], b_path
    )

    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "lib" / "trajectory_normalizer.py"),
            "diff",
            "--a",
            str(a_path),
            "--b",
            str(b_path),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert len(payload) == 3
    assert payload[2]["a"] is None
    assert payload[2]["b"]["agent_id"] == "b"


def test_cli_requires_subcommand(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["trajectory_normalizer"])
    with pytest.raises(SystemExit):
        cli()
