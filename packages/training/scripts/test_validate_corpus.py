from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR.parent))

from validate_corpus import run as validate_corpus_run  # noqa: E402


def _attestation(*, passed: bool = True) -> dict[str, Any]:
    return {
        "schema": "eliza.privacy_filter_attestation.v1",
        "version": 1,
        "source": "unit",
        "redacted": True,
        "reviewed": True,
        "passed": passed,
    }


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def _native_row(
    *,
    trajectory_id: str = "traj-a",
    text: str = "what is 2+2?",
    response_text: str = "4",
    attested: bool = True,
    attestation_passed: bool = True,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "format": "eliza_native_v1",
        "boundary": "vercel_ai_sdk.generateText",
        "trajectoryId": trajectory_id,
        "request": {"messages": [{"role": "user", "content": text}]},
        "response": {"text": response_text},
        "metadata": {
            "task_type": "response",
            "source_dataset": "unit_native",
        },
    }
    if attested:
        row["metadata"]["privacy_attestation"] = _attestation(
            passed=attestation_passed
        )
    return row


def test_validate_corpus_rejects_missing_native_privacy_attestation(
    tmp_path: Path,
) -> None:
    corpus = tmp_path / "native.jsonl"
    report = tmp_path / "report.json"
    _write_jsonl(corpus, [_native_row(attested=False)])

    code = validate_corpus_run(corpus, report, strict=True, max_records=None)

    assert code == 1
    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert parsed["invalid_records"] == 1
    assert (
        parsed["errors_by_task_type"]["response"][
            "native_v1_missing_privacy_attestation"
        ]
        == 1
    )


def test_validate_corpus_rejects_failed_native_privacy_attestation(
    tmp_path: Path,
) -> None:
    corpus = tmp_path / "native.jsonl"
    report = tmp_path / "report.json"
    _write_jsonl(corpus, [_native_row(attestation_passed=False)])

    code = validate_corpus_run(corpus, report, strict=True, max_records=None)

    assert code == 1
    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert parsed["invalid_records"] == 1
    assert (
        parsed["errors_by_task_type"]["response"][
            "native_v1_missing_privacy_attestation"
        ]
        == 1
    )


def test_validate_corpus_rejects_duplicate_native_content(tmp_path: Path) -> None:
    source = tmp_path / "dupes.jsonl"
    _write_jsonl(
        source,
        [
            _native_row(trajectory_id="traj-a"),
            _native_row(trajectory_id="traj-b"),
        ],
    )
    report = tmp_path / "report.json"

    code = validate_corpus_run(source, report, strict=True, max_records=None)

    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert code == 1
    assert parsed["invalid_records"] == 1
    assert parsed["errors_by_task_type"]["response"]["duplicate_native_content"] == 1
    assert parsed["errors_by_task_type"]["response"]["duplicate_content_hash"] == 1
    assert "first seen on line 1" in parsed["first_50_failing_records"][0]["fix_hint"]
    assert "duplicates line 1" in parsed["first_50_failing_records"][0]["fix_hint"]


def test_validate_corpus_accepts_distinct_native_content(tmp_path: Path) -> None:
    source = tmp_path / "distinct.jsonl"
    _write_jsonl(
        source,
        [
            _native_row(trajectory_id="traj-a"),
            _native_row(trajectory_id="traj-b", response_text="four"),
        ],
    )
    report = tmp_path / "report.json"

    code = validate_corpus_run(source, report, strict=True, max_records=None)

    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert code == 0
    assert parsed["invalid_records"] == 0
