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


# The eliza-1 fused-model line is Qwen3.5-only (per the 2026-05-12 operator
# directive — the Qwen3 dense bases don't work with dflash). The smallest
# tier is qwen3.5-0.8b on Qwen/Qwen3.5-0.8B-Base; 2b/4b are mid-local on
# Qwen/Qwen3.5-{2B,4B}-Base; 9b is the workstation tier on
# Qwen/Qwen3.5-9B-Base; 27b is the cloud tier on Qwen/Qwen3.5-27B (no -Base
# variant — that release IS the base). qwen3.6-27b is kept as a legacy
# long-context 27B variant.
SMALL_KEYS = ("qwen3.5-0.8b",)
SMALL_PUBLIC_NAMES = ("eliza-1-0_8b",)
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
    assert get("qwen3.5-2b").tier == Tier.LOCAL
    assert get("qwen3.5-4b").tier == Tier.LOCAL
    assert get("qwen3.5-9b").tier == Tier.WORKSTATION
    assert get("qwen3.5-27b").tier == Tier.CLOUD
    assert get("qwen3.6-27b").tier == Tier.CLOUD


def test_by_tier_partitions_the_ladder() -> None:
    # LOCAL: qwen3.5-0.8b/2b/4b = 3
    assert len(by_tier(Tier.LOCAL)) == 3
    # WORKSTATION: qwen3.5-9b
    assert len(by_tier(Tier.WORKSTATION)) == 1
    # CLOUD: qwen3.5-27b + qwen3.6-27b (legacy)
    assert len(by_tier(Tier.CLOUD)) == 2


def test_lookup_by_hf_id_short_name_or_eliza_name() -> None:
    assert get("Qwen/Qwen3.5-0.8B-Base").short_name == "qwen3.5-0.8b"
    assert get("qwen3.5-0.8b").short_name == "qwen3.5-0.8b"
    assert get("eliza-1-0_8b").short_name == "qwen3.5-0.8b"
    assert get("qwen3.5-2b").short_name == "qwen3.5-2b"
    assert get("qwen3.5-4b").short_name == "qwen3.5-4b"
    assert get("qwen3.5-9b").short_name == "qwen3.5-9b"
    assert get("qwen3.5-27b").short_name == "qwen3.5-27b"


def test_dflash_drafter_base_is_qwen3_5_for_qwen3_5_targets() -> None:
    # The Qwen3.5/3.6 target tiers must draft from the Qwen3.5-0.8B-Base
    # checkpoint — it shares their 248320-token tokenizer (a Qwen3-0.6B
    # drafter has the wrong vocab). The shipped drafter GGUF is that base
    # distilled to ~0.6B. Mirrors DEFAULT_STUDENT_BASE in
    # scripts/distill_dflash_drafter.py. Per the 2026-05-12 operator
    # directive (Qwen3.5-only fused-model line), the legacy Qwen3 tier
    # drafter entries (eliza-1-1_7b / eliza-1-4b) are dropped — the
    # corresponding tiers are deprecated.
    for tier in ("eliza-1-2b", "eliza-1-4b", "eliza-1-9b", "eliza-1-27b"):
        assert DFLASH_DRAFTER_BASE[tier] == "Qwen/Qwen3.5-0.8B-Base"
    # Smallest tier ships no drafter.
    assert "eliza-1-0_8b" not in DFLASH_DRAFTER_BASE
    # Deprecated Qwen3 tiers have no drafter entries.
    assert "eliza-1-0_6b" not in DFLASH_DRAFTER_BASE
    assert "eliza-1-1_7b" not in DFLASH_DRAFTER_BASE


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
    """The qwen3.5-0.8b small tier is the only "fine-tune on a 16 GB
    consumer GPU" entry left after the Qwen3 legacy line was dropped on
    2026-05-12. qwen3.5-2b and qwen3.5-4b are mid-local tiers checked
    separately below."""
    e = get("qwen3.5-0.8b")
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
