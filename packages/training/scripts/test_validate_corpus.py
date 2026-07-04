from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from validate_corpus import run as validate_corpus_run  # noqa: E402


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def _native_row(*, trajectory_id: str, response_text: str = "4") -> dict:
    return {
        "format": "eliza_native_v1",
        "boundary": "vercel_ai_sdk.generateText",
        "trajectoryId": trajectory_id,
        "request": {"messages": [{"role": "user", "content": "what is 2+2?"}]},
        "response": {"text": response_text},
        "metadata": {"source_dataset": "unit_validate"},
    }


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
    assert parsed["errors_by_task_type"]["__none__"]["duplicate_native_content"] == 1
    assert "first seen on line 1" in parsed["first_50_failing_records"][0]["fix_hint"]


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
