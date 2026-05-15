"""Tests for GAIA dataset loading modes."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

from elizaos_gaia.dataset import DatasetAccessError, GAIADataset
from elizaos_gaia.types import TaskCategory, ToolType


@pytest.mark.asyncio
async def test_jsonl_fixture_resolves_attached_files() -> None:
    dataset = GAIADataset()
    fixture = Path(__file__).parent / "fixtures" / "local_gaia_sample.jsonl"

    questions = await dataset.load(source="jsonl", dataset_path=str(fixture))

    file_question = next(q for q in questions if q.task_id == "L1-FILE-001")
    assert file_question.file_path == fixture.parent / "attachments" / "access_note.txt"
    assert ToolType.FILE_READ in file_question.required_tools
    assert TaskCategory.FILE_PROCESSING in file_question.categories

    web_question = next(q for q in questions if q.task_id == "L2-WEB-001")
    assert ToolType.WEB_SEARCH in web_question.required_tools
    assert ToolType.WEB_BROWSE in web_question.required_tools
    assert TaskCategory.WEB_BROWSING in web_question.categories
    assert TaskCategory.MULTI_STEP_REASONING in web_question.categories


@pytest.mark.asyncio
async def test_builtin_sample_includes_file_and_research_tasks() -> None:
    dataset = GAIADataset()

    questions = await dataset.load(source="sample")

    file_question = next(q for q in questions if q.task_id == "S2-FILE-001")
    assert file_question.file_name == "sample_fact_sheet.txt"
    assert ToolType.FILE_READ in file_question.required_tools

    web_question = next(q for q in questions if q.task_id == "S3-WEB-001")
    assert ToolType.WEB_SEARCH in web_question.required_tools
    assert ToolType.WEB_BROWSE in web_question.required_tools


@pytest.mark.asyncio
async def test_parse_metadata_parquet(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import pandas as pd

    parquet_path = tmp_path / "metadata.parquet"
    parquet_path.write_bytes(b"parquet fixture placeholder")
    frame = pd.DataFrame(
        [
            {
                "task_id": "PARQUET-001",
                "Question": "Calculate 6 times 7.",
                "Final answer": "42",
                "Level": "1",
                "Annotator Metadata": {
                    "Steps": ["Calculate"],
                    "Tools": ["calculator"],
                    "Number of steps": 1,
                },
            }
        ]
    )
    monkeypatch.setattr(pd, "read_parquet", lambda path: frame)

    dataset = GAIADataset()
    questions = await dataset._parse_metadata_parquet(parquet_path)

    assert len(questions) == 1
    assert questions[0].task_id == "PARQUET-001"
    assert questions[0].final_answer == "42"
    assert ToolType.CALCULATOR in questions[0].required_tools


@pytest.mark.asyncio
async def test_gated_huggingface_error_is_actionable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def raise_gated(**_kwargs: object) -> str:
        raise RuntimeError("403 Cannot access gated repo")

    fake_hf = types.SimpleNamespace(snapshot_download=raise_gated)
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake_hf)

    dataset = GAIADataset(cache_dir=str(tmp_path))
    with pytest.raises(DatasetAccessError) as exc_info:
        await dataset.load(source="gaia", split="validation", hf_token=None)

    assert exc_info.value.is_gated is True
    assert "provide a token" in str(exc_info.value)
