"""Locks the automatic BFCL campaign to the complete pinned v3 scoring corpus."""

from __future__ import annotations

from pathlib import Path

import pytest

import benchmarks.bfcl.dataset as dataset_module
from benchmarks.bench_cli_types import ModelSpec
from benchmarks.bfcl.dataset import BFCLDataset
from benchmarks.bfcl.types import (
    BFCLCategory,
    BFCLConfig,
    BFCLTestCase,
    BFCL_V3_DATASET_REVISION,
    BFCL_V3_SCORING_CASE_COUNT,
)
from benchmarks.registry import get_benchmark_registry


def _case(case_id: str) -> BFCLTestCase:
    return BFCLTestCase(
        id=case_id,
        category=BFCLCategory.SIMPLE,
        question="question",
        functions=[],
        expected_calls=[],
        has_ground_truth=True,
    )


def test_pinned_v3_profile_has_4441_scoring_cases() -> None:
    assert BFCL_V3_DATASET_REVISION == "61fc0608cfd831fcfbbaa676ebdfef0ed963eeda"
    assert BFCL_V3_SCORING_CASE_COUNT == 4441


def test_complete_profile_rejects_category_count_mismatch(monkeypatch) -> None:
    monkeypatch.setattr(
        dataset_module,
        "BFCL_V3_SCORING_CATEGORY_COUNTS",
        {BFCLCategory.SIMPLE: 2},
    )
    dataset = BFCLDataset(BFCLConfig(require_complete_dataset=True))
    dataset._test_cases = [_case("only-one")]

    with pytest.raises(RuntimeError, match="incomplete or contaminated"):
        dataset._validate_complete_dataset()


def test_pinned_upstream_ground_truth_id_typo_is_reconciled() -> None:
    dataset = BFCLDataset(BFCLConfig(require_complete_dataset=True))
    dataset._ground_truth = {
        "live_multiple_1052-279-0": [{"set_volume": {"volume": [50]}}]
    }
    case = dataset._parse_test_case(
        {
            "id": "live_multiple_1052-79-0",
            "question": [[{"role": "user", "content": "Set volume to 50"}]],
            "function": [
                {
                    "name": "set_volume",
                    "description": "Set volume",
                    "parameters": {
                        "type": "dict",
                        "required": ["volume"],
                        "properties": {"volume": {"type": "integer"}},
                    },
                }
            ],
        },
        BFCLCategory.LIVE_MULTIPLE,
        "fallback",
    )

    assert case is not None
    assert case.has_ground_truth is True
    assert case.expected_calls[0].arguments == {"volume": 50}


def test_full_campaign_command_requests_strict_full_profile(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[4]
    benchmark = next(
        item for item in get_benchmark_registry(repo_root) if item.id == "bfcl"
    )
    command = benchmark.build_command(
        tmp_path,
        ModelSpec(provider="claude-subscription", model="claude-sonnet"),
        {
            "agent": "hermes",
            "campaign_profile": "claude-subscription-full-v1",
        },
    )

    assert "--full" in command
    assert command[command.index("--provider") + 1] == "hermes"
