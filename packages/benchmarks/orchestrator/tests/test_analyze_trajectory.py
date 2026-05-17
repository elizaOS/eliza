from __future__ import annotations

import json
from pathlib import Path

from benchmarks.orchestrator.analyze_trajectory import extract_tokens, summarize


def test_extract_tokens_preserves_explicit_zero_cache_over_nested_fallback() -> None:
    tokens = extract_tokens(
        {
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 12,
                "total_tokens": 112,
                "cache_read_input_tokens": 0,
                "prompt_tokens_details": {"cached_tokens": 25},
                "input_token_details": {"cache_creation_input_tokens": 8},
            }
        }
    )

    assert tokens is not None
    assert tokens.prompt == 100
    assert tokens.completion == 12
    assert tokens.total == 112
    assert tokens.cached == 0
    assert tokens.cache_creation == 8
    assert tokens.has_cached is True


def test_extract_tokens_does_not_invent_cache_field_when_absent() -> None:
    tokens = extract_tokens(
        {
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 12,
                "total_tokens": 112,
            }
        }
    )

    assert tokens is not None
    assert tokens.cached == 0
    assert tokens.cache_creation == 0
    assert tokens.has_cached is False


def test_summarize_telemetry_jsonl_preserves_zero_cache_fields(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    output_dir = run_dir / "output"
    output_dir.mkdir(parents=True)
    telemetry = output_dir / "telemetry.jsonl"
    telemetry.write_text(
        json.dumps(
            {
                "prompt_text": "hello",
                "latency_ms": 15,
                "usage": {
                    "prompt_tokens": 50,
                    "completion_tokens": 5,
                    "total_tokens": 55,
                    "cache_read_input_tokens": 0,
                    "prompt_tokens_details": {"cached_tokens": 17},
                    "cache_creation_input_tokens": 3,
                },
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )

    summary, records = summarize(run_dir)

    assert len(records) == 1
    assert summary.turns == 1
    assert summary.prompt_tokens == 50
    assert summary.completion_tokens == 5
    assert summary.total_tokens == 55
    assert summary.cached_tokens == 0
    assert summary.cache_creation_tokens == 3
    assert summary.turns_with_cached_field == 1
