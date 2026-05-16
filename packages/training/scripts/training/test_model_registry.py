"""Smoke tests for model_registry. CPU-only.

The registry holds the Eliza-1 size ladder. The active bases are Qwen3.5 for
0.8B/2B/4B/9B and Qwen3.6 for 27B; all train through the APOLLO path. Local
tiers run on one consumer GPU, while 9B/27B go through Vast/FSDP.
"""

from __future__ import annotations

import pytest

from scripts.training.model_registry import (
    DFLASH_DRAFTER_BASE,
    REGISTRY,
    Tier,
    by_tier,
    get,
    summary_table,
)


VERIFIED_KEYS = (
    "qwen3.5-0.8b",
    "qwen3.5-2b",
    "qwen3.5-4b",
    "qwen3.5-9b",
    "qwen3.6-27b",
)
VERIFIED_PUBLIC_NAMES = (
    "eliza-1-0_8b",
    "eliza-1-2b",
    "eliza-1-4b",
    "eliza-1-9b",
    "eliza-1-27b",
)


# The eliza-1 fused-model line uses Qwen3.5 for active 0.8B/2B/4B/9B text
# tiers and Qwen3.6 for the active 27B tier.
SMALL_KEYS = ("qwen3.5-0.8b",)
SMALL_PUBLIC_NAMES = ("eliza-1-0_8b",)
LARGE_KEYS = ("qwen3.5-2b", "qwen3.5-4b", "qwen3.5-9b", "qwen3.6-27b")
LARGE_PUBLIC_NAMES = ("eliza-1-2b", "eliza-1-4b", "eliza-1-9b", "eliza-1-27b")
ALL_KEYS = SMALL_KEYS + LARGE_KEYS
ALL_PUBLIC_NAMES = SMALL_PUBLIC_NAMES + LARGE_PUBLIC_NAMES


def test_registry_is_the_eliza_1_size_ladder() -> None:
    assert set(REGISTRY) == set(VERIFIED_KEYS), (
        f"REGISTRY drifted from the eliza-1 size ladder: {sorted(REGISTRY)}"
    )


def test_every_entry_has_publish_metadata() -> None:
    active_public_keys = (
        "qwen3.5-0.8b",
        "qwen3.5-2b",
        "qwen3.5-4b",
        "qwen3.5-9b",
        "qwen3.6-27b",
    )
    for key, public in zip(active_public_keys, VERIFIED_PUBLIC_NAMES):
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
    assert get("qwen3.5-9b").tier == Tier.WORKSTATION
    assert get("qwen3.6-27b").tier == Tier.CLOUD


def test_by_tier_partitions_the_ladder() -> None:
    # LOCAL: qwen3.5-0.8b/2b/4b = 3
    assert len(by_tier(Tier.LOCAL)) == 3
    # WORKSTATION: qwen3.5-9b
    assert len(by_tier(Tier.WORKSTATION)) == 1
    # CLOUD: canonical qwen3.6-27b.
    assert len(by_tier(Tier.CLOUD)) == 1
    assert len(by_tier(Tier.CLOUD, include_legacy=True)) == 1


def test_lookup_by_hf_id_short_name_or_eliza_name() -> None:
    assert get("Qwen/Qwen3.5-0.8B").short_name == "qwen3.5-0.8b"
    assert get("qwen3.5-0.8b").short_name == "qwen3.5-0.8b"
    assert get("eliza-1-0_8b").short_name == "qwen3.5-0.8b"
    assert get("qwen3.5-2b").short_name == "qwen3.5-2b"
    assert get("qwen3.5-4b").short_name == "qwen3.5-4b"
    assert get("qwen3.5-9b").short_name == "qwen3.5-9b"
    assert get("qwen3.6-27b").short_name == "qwen3.6-27b"
    assert get("Qwen/Qwen3.6-27B").short_name == "qwen3.6-27b"
    assert get("eliza-1-27b").short_name == "qwen3.6-27b"
    assert get("27b").short_name == "qwen3.6-27b"


def test_qwen36_lower_tiers_fall_back_to_qwen35_bases() -> None:
    assert get("qwen3.6-0.8b").short_name == "qwen3.5-0.8b"
    assert get("Qwen/Qwen3.6-0.8B-Base").short_name == "qwen3.5-0.8b"
    assert get("qwen3.6-2b").short_name == "qwen3.5-2b"
    assert get("Qwen/Qwen3.6-2B-Base").short_name == "qwen3.5-2b"
    assert get("qwen3.6-4b").short_name == "qwen3.5-4b"
    assert get("Qwen/Qwen3.6-4B").short_name == "qwen3.5-4b"
    assert get("qwen3.6-9b").short_name == "qwen3.5-9b"
    assert get("Qwen/Qwen3.6-9B").short_name == "qwen3.5-9b"


def test_dflash_drafter_base_is_qwen3_5_for_active_targets() -> None:
    # The Qwen3.5/Qwen3.6 target tiers draft from the Qwen3.5-0.8B-Base
    # checkpoint — it shares their 248320-token tokenizer (a legacy Qwen3 drafter has the wrong vocab). The shipped drafter GGUF is that base
    # distilled to ~0.6B. Mirrors DEFAULT_STUDENT_BASE in
    # scripts/distill_dflash_drafter.py. Per the 2026-05-12 operator
    # directive (Qwen3.5/Qwen3.6 fused-model line), the legacy Qwen3 tier
    # legacy drafter entries are dropped — the
    # corresponding tiers are deprecated.
    for tier in (
        "eliza-1-0_8b",
        "eliza-1-2b",
        "eliza-1-4b",
        "eliza-1-9b",
        "eliza-1-27b",
    ):
        assert DFLASH_DRAFTER_BASE[tier] == "Qwen/Qwen3.5-0.8B-Base"
    # Deprecated Qwen3 tiers have no drafter entries.
    assert "eliza-1-0_6b" not in DFLASH_DRAFTER_BASE
    assert "eliza-1-1_7b" not in DFLASH_DRAFTER_BASE


def test_unknown_model_raises_keyerror() -> None:
    with pytest.raises(KeyError):
        get("not-a-real-model")


def test_inference_budgets_back_filled() -> None:
    # The _entry helper computes infer_mem_gb_*; both must be > 0 once the
    # entry is materialized.
    for key in VERIFIED_KEYS:
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
    """The qwen3.5-0.8b small tier is the only "fine-tune on a 16 GB
    consumer GPU" entry left after the Qwen3 legacy line was dropped on
    2026-05-12. qwen3.5-2b and qwen3.5-4b are mid-local tiers checked
    separately below."""
    e = get("qwen3.5-0.8b")
    assert e.tier == Tier.LOCAL
    assert e.seq_len <= 8192
    assert e.train_mem_gb_budget <= 24.0


def test_summary_table_includes_every_entry() -> None:
    table = summary_table()
    for public_name in VERIFIED_PUBLIC_NAMES:
        assert public_name in table
    assert "Qwen/Qwen3.6-27B" in table or "eliza-1-27b" in table


def test_quantization_matrix_includes_gguf_q4_q6_q8() -> None:
    for key in VERIFIED_KEYS:
        e = get(key)
        assert "gguf-q3_k_m" in e.quantization_after
        assert "gguf-q4_k_m" in e.quantization_after
        assert "gguf-q5_k_m" in e.quantization_after
        assert "gguf-q6_k" in e.quantization_after
        assert "gguf-q8_0" in e.quantization_after
