from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from prepare_eliza1_trajectory_dataset import main as prepare_main  # noqa: E402
from validate_eliza1_trajectory_dataset import main as validate_main  # noqa: E402


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists() or not path.read_text(encoding="utf-8").strip():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _write_manifest(path: Path, names: list[str]) -> None:
    path.write_text(
        json.dumps(
            {
                "actions": [
                    {
                        "type": "function",
                        "function": {
                            "name": name,
                            "description": "",
                            "parameters": {
                                "type": "object",
                                "properties": {},
                                "additionalProperties": True,
                            },
                        },
                    }
                    for name in names
                ]
            }
        ),
        encoding="utf-8",
    )


def _prepared_output(tmp_path: Path) -> tuple[Path, Path]:
    source = tmp_path / "native.jsonl"
    _write_jsonl(
        source,
        [
            {
                "format": "eliza_native_v1",
                "boundary": "vercel_ai_sdk.generateText",
                "request": {"prompt": "Run pwd."},
                "response": {
                    "toolCalls": [
                        {"id": "c1", "name": "RUN_COMMAND", "arguments": {"command": "pwd"}}
                    ]
                },
                "metadata": {"source_dataset": "unit"},
            }
        ],
    )
    action_manifest = tmp_path / "actions.json"
    _write_manifest(action_manifest, ["SHELL"])
    out_dir = tmp_path / "out"
    assert (
        prepare_main(
            [
                "--input",
                str(source),
                "--output-dir",
                str(out_dir),
                "--action-manifest",
                str(action_manifest),
                "--val-ratio",
                "0",
                "--test-ratio",
                "0",
            ]
        )
        == 0
    )
    return out_dir, action_manifest


def test_validate_prepared_dataset_with_action_manifest(tmp_path: Path) -> None:
    out_dir, action_manifest = _prepared_output(tmp_path)
    report = tmp_path / "report.json"

    code = validate_main(
        [
            "--input",
            str(out_dir / "train.jsonl"),
            "--report",
            str(report),
            "--action-manifest",
            str(action_manifest),
            "--strict",
        ]
    )

    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert code == 0
    assert parsed["totalRecords"] == 1
    assert parsed["invalidRecords"] == 0
    assert parsed["actionCounts"] == {"SHELL": 1}


def test_validate_trajectory_records_with_action_manifest(tmp_path: Path) -> None:
    out_dir, action_manifest = _prepared_output(tmp_path)
    report = tmp_path / "trajectory-report.json"

    code = validate_main(
        [
            "--input",
            str(out_dir / "trajectory_records" / "train.jsonl"),
            "--report",
            str(report),
            "--action-manifest",
            str(action_manifest),
            "--strict",
        ]
    )

    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert code == 0
    assert parsed["totalRecords"] == 1
    assert parsed["invalidRecords"] == 0
    assert parsed["actionCounts"] == {"SHELL": 1}


def test_validate_rejects_noncanonical_native_alias(tmp_path: Path) -> None:
    out_dir, _action_manifest = _prepared_output(tmp_path)
    row = _read_jsonl(out_dir / "train.jsonl")[0]
    row["request"]["tools"][0]["function"]["name"] = "SHELL_COMMAND"
    row["response"]["toolCalls"][0]["toolName"] = "SHELL_COMMAND"
    bad = tmp_path / "bad.jsonl"
    _write_jsonl(bad, [row])
    report = tmp_path / "bad-report.json"

    code = validate_main(["--input", str(bad), "--report", str(report), "--strict"])

    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert code == 1
    assert parsed["errorsByCode"]["noncanonical_action_alias"] >= 2


def test_validate_rejects_native_action_missing_from_manifest(tmp_path: Path) -> None:
    out_dir, _action_manifest = _prepared_output(tmp_path)
    row = _read_jsonl(out_dir / "train.jsonl")[0]
    missing_manifest = tmp_path / "actions.json"
    _write_manifest(missing_manifest, ["MONEY"])
    bad = tmp_path / "unknown.jsonl"
    _write_jsonl(bad, [row])
    report = tmp_path / "unknown-report.json"

    code = validate_main(
        [
            "--input",
            str(bad),
            "--report",
            str(report),
            "--action-manifest",
            str(missing_manifest),
            "--strict",
        ]
    )

    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert code == 1
    assert parsed["errorsByCode"]["action_not_in_manifest"] >= 1


def test_validate_rejects_native_tool_call_not_declared(tmp_path: Path) -> None:
    out_dir, action_manifest = _prepared_output(tmp_path)
    row = _read_jsonl(out_dir / "train.jsonl")[0]
    row["request"].pop("tools")
    bad = tmp_path / "undeclared.jsonl"
    _write_jsonl(bad, [row])
    report = tmp_path / "undeclared-report.json"

    code = validate_main(
        [
            "--input",
            str(bad),
            "--report",
            str(report),
            "--action-manifest",
            str(action_manifest),
            "--strict",
        ]
    )

    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert code == 1
    assert parsed["errorsByCode"]["tool_call_not_declared"] >= 1
