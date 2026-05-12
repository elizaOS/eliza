"""Tests for ``orchestrator.trajectory_normalize_hook``.

Verifies that, for each supported harness (eliza, openclaw, hermes),
the hook scans an output directory, picks the right normalizer, and
writes a single ``trajectory.canonical.jsonl`` file with the expected
number of entries. Also pins the "no matching artifacts" no-op
behavior and the failure path that surfaces an error but never
raises.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent))  # so `benchmarks.orchestrator...` resolves

from orchestrator.trajectory_normalize_hook import normalize_outcome_trajectories  # noqa: E402


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")


def test_normalize_eliza_writes_canonical(tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    _write_jsonl(
        output_dir / "trajectory.jsonl",
        [
            {
                "format": "eliza_native_v1",
                "boundary": "vercel_ai_sdk.generateText",
                "request": {"messages": [{"role": "user", "content": "hi"}]},
                "response": {"text": "yo"},
            },
            {
                "format": "eliza_native_v1",
                "boundary": "vercel_ai_sdk.generateText",
                "request": {"messages": [{"role": "user", "content": "more"}]},
                "response": {"text": "ok"},
            },
        ],
    )

    count, error, path = normalize_outcome_trajectories(
        output_dir,
        harness="eliza",
        benchmark_id="bfcl",
        task_id="task-1",
    )
    assert error is None
    assert count == 2
    assert path is not None
    assert path.name == "trajectory.canonical.jsonl"

    raw_lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    parsed = [json.loads(ln) for ln in raw_lines]
    assert all(row["agent_id"] == "eliza" for row in parsed)
    assert all(row["benchmark_id"] == "bfcl" for row in parsed)
    assert [row["step_index"] for row in parsed] == [0, 1]


def test_normalize_openclaw_writes_canonical(tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    (output_dir / "openclaw_response.json").write_text(
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

    count, error, path = normalize_outcome_trajectories(
        output_dir,
        harness="openclaw",
        benchmark_id="bfcl",
        task_id="task-7",
    )
    assert error is None
    assert count == 2
    assert path is not None

    parsed = [
        json.loads(ln)
        for ln in path.read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    assert all(row["agent_id"] == "openclaw" for row in parsed)
    assert all(row["task_id"] == "task-7" for row in parsed)


def test_normalize_hermes_samples_jsonl(tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    _write_jsonl(
        output_dir / "samples.jsonl",
        [
            {
                "messages": [
                    {"from": "human", "value": "please call x"},
                    {
                        "from": "gpt",
                        "value": '<tool_call>{"name":"x","arguments":{"a":1}}</tool_call>',
                    },
                ],
                "tools": [{"name": "x"}],
            },
            {
                "messages": [
                    {"from": "human", "value": "another"},
                    {"from": "gpt", "value": "done"},
                ],
                "tools": [],
            },
        ],
    )

    count, error, path = normalize_outcome_trajectories(
        output_dir,
        harness="hermes",
        benchmark_id="bfcl",
        task_id="task-h",
        model="hermes-test",
    )
    assert error is None
    assert count == 2
    assert path is not None

    parsed = [
        json.loads(ln)
        for ln in path.read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    assert all(row["agent_id"] == "hermes" for row in parsed)
    assert parsed[0]["response"]["toolCalls"][0]["name"] == "x"
    assert parsed[1]["response"]["text"] == "done"


def test_normalize_no_matching_artifacts_is_noop(tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    # Drop an unrelated file in.
    (output_dir / "irrelevant.json").write_text("{}", encoding="utf-8")

    count, error, path = normalize_outcome_trajectories(
        output_dir,
        harness="eliza",
        benchmark_id="bfcl",
        task_id="task-noop",
    )
    assert count == 0
    assert error is None
    assert path is None
    # No canonical file written.
    assert not (output_dir / "trajectory.canonical.jsonl").exists()


def test_normalize_handles_corrupt_input_without_raising(tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    # An openclaw file whose JSON parses but has the wrong shape — no
    # ``messages`` key — should be silently ignored, not raise.
    (output_dir / "openclaw_bad.json").write_text(
        json.dumps({"unexpected": "shape"}), encoding="utf-8"
    )
    count, error, path = normalize_outcome_trajectories(
        output_dir,
        harness="openclaw",
        benchmark_id="bfcl",
        task_id="task-bad",
    )
    assert count == 0
    assert error is None
    assert path is None


def test_normalize_unknown_harness_is_noop(tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    _write_jsonl(
        output_dir / "trajectory.jsonl",
        [
            {
                "format": "eliza_native_v1",
                "request": {},
                "response": {},
            }
        ],
    )
    count, error, path = normalize_outcome_trajectories(
        output_dir,
        harness="random_v1",  # not a real harness for normalization
        benchmark_id="bfcl",
        task_id="t",
    )
    assert count == 0
    assert error is None
    assert path is None
