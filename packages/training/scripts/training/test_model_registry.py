"""Smoke tests for model_registry. CPU-only.

The registry holds the eliza-1 size ladder. Three of the bases are real,
published Qwen3 checkpoints we fine-tune from (0.6B / 1.7B / 4B → eliza-1-0_6b
/ 1_7b / 4b); the larger three (qwen3.5-2b / qwen3.5-9b / qwen3.6-27b → eliza-1-
2b / 9b / 27b) are planned tiers whose bases are not yet verified to exist
(`unverified_base=True`). `eliza_short_name` / `eliza_repo_id` are filled for
every entry — they're the planned HuggingFace repo names; the `unverified_base`
flag is what signals "don't trust the base checkpoint yet".
"""

from __future__ import annotations

import pytest

from scripts.training.model_registry import REGISTRY, Tier, by_tier, get, summary_table


# Real-base tiers: published Qwen3 checkpoints, fine-tunable today.
VERIFIED_KEYS = ("qwen3-0.6b", "qwen3-1.7b", "qwen3-4b")
VERIFIED_PUBLIC_NAMES = ("eliza-1-0_6b", "eliza-1-1_7b", "eliza-1-4b")
# Larger tiers: planned, base checkpoint not yet verified.
UNVERIFIED_KEYS = ("qwen3.5-2b", "qwen3.5-9b", "qwen3.6-27b")
UNVERIFIED_PUBLIC_NAMES = ("eliza-1-2b", "eliza-1-9b", "eliza-1-27b")
ALL_KEYS = VERIFIED_KEYS + UNVERIFIED_KEYS
ALL_PUBLIC_NAMES = VERIFIED_PUBLIC_NAMES + UNVERIFIED_PUBLIC_NAMES


def test_registry_is_the_eliza_1_size_ladder() -> None:
    assert set(REGISTRY) == set(ALL_KEYS), (
        f"REGISTRY drifted from the eliza-1 size ladder: {sorted(REGISTRY)}"
    )


def test_every_entry_has_publish_metadata() -> None:
    for key, public in zip(ALL_KEYS, ALL_PUBLIC_NAMES):
        e = get(key)
        assert e.eliza_short_name == public
        assert e.eliza_repo_id == f"elizaos/{public}"
        assert e.abliteration_repo_id == f"elizaos/{public}-uncensored"


def test_verified_bases_are_not_flagged_unverified() -> None:
    for key in VERIFIED_KEYS:
        assert getattr(get(key), "unverified_base", False) is False, (
            f"{key} base ({get(key).hf_id}) should be a real published checkpoint"
        )


def test_larger_bases_are_flagged_unverified() -> None:
    for key in UNVERIFIED_KEYS:
        assert getattr(get(key), "unverified_base", False) is True, (
            f"{key} base ({get(key).hf_id}) is not a verified published checkpoint — "
            "keep unverified_base=True until it is"
        )


def test_tier_assignments() -> None:
    assert get("qwen3-0.6b").tier == Tier.LOCAL
    assert get("qwen3-1.7b").tier == Tier.LOCAL
    assert get("qwen3-4b").tier == Tier.LOCAL
    assert get("qwen3.5-2b").tier == Tier.LOCAL
    assert get("qwen3.5-9b").tier == Tier.WORKSTATION
    assert get("qwen3.6-27b").tier == Tier.CLOUD


def test_by_tier_partitions_the_ladder() -> None:
    assert len(by_tier(Tier.LOCAL)) == 4   # 0.6b, 1.7b, 4b, 2b
    assert len(by_tier(Tier.WORKSTATION)) == 1  # 9b
    assert len(by_tier(Tier.CLOUD)) == 1   # 27b


def test_lookup_by_hf_id_short_name_or_eliza_name() -> None:
    assert get("Qwen/Qwen3-0.6B").short_name == "qwen3-0.6b"
    assert get("qwen3-0.6b").short_name == "qwen3-0.6b"
    assert get("eliza-1-0_6b").short_name == "qwen3-0.6b"
    assert get("eliza-1-1_7b").short_name == "qwen3-1.7b"
    assert get("eliza-1-4b").short_name == "qwen3-4b"
    assert get("eliza-1-2b").short_name == "qwen3.5-2b"
    assert get("eliza-1-9b").short_name == "qwen3.5-9b"
    assert get("eliza-1-27b").short_name == "qwen3.6-27b"


def test_unknown_model_raises_keyerror() -> None:
    with pytest.raises(KeyError):
        get("not-a-real-model")


def test_inference_budgets_back_filled() -> None:
    # The _entry helper computes infer_mem_gb_*; both must be > 0 once the
    # entry is materialized.
    for key in ALL_KEYS:
        e = get(key)
        assert e.infer_mem_gb_bf16_fullkv > 0
        assert e.infer_mem_gb_quantized > 0
        assert e.infer_mem_gb_quantized < e.infer_mem_gb_bf16_fullkv


def test_27b_fits_on_48gb_quantized() -> None:
    assert get("qwen3.6-27b").infer_mem_gb_quantized < 48.0


def test_27b_default_seq_len_leaves_real_headroom() -> None:
    """Gap M35: 27B default seq_len at 147k left ~1% headroom on the 2× B6000
    (192 GB) cluster and ~6% on 2× H200 — one activation spike OOMed the run.
    Default must stay at or below 64k so the registry default is safe on every
    documented 27B target. Override per run via `--max-seq-len`."""
    e = get("qwen3.6-27b")
    assert e.seq_len <= 65536, (
        f"qwen3.6-27b seq_len={e.seq_len} > 64k — drift back toward the "
        "unsafe 147k default; keep registry default conservative and bump "
        "via `--max-seq-len` per run instead."
    )


def test_2b_and_9b_seq_len_defaults_unchanged_by_m35() -> None:
    """M35 only lowered the 27B default. 2B and 9B defaults must stay where
    they are — those tiers have plenty of headroom at the documented budgets."""
    assert get("qwen3.5-2b").seq_len == 8192
    assert get("qwen3.5-9b").seq_len == 16384


def test_small_real_tiers_fit_a_consumer_gpu() -> None:
    """0.6B/1.7B/4B are the "fine-tune on one consumer GPU" tier — full-param
    APOLLO SFT, modest seq_len, single-GPU memory budgets."""
    for key in VERIFIED_KEYS:
        e = get(key)
        assert e.tier == Tier.LOCAL
        assert e.seq_len <= 8192
        assert e.train_mem_gb_budget <= 24.0


def test_summary_table_includes_every_entry() -> None:
    table = summary_table()
    for public_name in ALL_PUBLIC_NAMES:
        assert public_name in table
