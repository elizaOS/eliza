"""Smoke tests for model_registry. CPU-only.

The registry holds the eliza-1 size ladder. The small tiers: the new
Qwen3.5-0.8B base (→ eliza-1-0_8b, the small default) plus the legacy Qwen3
dense checkpoints (0.6B / 1.7B / 4B → eliza-1-0_6b / 1_7b / 4b). The larger
tiers: the next-gen Qwen3.5/3.6 dense checkpoints (Qwen3.5-2B / Qwen3.5-9B /
Qwen3.6-27B → eliza-1-2b / 9b / 27b). All seven bases are published on the
Hub. `eliza_short_name` / `eliza_repo_id` are filled for every entry —
they're the HuggingFace repo names we publish to.

TODO(owner): the legacy Qwen3 small tiers (0.6b/1.7b/4b) are kept additively
alongside the new Qwen3.5 small line — decide whether to drop them.
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


# Small tiers: the new Qwen3.5-0.8B base + the legacy Qwen3 dense checkpoints.
# The Qwen3 small tiers (qwen3-0.6b/qwen3-1.7b/qwen3-4b) and the legacy
# qwen3.6-27b are kept addressable for callers that still reference them, but
# the canonical eliza-1 fused-model SFT sequence is Qwen3.5-only.
SMALL_KEYS = ("qwen3.5-0.8b", "qwen3-0.6b", "qwen3-1.7b", "qwen3-4b")
SMALL_PUBLIC_NAMES = ("eliza-1-0_8b", "eliza-1-0_6b", "eliza-1-1_7b", "eliza-1-4b")
# Larger Qwen3.5 line — used by the eliza-1 fused-model SFT cloud sequence
# (2B → 4B → 9B → 27B), each on the published `-Base` pretrain checkpoint
# (Qwen/Qwen3.5-27B has no `-Base` variant; that release IS the base).
LARGE_KEYS = ("qwen3.5-2b", "qwen3.5-4b", "qwen3.5-9b", "qwen3.5-27b", "qwen3.6-27b")
LARGE_PUBLIC_NAMES = ("eliza-1-2b", "eliza-1-4b", "eliza-1-9b", "eliza-1-27b", "eliza-1-27b")
ALL_KEYS = SMALL_KEYS + LARGE_KEYS
ALL_PUBLIC_NAMES = SMALL_PUBLIC_NAMES + LARGE_PUBLIC_NAMES


def test_registry_is_the_eliza_1_size_ladder() -> None:
    assert set(REGISTRY) == set(ALL_KEYS), (
        f"REGISTRY drifted from the eliza-1 size ladder: {sorted(REGISTRY)}"
    )


def test_every_entry_has_publish_metadata() -> None:
    for key, public in zip(ALL_KEYS, ALL_PUBLIC_NAMES, strict=True):
        e = get(key)
        assert e.eliza_short_name == public
        assert e.eliza_repo_id == f"elizaos/{public}"
        assert e.abliteration_repo_id == f"elizaos/{public}-uncensored"


def test_no_entry_is_flagged_unverified() -> None:
    for key in ALL_KEYS:
        assert getattr(get(key), "unverified_base", False) is False, (
            f"{key} base ({get(key).hf_id}) — every registry base is a published "
            "checkpoint; nothing should carry unverified_base=True"
        )


def test_tier_assignments() -> None:
    assert get("qwen3.5-0.8b").tier == Tier.LOCAL
    assert get("qwen3-0.6b").tier == Tier.LOCAL
    assert get("qwen3-1.7b").tier == Tier.LOCAL
    assert get("qwen3-4b").tier == Tier.LOCAL
    assert get("qwen3.5-2b").tier == Tier.LOCAL
    assert get("qwen3.5-4b").tier == Tier.LOCAL
    assert get("qwen3.5-9b").tier == Tier.WORKSTATION
    assert get("qwen3.5-27b").tier == Tier.CLOUD
    assert get("qwen3.6-27b").tier == Tier.CLOUD


def test_by_tier_partitions_the_ladder() -> None:
    # LOCAL: qwen3.5-0.8b/2b/4b + qwen3-0.6b/1.7b/4b = 6
    assert len(by_tier(Tier.LOCAL)) == 6
    # WORKSTATION: qwen3.5-9b
    assert len(by_tier(Tier.WORKSTATION)) == 1
    # CLOUD: qwen3.5-27b + qwen3.6-27b (legacy)
    assert len(by_tier(Tier.CLOUD)) == 2


def test_lookup_by_hf_id_short_name_or_eliza_name() -> None:
    assert get("Qwen/Qwen3.5-0.8B-Base").short_name == "qwen3.5-0.8b"
    assert get("qwen3.5-0.8b").short_name == "qwen3.5-0.8b"
    assert get("eliza-1-0_8b").short_name == "qwen3.5-0.8b"
    assert get("Qwen/Qwen3-0.6B").short_name == "qwen3-0.6b"
    assert get("qwen3-0.6b").short_name == "qwen3-0.6b"
    assert get("eliza-1-0_6b").short_name == "qwen3-0.6b"
    assert get("eliza-1-1_7b").short_name == "qwen3-1.7b"
    # eliza-1-4b is ambiguous: both qwen3-4b (legacy) and qwen3.5-4b
    # (canonical Qwen3.5 fused-model line) claim it. The first match in
    # REGISTRY iteration order wins; in practice callers should disambiguate
    # via the explicit registry key.
    assert get("qwen3.5-2b").short_name == "qwen3.5-2b"
    assert get("qwen3.5-4b").short_name == "qwen3.5-4b"
    assert get("qwen3.5-9b").short_name == "qwen3.5-9b"
    assert get("qwen3.5-27b").short_name == "qwen3.5-27b"


def test_dflash_drafter_base_is_qwen3_5_for_qwen3_5_targets() -> None:
    # The Qwen3.5/3.6 target tiers must draft from the Qwen3.5-0.8B-Base
    # checkpoint — it shares their 248320-token tokenizer (a Qwen3-0.6B
    # drafter has the wrong vocab). The shipped drafter GGUF is that base
    # distilled to ~0.6B. Mirrors DEFAULT_STUDENT_BASE in
    # scripts/distill_dflash_drafter.py.
    for tier in ("eliza-1-2b", "eliza-1-4b", "eliza-1-9b", "eliza-1-27b"):
        assert DFLASH_DRAFTER_BASE[tier] == "Qwen/Qwen3.5-0.8B-Base"
    # Legacy Qwen3 small tiers keep a Qwen3-vocab drafter base.
    for tier in ("eliza-1-1_7b",):
        assert DFLASH_DRAFTER_BASE[tier] == "Qwen/Qwen3-0.6B"
    # Smallest tiers ship no drafter.
    assert "eliza-1-0_6b" not in DFLASH_DRAFTER_BASE
    assert "eliza-1-0_8b" not in DFLASH_DRAFTER_BASE


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
    """0.8B/0.6B/1.7B/4B (Qwen3 legacy) are the "fine-tune on one consumer
    GPU" tier — full-param APOLLO SFT, modest seq_len, ≤24 GB budget.

    The Qwen3.5-4b on Qwen3.5-4B-Base is sized for a 24-28 GB H200/H100 slice
    (the larger 248k vocab + hybrid linear-attn KV plumbing push its budget
    above the strict 24 GB consumer-GPU floor); checked separately below."""
    consumer_keys = ("qwen3.5-0.8b", "qwen3-0.6b", "qwen3-1.7b", "qwen3-4b")
    for key in consumer_keys:
        e = get(key)
        assert e.tier == Tier.LOCAL
        assert e.seq_len <= 8192
        assert e.train_mem_gb_budget <= 24.0


def test_qwen3_5_mid_tiers_fit_an_h200_class_gpu() -> None:
    """qwen3.5-2b / qwen3.5-4b — H200/H100 mid-local tier; ≤80 GB budget."""
    for key in ("qwen3.5-2b", "qwen3.5-4b"):
        e = get(key)
        assert e.tier == Tier.LOCAL
        assert e.train_mem_gb_budget <= 80.0


def test_qwen3_5_27b_fits_a_single_h200() -> None:
    """qwen3.5-27b with apollo_mini + grad checkpointing + Liger at seq=32k
    is sized to fit a single 141 GB H200 SXM (per the operator's memory math
    in the brief: ~54 GB bf16 weights + ~54 GB grads + negligible apollo_mini
    fp32 moments + grad-checkpointed activations → ~115-130 GB)."""
    e = get("qwen3.5-27b")
    assert e.tier == Tier.CLOUD
    assert e.optimizer == "apollo_mini"
    assert e.optimizer_rank == 1
    # Strictly below the 141 GB H200 SXM budget. Per-rank in single-GPU mode.
    assert e.train_mem_gb_budget <= 140.0, (
        f"qwen3.5-27b train_mem_gb_budget={e.train_mem_gb_budget} > 140 — "
        "single H200 (141 GB SXM) won't fit; bump to gpu-h200x2 if real."
    )


def test_summary_table_includes_every_entry() -> None:
    table = summary_table()
    for public_name in ALL_PUBLIC_NAMES:
        assert public_name in table
