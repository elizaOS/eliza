"""Smoke tests for model_registry. CPU-only.

The registry holds the Eliza-1 size ladder. The active bases are the Gemma 4
dense backbones (E2B/E4B/12B/31B), all trained through the APOLLO path. Local
tiers run on one consumer GPU, while 9B/27B go through Vast/FSDP. The prior
Qwen3.5/3.6 backbones and the 0.8B tier were retired.
"""

from __future__ import annotations

import pytest

from scripts.training.model_registry import (
    MTP_DRAFTER_BASE,
    REGISTRY,
    Tier,
    by_tier,
    get,
    summary_table,
)


VERIFIED_KEYS = (
    "gemma4-e2b",
    "gemma4-e4b",
    "gemma4-12b",
    "gemma4-31b",
)
VERIFIED_PUBLIC_NAMES = (
    "eliza-1-2b",
    "eliza-1-4b",
    "eliza-1-9b",
    "eliza-1-27b",
)


# The eliza-1 fused-model line uses Gemma 4 dense bases for every active text
# tier: E2B/E4B (local), 12B (workstation), 31B (cloud).
SMALL_KEYS = ("gemma4-e2b",)
SMALL_PUBLIC_NAMES = ("eliza-1-2b",)
LARGE_KEYS = ("gemma4-e4b", "gemma4-12b", "gemma4-31b")
LARGE_PUBLIC_NAMES = ("eliza-1-4b", "eliza-1-9b", "eliza-1-27b")
ALL_KEYS = SMALL_KEYS + LARGE_KEYS
ALL_PUBLIC_NAMES = SMALL_PUBLIC_NAMES + LARGE_PUBLIC_NAMES


def test_registry_is_the_eliza_1_size_ladder() -> None:
    assert set(REGISTRY) == set(VERIFIED_KEYS), (
        f"REGISTRY drifted from the eliza-1 size ladder: {sorted(REGISTRY)}"
    )


def test_no_retired_0_8b_tier() -> None:
    # The 0.8B tier was retired with the Gemma 4 cutover — no Gemma 4 base,
    # dropped from the runtime catalog.
    assert "gemma4-e0_8b" not in REGISTRY
    for entry in REGISTRY.values():
        assert entry.eliza_short_name != "eliza-1-0_8b"


def test_vocab_is_gemma4_262144() -> None:
    # Every active base carries the Gemma 4 SentencePiece-BPE tokenizer
    # (vocab_size=262144). The registry encodes this in the hf_id family; the
    # memory_calc ModelShape carries the literal vocab. We assert the registry
    # bases are all the google/gemma-4-* family here.
    for key in VERIFIED_KEYS:
        assert get(key).hf_id.startswith("google/gemma-4-")


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
    assert get("gemma4-e2b").tier == Tier.LOCAL
    assert get("gemma4-e4b").tier == Tier.LOCAL
    assert get("gemma4-12b").tier == Tier.WORKSTATION
    assert get("gemma4-31b").tier == Tier.CLOUD


def test_by_tier_partitions_the_ladder() -> None:
    # LOCAL: gemma4-e2b/e4b = 2
    assert len(by_tier(Tier.LOCAL)) == 2
    # WORKSTATION: gemma4-12b
    assert len(by_tier(Tier.WORKSTATION)) == 1
    # CLOUD: canonical gemma4-31b.
    assert len(by_tier(Tier.CLOUD)) == 1
    assert len(by_tier(Tier.CLOUD, include_legacy=True)) == 1


def test_lookup_by_hf_id_short_name_or_eliza_name() -> None:
    assert get("google/gemma-4-E2B").short_name == "gemma4-e2b"
    assert get("gemma4-e2b").short_name == "gemma4-e2b"
    assert get("eliza-1-2b").short_name == "gemma4-e2b"
    assert get("gemma4-e4b").short_name == "gemma4-e4b"
    assert get("eliza-1-4b").short_name == "gemma4-e4b"
    assert get("gemma4-12b").short_name == "gemma4-12b"
    assert get("eliza-1-9b").short_name == "gemma4-12b"
    assert get("gemma4-31b").short_name == "gemma4-31b"
    assert get("google/gemma-4-31B").short_name == "gemma4-31b"
    assert get("eliza-1-27b").short_name == "gemma4-31b"
    assert get("27b").short_name == "gemma4-31b"
    assert get("27b-256k").short_name == "gemma4-31b"
    assert get("eliza-1-27b-256k").short_name == "gemma4-31b"


def test_no_qwen3_6_fallback_aliases() -> None:
    # The old Qwen3.6→Qwen3.5 lower-tier fallback aliases are gone. Looking up
    # a Qwen name must not resolve to a Gemma entry — it must raise.
    for name in (
        "qwen3.6-0.8b",
        "Qwen/Qwen3.6-0.8B-Base",
        "qwen3.6-2b",
        "qwen3.6-4b",
        "qwen3.6-9b",
        "qwen3.5-2b",
        "Qwen/Qwen3.5-0.8B",
    ):
        with pytest.raises(KeyError):
            get(name)


def test_mtp_drafter_base_is_gemma4_separate_drafter() -> None:
    # Gemma 4 ships OFFICIAL SEPARATE assistant/MTP drafter models (a distinct
    # GGUF per target tier), not a same-file NextN head. Each eliza tier drafts
    # from its own Gemma 4 `*-it-assistant` checkpoint.
    assert MTP_DRAFTER_BASE["eliza-1-2b"] == "google/gemma-4-E2B-it-assistant"
    assert MTP_DRAFTER_BASE["eliza-1-4b"] == "google/gemma-4-E4B-it-assistant"
    assert MTP_DRAFTER_BASE["eliza-1-9b"] == "google/gemma-4-12B-it-assistant"
    assert MTP_DRAFTER_BASE["eliza-1-27b"] == "google/gemma-4-31B-it-assistant"
    for base in MTP_DRAFTER_BASE.values():
        assert base.startswith("google/gemma-4-")
    # Retired tiers have no drafter entries.
    assert "eliza-1-0_8b" not in MTP_DRAFTER_BASE
    assert "eliza-1-0_6b" not in MTP_DRAFTER_BASE
    assert "eliza-1-1_7b" not in MTP_DRAFTER_BASE


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


def test_27b_default_seq_len_leaves_real_headroom() -> None:
    """Gap M35: the 27B default seq_len must stay conservative (≤64k) so the
    registry's memory budget leaves real headroom on the documented 2× H200 /
    2× B200 targets. Override per run via `--max-seq-len`."""
    e = get("gemma4-31b")
    assert e.seq_len <= 65536, (
        f"gemma4-31b seq_len={e.seq_len} > 64k — keep the registry default "
        "conservative and bump via `--max-seq-len` per run instead."
    )


def test_2b_and_9b_seq_len_defaults() -> None:
    """The local 2B and the workstation 9B defaults sit at the documented
    budgets — plenty of headroom at those seq_lens."""
    assert get("gemma4-e2b").seq_len == 8192
    assert get("gemma4-12b").seq_len == 16384


def test_small_real_tiers_fit_a_consumer_gpu() -> None:
    """gemma4-e2b is the entry "fine-tune on a 16 GB consumer GPU" tier;
    gemma4-e4b is the mid-local tier checked separately."""
    e = get("gemma4-e2b")
    assert e.tier == Tier.LOCAL
    assert e.seq_len <= 8192
    assert e.train_mem_gb_budget <= 24.0


def test_summary_table_includes_every_entry() -> None:
    table = summary_table()
    for public_name in VERIFIED_PUBLIC_NAMES:
        assert public_name in table
    assert "eliza-1-27b" in table


def test_quantization_matrix_includes_gguf_q4_q6_q8() -> None:
    for key in VERIFIED_KEYS:
        e = get(key)
        assert "gguf-q3_k_m" in e.quantization_after
        assert "gguf-q4_k_m" in e.quantization_after
        assert "gguf-q5_k_m" in e.quantization_after
        assert "gguf-q6_k" in e.quantization_after
        assert "gguf-q8_0" in e.quantization_after


def test_gemma4_unified_tiers_disable_liger() -> None:
    """gemma4_unified (dense 12B/31B → eliza-1-9b/27b) has no validated Liger
    kernel path — its fused RMSNorm/RoPE/CE assume the Gemma2/3 layout and NaN
    the forward (the all-NaN 12B checkpoint incident). The registry MUST keep
    Liger off for these tiers as the single source of truth, independent of the
    arch-string backstop in train_local.py."""
    assert REGISTRY["gemma4-12b"].use_liger is False
    assert REGISTRY["gemma4-31b"].use_liger is False
    assert get("eliza-1-9b").use_liger is False
    assert get("eliza-1-27b").use_liger is False


def test_local_gemma4_tiers_keep_liger() -> None:
    """The E2B/E4B "gemma4" (non-unified) local tiers train fine with Liger and
    rely on it for their seq_len budgets — they must stay enabled."""
    assert REGISTRY["gemma4-e2b"].use_liger is True
    assert REGISTRY["gemma4-e4b"].use_liger is True
