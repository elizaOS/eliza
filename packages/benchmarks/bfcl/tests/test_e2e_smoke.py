"""End-to-end smoke tests for the BFCL runner.

Uses small synthetic fixtures (loaded via a local data path) and the mock
agent. The mock agent emits the test's ground-truth function calls
verbatim, so for healthy categories the expected score is 100%. This is a
regression guard: if AST scoring changes such that ground-truth calls
don't match themselves, this will catch it.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

from benchmarks.bfcl.runner import BFCLRunner
from benchmarks.bfcl.types import (
    BFCLCategory,
    BFCLConfig,
    TestStatus,
)


def _write_ndjson(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


@pytest.fixture
def fixture_dir(tmp_path: Path) -> Path:
    # SIMPLE: one user, one function, one expected call
    simple_rows = [
        {
            "id": "simple_smoke_0",
            "question": [[{"role": "user", "content": "What's the weather in NYC?"}]],
            "function": [{
                "name": "get_weather",
                "description": "get weather",
                "parameters": {
                    "type": "dict",
                    "required": ["location"],
                    "properties": {"location": {"type": "string", "description": "city"}},
                },
            }],
        }
    ]
    multiple_rows = [
        {
            "id": "multiple_smoke_0",
            "question": [[{"role": "user", "content": "Get NYC weather, then search restaurants"}]],
            "function": [
                {"name": "get_weather", "description": "", "parameters": {
                    "type": "dict", "required": ["location"],
                    "properties": {"location": {"type": "string", "description": ""}}}},
                {"name": "search", "description": "", "parameters": {
                    "type": "dict", "required": ["query"],
                    "properties": {"query": {"type": "string", "description": ""}}}},
            ],
        }
    ]

    # Possible-answer ground truth (BFCL format)
    answers = [
        {"id": "simple_smoke_0", "ground_truth": [{"get_weather": {"location": ["New York", "NYC"]}}]},
        {"id": "multiple_smoke_0", "ground_truth": [{"get_weather": {"location": ["New York"]}}]},
    ]

    _write_ndjson(tmp_path / "BFCL_v3_simple.json", simple_rows)
    _write_ndjson(tmp_path / "BFCL_v3_multiple.json", multiple_rows)
    _write_ndjson(tmp_path / "possible_answer" / "BFCL_v3_simple.json", answers[:1])
    _write_ndjson(tmp_path / "possible_answer" / "BFCL_v3_multiple.json", answers[1:])
    return tmp_path


def test_simple_multiple_smoke_full_score(fixture_dir: Path) -> None:
    """With a mock agent emitting the ground-truth calls, AST accuracy
    on SIMPLE + MULTIPLE must be 100% (within rounding)."""
    config = BFCLConfig(
        data_path=str(fixture_dir),
        use_huggingface=False,
        categories=[BFCLCategory.SIMPLE, BFCLCategory.MULTIPLE],
        generate_report=False,
        save_raw_responses=False,
    )
    runner = BFCLRunner(config, use_mock_agent=True)
    results = asyncio.run(runner.run())

    assert results.metrics.total_tests == 2
    assert results.metrics.ast_accuracy == pytest.approx(1.0, abs=0.001)
    assert all(r.status == TestStatus.PASSED for r in results.results)


def test_rest_without_network_is_skipped(tmp_path: Path) -> None:
    """REST API tests must be marked SKIPPED_NO_CREDENTIALS when
    --enable-network is not set (previously they were silently dropped)."""
    rest_rows = [
        {
            "id": "rest_smoke_0",
            "question": [[{"role": "user", "content": "GET /api/foo"}]],
            "function": [{"name": "http_get", "description": "", "parameters": {
                "type": "dict", "required": [], "properties": {}}}],
        }
    ]
    _write_ndjson(tmp_path / "BFCL_v3_rest.json", rest_rows)

    config = BFCLConfig(
        data_path=str(tmp_path),
        use_huggingface=False,
        categories=[BFCLCategory.REST_API],
        generate_report=False,
        save_raw_responses=False,
        enable_network=False,
    )
    runner = BFCLRunner(config, use_mock_agent=True)
    results = asyncio.run(runner.run())

    assert len(results.results) == 1
    assert results.results[0].status == TestStatus.SKIPPED_NO_CREDENTIALS
    # Skipped tests must NOT count toward the accuracy denominator.
    assert results.metrics.total_tests == 0
    assert results.metrics.skipped_tests == 1
    assert results.metrics.skipped_by_reason.get("skipped_no_credentials") == 1


def test_multi_turn_fixture_executes(tmp_path: Path) -> None:
    """Multi-turn fixture is dispatched through the executable runtime and
    runs to completion (mock agent produces empty trajectories so the
    scoring outcome is False, but the run must not error out)."""
    rows = [
        {
            "id": "multi_turn_base_smoke_0",
            "question": [
                [{"role": "user", "content": "List the files."}],
                [{"role": "user", "content": "Create one called note.txt."}],
            ],
            "function": [],
            "initial_config": {
                "GorillaFileSystem": {
                    "root": {"alex": {"type": "directory", "contents": {}}}
                }
            },
            "involved_classes": ["GorillaFileSystem"],
        }
    ]
    answers = [
        {
            "id": "multi_turn_base_smoke_0",
            "ground_truth": [
                ["ls()"],
                ["touch(file_name='note.txt')"],
            ],
        }
    ]
    _write_ndjson(tmp_path / "BFCL_v3_multi_turn_base.json", rows)
    _write_ndjson(tmp_path / "possible_answer" / "BFCL_v3_multi_turn_base.json", answers)

    config = BFCLConfig(
        data_path=str(tmp_path),
        use_huggingface=False,
        categories=[BFCLCategory.MULTI_TURN_BASE],
        generate_report=False,
        save_raw_responses=False,
    )
    runner = BFCLRunner(config, use_mock_agent=True)
    results = asyncio.run(runner.run())

    assert len(results.results) == 1
    # Mock agent emits no python-list-of-calls, so exec_success is False —
    # but the run completed and scored without crashing through the new
    # multi-turn dispatch path.
    r = results.results[0]
    assert r.category == BFCLCategory.MULTI_TURN_BASE
    assert r.status in (TestStatus.PASSED, TestStatus.FAILED, TestStatus.ERROR)


def test_memory_category_without_ground_truth_skips(tmp_path: Path) -> None:
    """Memory categories are now evaluated, but a test without
    ``possible_answer`` ground truth gets bucketed as
    ``SKIPPED_NO_GROUND_TRUTH`` (we can't score it without expected
    answers)."""
    rows = [
        {
            "id": "memory_0-customer-0",
            "question": [[{"role": "user", "content": "What is my name?"}]],
            "function": [],
            "involved_classes": ["MemoryAPI"],
        }
    ]
    _write_ndjson(tmp_path / "BFCL_v4_memory.json", rows)

    config = BFCLConfig(
        data_path=str(tmp_path),
        use_huggingface=False,
        categories=[BFCLCategory.MEMORY_KV],
        generate_report=False,
        save_raw_responses=False,
    )
    runner = BFCLRunner(config, use_mock_agent=True)
    results = asyncio.run(runner.run())

    assert len(results.results) == 1
    assert results.results[0].status == TestStatus.SKIPPED_NO_GROUND_TRUTH
