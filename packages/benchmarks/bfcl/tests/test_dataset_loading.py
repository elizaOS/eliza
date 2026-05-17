"""Dataset loading regression tests for BFCL compact local fixtures."""

from __future__ import annotations

import asyncio
import builtins
import json
from pathlib import Path
from typing import Any

from benchmarks.bfcl.dataset import BFCLDataset
from benchmarks.bfcl.types import BFCLCategory, BFCLConfig


def _write_ndjson(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")


def test_local_loader_only_reads_selected_possible_answer_file(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Partial category runs should not parse unrelated answer files."""
    _write_ndjson(
        tmp_path / "BFCL_v3_simple.json",
        [
            {
                "id": "simple_only_0",
                "question": [[{"role": "user", "content": "weather"}]],
                "function": [
                    {
                        "name": "get_weather",
                        "description": "",
                        "parameters": {
                            "type": "dict",
                            "required": ["location"],
                            "properties": {
                                "location": {"type": "string", "description": ""}
                            },
                        },
                    }
                ],
            }
        ],
    )
    _write_ndjson(
        tmp_path / "possible_answer" / "BFCL_v3_simple.json",
        [{"id": "simple_only_0", "ground_truth": [{"get_weather": {"location": ["SF"]}}]}],
    )
    _write_ndjson(
        tmp_path / "possible_answer" / "BFCL_v3_multiple.json",
        [{"id": "should_not_be_opened", "ground_truth": []}],
    )

    real_open = builtins.open

    def guarded_open(file: Any, *args: Any, **kwargs: Any):
        if str(file).endswith("possible_answer/BFCL_v3_multiple.json"):
            raise AssertionError("unrelated possible_answer file was opened")
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", guarded_open)

    dataset = BFCLDataset(
        BFCLConfig(
            data_path=str(tmp_path),
            use_huggingface=False,
            categories=[BFCLCategory.SIMPLE],
        )
    )
    asyncio.run(dataset.load())

    loaded = list(dataset)
    assert [tc.id for tc in loaded] == ["simple_only_0"]
    assert loaded[0].expected_calls[0].arguments == {"location": "SF"}


def test_iter_local_records_streams_ndjson_first_record(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """NDJSON iteration should not slurp the full file before first yield."""
    target = tmp_path / "BFCL_v3_simple.json"
    target.write_text('{"id":"first"}\n{"id":"second"}\n', encoding="utf-8")

    class StreamingFile:
        def __init__(self) -> None:
            self._fh = target.open("r", encoding="utf-8")

        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            self._fh.close()

        def read(self, size: int = -1) -> str:
            if size == -1:
                raise AssertionError("NDJSON loader read the full file")
            return self._fh.read(size)

        def readline(self) -> str:
            return self._fh.readline()

        def __iter__(self):
            return self._fh.__iter__()

    monkeypatch.setattr(
        builtins,
        "open",
        lambda *_args, **_kwargs: StreamingFile(),
    )

    iterator = BFCLDataset._iter_local_records(target)
    assert next(iterator) == {"id": "first"}
