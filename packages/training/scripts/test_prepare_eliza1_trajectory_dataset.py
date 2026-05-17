from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from format_for_training import format_record  # noqa: E402
from prepare_eliza1_trajectory_dataset import main as prepare_main  # noqa: E402


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists() or not path.read_text(encoding="utf-8").strip():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_prepare_native_rows_canonicalizes_aliases_and_splits_failures(tmp_path: Path) -> None:
    source = tmp_path / "native.jsonl"
    _write_jsonl(
        source,
        [
            {
                "format": "eliza_native_v1",
                "boundary": "vercel_ai_sdk.generateText",
                "status": "completed",
                "trajectoryId": "traj-ok",
                "stepIndex": 0,
                "request": {
                    "messages": [
                        {
                            "role": "user",
                            "content": "Run pwd. token sk-abcdefghijklmnopqrstuvwxyz",
                        }
                    ]
                },
                "response": {
                    "text": "",
                    "toolCalls": [
                        {
                            "id": "call_1",
                            "toolName": "SHELL_COMMAND",
                            "args": {"command": "pwd"},
                        }
                    ],
                    "usage": {"promptTokens": 5, "completionTokens": 2},
                },
                "metadata": {"source_dataset": "unit_native"},
            },
            {
                "format": "eliza_native_v1",
                "boundary": "vercel_ai_sdk.generateText",
                "status": "error",
                "trajectoryId": "traj-bad",
                "request": {"prompt": "hello"},
                "response": {"text": "failed"},
                "metadata": {"source_dataset": "unit_native"},
            },
        ],
    )
    out_dir = tmp_path / "out"

    code = prepare_main(
        [
            "--input",
            str(source),
            "--output-dir",
            str(out_dir),
            "--val-ratio",
            "0",
            "--test-ratio",
            "0",
        ]
    )

    assert code == 0
    train = _read_jsonl(out_dir / "train.jsonl")
    repair = _read_jsonl(out_dir / "repair_eval.jsonl")
    trajectory_train = _read_jsonl(out_dir / "trajectory_records" / "train.jsonl")
    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))

    assert len(train) == 1
    assert len(repair) == 1
    assert train[0]["format"] == "eliza_native_v1"
    assert train[0]["response"]["toolCalls"][0]["toolName"] == "SHELL"
    assert format_record(train[0]) is not None
    formatted = format_record(train[0])
    assert formatted is not None
    assert formatted["messages"][-1]["tool_calls"][0]["function"]["name"] == "SHELL"
    assert train[0]["metadata"]["quality"]["success"] is True
    assert repair[0]["metadata"]["quality"]["success"] is False
    assert repair[0]["metadata"]["split"] == "repair_eval"
    assert trajectory_train[0]["actions"] == [
        {"name": "SHELL", "originalName": "SHELL_COMMAND", "arguments": {"command": "pwd"}}
    ]
    assert trajectory_train[0]["messages"][-1]["tool_calls"][0]["function"]["name"] == "SHELL"
    assert "<REDACTED:openai-key>" in train[0]["request"]["messages"][0]["content"]
    assert manifest["recordSchema"] == "eliza_native_v1"
    assert manifest["trainingReadySchema"] == "eliza_native_v1"
    assert manifest["trajectoryRecordSchema"] == "eliza.eliza1_trajectory_record.v1"
    assert manifest["trainingFiles"] == {
        "test": "test.jsonl",
        "train": "train.jsonl",
        "val": "val.jsonl",
    }
    assert manifest["trajectoryFiles"]["train"] == "trajectory_records/train.jsonl"
    assert manifest["counts"] == {"repair_eval": 1, "test": 0, "train": 1, "val": 0}
    assert manifest["privacy"]["redactions"] == 1


def test_prepare_lifeops_result_uses_scores_and_alias_prefixes(tmp_path: Path) -> None:
    source = tmp_path / "lifeops.json"
    source.write_text(
        json.dumps(
            {
                "model_name": "unit-agent",
                "judge_model_name": "unit-judge",
                "pass_at_1": 0.5,
                "scenarios": [
                    {
                        "scenario_id": "lifeops-pay",
                        "instruction": "Show my spending dashboard.",
                        "seed": 1,
                        "turns": [
                            {
                                "turn_number": 1,
                                "agent_message": "Opening the dashboard.",
                                "agent_actions": [
                                    {"name": "PAYMENTS", "kwargs": {"subaction": "dashboard"}}
                                ],
                                "user_response": "",
                                "latency_ms": 12,
                                "input_tokens": 10,
                                "output_tokens": 4,
                                "cost_usd": 0.0,
                            }
                        ],
                        "state_hash_match": True,
                        "output_substring_matches": [True],
                        "total_score": 1.0,
                        "max_score": 1.0,
                        "terminated_reason": "respond",
                        "error": None,
                    },
                    {
                        "scenario_id": "lifeops-block",
                        "instruction": "Release the website block.",
                        "seed": 2,
                        "turns": [
                            {
                                "turn_number": 1,
                                "agent_message": "I could not release it.",
                                "agent_actions": [
                                    {
                                        "name": "WEBSITE_BLOCK_RELEASE",
                                        "kwargs": {"ruleId": "r1"},
                                    }
                                ],
                                "user_response": "",
                                "latency_ms": 12,
                                "input_tokens": 10,
                                "output_tokens": 4,
                                "cost_usd": 0.0,
                            }
                        ],
                        "state_hash_match": False,
                        "output_substring_matches": [False],
                        "total_score": 0.2,
                        "max_score": 1.0,
                        "terminated_reason": "respond",
                        "error": None,
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    out_dir = tmp_path / "out"

    code = prepare_main(
        [
            "--input",
            str(source),
            "--output-dir",
            str(out_dir),
            "--val-ratio",
            "0",
            "--test-ratio",
            "0",
            "--output-format",
            "trajectory-record",
        ]
    )

    assert code == 0
    train = _read_jsonl(out_dir / "train.jsonl")
    repair = _read_jsonl(out_dir / "repair_eval.jsonl")

    assert len(train) == 1
    assert train[0]["source"]["kind"] == "lifeops_bench_result"
    assert train[0]["actions"][0]["name"] == "PAYMENT"
    assert train[0]["quality"]["weight"] == 1.0
    assert len(repair) == 1
    assert repair[0]["actions"][0]["name"] == "BLOCK_RELEASE"
    assert repair[0]["quality"]["success"] is False
    assert repair[0]["split"] == "repair_eval"


def test_prepare_preserves_and_canonicalizes_request_history_tool_calls(tmp_path: Path) -> None:
    source = tmp_path / "native-history.jsonl"
    _write_jsonl(
        source,
        [
            {
                "format": "eliza_native_v1",
                "boundary": "vercel_ai_sdk.generateText",
                "request": {
                    "messages": [
                        {"role": "user", "content": "Check the cwd."},
                        {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "hist_1",
                                    "type": "function",
                                    "function": {
                                        "name": "SHELL_COMMAND",
                                        "arguments": "{\"command\":\"pwd\"}",
                                    },
                                }
                            ],
                        },
                        {"role": "tool", "tool_call_id": "hist_1", "content": "/tmp/project"},
                        {"role": "user", "content": "List files now."},
                    ]
                },
                "response": {
                    "tool_calls": [
                        {
                            "id": "call_2",
                            "function": {
                                "name": "RUN_COMMAND",
                                "arguments": {"command": "ls"},
                            },
                        }
                    ]
                },
                "metadata": {"source_dataset": "unit_native"},
            }
        ],
    )
    out_dir = tmp_path / "out"

    code = prepare_main(
        [
            "--input",
            str(source),
            "--output-dir",
            str(out_dir),
            "--val-ratio",
            "0",
            "--test-ratio",
            "0",
        ]
    )

    assert code == 0
    train = _read_jsonl(out_dir / "train.jsonl")
    trajectory_train = _read_jsonl(out_dir / "trajectory_records" / "train.jsonl")
    formatted = format_record(train[0])

    assert train[0]["request"]["messages"][1]["tool_calls"][0]["function"]["name"] == "SHELL"
    assert train[0]["response"]["toolCalls"][0]["toolName"] == "SHELL"
    assert train[0]["request"]["tools"][0]["function"]["name"] == "SHELL"
    assert trajectory_train[0]["messages"][1]["tool_calls"][0]["function"] == {
        "name": "SHELL",
        "arguments": {"command": "pwd"},
    }
    assert formatted is not None
    assert formatted["messages"][1]["tool_calls"][0]["function"]["name"] == "SHELL"


def test_prepare_keeps_requested_success_splits_non_empty(tmp_path: Path) -> None:
    source = tmp_path / "small-native.jsonl"
    rows = []
    for idx in range(3):
        rows.append(
            {
                "format": "eliza_native_v1",
                "boundary": "vercel_ai_sdk.generateText",
                "status": "completed",
                "trajectoryId": f"traj-{idx}",
                "stepIndex": idx,
                "request": {"prompt": f"Say hello {idx}."},
                "response": {"text": f"hello {idx}"},
                "metadata": {"source_dataset": "unit_native"},
            }
        )
    _write_jsonl(source, rows)
    out_dir = tmp_path / "out"

    code = prepare_main(
        [
            "--input",
            str(source),
            "--output-dir",
            str(out_dir),
            "--val-ratio",
            "0.05",
            "--test-ratio",
            "0.05",
        ]
    )

    assert code == 0
    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["counts"]["train"] == 1
    assert manifest["counts"]["val"] == 1
    assert manifest["counts"]["test"] == 1
    assert len(_read_jsonl(out_dir / "train.jsonl")) == 1
    assert len(_read_jsonl(out_dir / "val.jsonl")) == 1
    assert len(_read_jsonl(out_dir / "test.jsonl")) == 1


def test_prepare_strict_privacy_fails_on_any_redaction(tmp_path: Path) -> None:
    source = tmp_path / "native-private.jsonl"
    _write_jsonl(
        source,
        [
            {
                "format": "eliza_native_v1",
                "boundary": "vercel_ai_sdk.generateText",
                "request": {"prompt": "My location: 37.7749, -122.4194"},
                "response": {"text": "I cannot store that."},
            }
        ],
    )

    with pytest.raises(SystemExit, match="strict privacy filter found redaction"):
        prepare_main(
            [
                "--input",
                str(source),
                "--output-dir",
                str(tmp_path / "out"),
                "--strict-privacy",
            ]
        )
