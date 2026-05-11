"""Smoke tests for model_registry. CPU-only."""

from __future__ import annotations

import pytest

from scripts.training.model_registry import REGISTRY, Tier, by_tier, get, summary_table


# The published eliza-1 series — three sizes that ship to HuggingFace.
ELIZA_1_KEYS = ("qwen3.5-2b", "qwen3.5-9b", "qwen3.6-27b")
ELIZA_1_PUBLIC_NAMES = ("eliza-1-2b", "eliza-1-9b", "eliza-1-27b")
# Smoke-only entries that exercise the pipeline end-to-end on consumer
# hardware but are NOT published. `eliza_short_name` and `eliza_repo_id`
# are intentionally empty for these.
SMOKE_KEYS = ("qwen3-0.6b",)


def test_registry_is_eliza_1_plus_smoke() -> None:
    expected = set(ELIZA_1_KEYS) | set(SMOKE_KEYS)
    assert set(REGISTRY) == expected, (
        f"REGISTRY drifted from eliza-1 + smoke set: {sorted(REGISTRY)}"
    )


def test_smoke_entries_have_no_publish_metadata() -> None:
    """Smoke-only entries must not pretend to be published eliza-1 sizes —
    `local-model-resolver.ts` uses these fields to decide what to expose."""
    for key in SMOKE_KEYS:
        e = get(key)
        assert e.eliza_short_name == ""
        assert e.eliza_repo_id == ""
        assert e.abliteration_repo_id == ""


@pytest.mark.parametrize("short,size", [
    ("qwen3.5-2b", "2b"),
    ("qwen3.5-9b", "9b"),
    ("qwen3.6-27b", "27b"),
])
def test_eliza_repo_id_matches_size(short: str, size: str) -> None:
    e = get(short)
    assert e.eliza_short_name == f"eliza-1-{size}"
    assert e.eliza_repo_id == f"elizalabs/eliza-1-{size}"
    assert e.abliteration_repo_id == f"elizalabs/eliza-1-{size}-uncensored"


def test_tier_assignments() -> None:
    assert get("qwen3.5-2b").tier == Tier.LOCAL
    assert get("qwen3.5-9b").tier == Tier.WORKSTATION
    assert get("qwen3.6-27b").tier == Tier.CLOUD


def test_by_tier_returns_each_tier_once_for_eliza_1() -> None:
    """Workstation + cloud each have exactly one eliza-1 entry; local has
    one eliza-1 (qwen3.5-2b) plus the qwen3-0.6b smoke entry, so 2."""
    assert len(by_tier(Tier.WORKSTATION)) == 1
    assert len(by_tier(Tier.CLOUD)) == 1
    assert len(by_tier(Tier.LOCAL)) == 2


def test_lookup_by_hf_id_or_short_name() -> None:
    assert get("Qwen/Qwen3.5-2B").short_name == "qwen3.5-2b"
    assert get("qwen3.5-2b").short_name == "qwen3.5-2b"
    assert get("eliza-1-2b").short_name == "qwen3.5-2b"
    assert get("eliza-1-9b").short_name == "qwen3.5-9b"
    assert get("eliza-1-27b").short_name == "qwen3.6-27b"


def test_unknown_model_raises_keyerror() -> None:
    with pytest.raises(KeyError):
        get("not-a-real-model")


def test_inference_budgets_back_filled() -> None:
    # The _entry helper computes infer_mem_gb_*; both must be > 0 once the
    # entry is materialized.
    for key in ELIZA_1_KEYS:
        e = get(key)
        assert e.infer_mem_gb_bf16_fullkv > 0
        assert e.infer_mem_gb_quantized > 0
        assert e.infer_mem_gb_quantized < e.infer_mem_gb_bf16_fullkv


def test_27b_fits_on_48gb_quantized_at_144k() -> None:
    e = get("qwen3.6-27b")
    assert e.infer_mem_gb_quantized < 48.0


def test_summary_table_includes_every_entry() -> None:
    table = summary_table()
    for public_name in ELIZA_1_PUBLIC_NAMES:
        assert public_name in table
