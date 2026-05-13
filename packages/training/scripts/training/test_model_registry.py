"""Smoke tests for model_registry. CPU-only.

The active Eliza-1 training ladder is Qwen3.5 0.8B/2B/4B. Larger tiers stay
outside this registry until final weights/evals/licenses/platform evidence
exist.
"""

from __future__ import annotations

import pytest

from scripts.training.model_registry import REGISTRY, Tier, by_tier, get, summary_table


VERIFIED_KEYS = (
    "qwen3.5-0.8b",
    "qwen3.5-2b",
    "qwen3.5-4b",
)
VERIFIED_PUBLIC_NAMES = (
    "eliza-1-0_8b",
    "eliza-1-2b",
    "eliza-1-4b",
)


def test_registry_is_the_eliza_1_size_ladder() -> None:
    assert set(REGISTRY) == set(VERIFIED_KEYS), (
        f"REGISTRY drifted from the eliza-1 size ladder: {sorted(REGISTRY)}"
    )


def test_every_entry_has_publish_metadata() -> None:
    for key, public in zip(VERIFIED_KEYS, VERIFIED_PUBLIC_NAMES):
        e = get(key)
        assert e.eliza_short_name == public
        assert e.eliza_repo_id == "elizaos/eliza-1"
        assert e.abliteration_repo_id == ""


def test_verified_bases_are_not_flagged_unverified() -> None:
    for key in VERIFIED_KEYS:
        assert getattr(get(key), "unverified_base", False) is False, (
            f"{key} base ({get(key).hf_id}) should be a real published checkpoint"
        )


def test_no_entries_are_flagged_unverified() -> None:
    for key in VERIFIED_KEYS:
        assert getattr(get(key), "unverified_base", False) is False


def test_tier_assignments() -> None:
    assert get("qwen3.5-0.8b").tier == Tier.LOCAL
    assert get("qwen3.5-2b").tier == Tier.LOCAL
    assert get("qwen3.5-4b").tier == Tier.LOCAL


def test_by_tier_partitions_the_ladder() -> None:
    assert len(by_tier(Tier.LOCAL)) == 3   # 0.8b, 2b, 4b
    assert len(by_tier(Tier.WORKSTATION)) == 0
    assert len(by_tier(Tier.CLOUD)) == 0


def test_lookup_by_hf_id_short_name_or_eliza_name() -> None:
    assert get("Qwen/Qwen3.5-0.8B").short_name == "qwen3.5-0.8b"
    assert get("qwen3.5-0.8b").short_name == "qwen3.5-0.8b"
    assert get("eliza-1-0_8b").short_name == "qwen3.5-0.8b"
    assert get("eliza-1-2b").short_name == "qwen3.5-2b"
    assert get("eliza-1-4b").short_name == "qwen3.5-4b"

def test_unknown_model_raises_keyerror() -> None:
    with pytest.raises(KeyError):
        get("not-a-real-model")
    with pytest.raises(KeyError):
        get("qwen3-4b")


def test_inference_budgets_back_filled() -> None:
    # The _entry helper computes infer_mem_gb_*; both must be > 0 once the
    # entry is materialized.
    for key in VERIFIED_KEYS:
        e = get(key)
        assert e.infer_mem_gb_bf16_fullkv > 0
        assert e.infer_mem_gb_quantized > 0
        assert e.infer_mem_gb_quantized < e.infer_mem_gb_bf16_fullkv


def test_2b_seq_len_default_stays_local_safe() -> None:
    """The 2B default should remain safe for a 16 GB local training target."""
    assert get("qwen3.5-2b").seq_len == 8192


def test_active_real_tiers_have_single_gpu_training_budgets() -> None:
    """0.8B/2B fit 16 GB-class training; 4B needs a 48 GB-class train GPU."""
    for key in ("qwen3.5-0.8b", "qwen3.5-2b", "qwen3.5-4b"):
        e = get(key)
        assert e.tier == Tier.LOCAL
        assert e.seq_len <= 8192
        assert e.train_mem_gb_budget <= (34.0 if key == "qwen3.5-4b" else 16.0)


def test_summary_table_includes_every_entry() -> None:
    table = summary_table()
    for public_name in VERIFIED_PUBLIC_NAMES:
        assert public_name in table
