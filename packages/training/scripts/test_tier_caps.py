"""Unit tests for the tier-aware per-source cap logic in pack_dataset.py.

CPU-only. No real corpus on disk. Verifies:
  - tier lookup correctness for representative slugs across S/A/B/C/D/E/F.
  - Tier E (hermes) combined-budget proportional split.
  - Tier S replicate-factor logic in compute_targets.
"""

from __future__ import annotations


import pytest

from scripts.pack_dataset import (
    TIER_CAPS,
    TIER_E_HERMES_COMBINED,
    compute_targets,
    tier_for,
)


# ───────────────────── tier_for() ─────────────────────


@pytest.mark.parametrize(
    "slug,expected_tier",
    [
        # Tier S — gold
        ("nubilio-trajectories", "S"),
        # Tier A — eliza-aligned
        ("scambench", "A"),
        ("scam-defense-corpus", "A"),
        # Tier B — tool-call agent traces
        ("agent-trove", "B"),
        ("tool-reasoning-toucan", "B"),
        # Tier C — synthetic ChatML wrapping
        ("glaive-fc-v2", "C"),
        ("hermes-fc-v1", "E"),  # hermes-fc-v1 is in TIER_E_HERMES_COMBINED
        # Tier D — pure reasoning
        ("kimi-k25-reasoning-1m", "D"),
        ("deepseek-v4-distill-8000x", "D"),
        # Tier E — hermes family combined cap
        ("hermes-3", "E"),
        ("aureth-corpus-hermes", "E"),
        # Tier F — n8n combined cap
        ("n8n-mega-workflows", "F"),
        # synth: prefix should strip before lookup
        ("synth:nubilio-trajectories", "S"),
        ("synth:agent-trove", "B"),
        # un-tiered slug defaults to "B"
        ("some-unknown-synth-slug", "B"),
    ],
)
def test_tier_for_known_slugs(slug: str, expected_tier: str):
    assert tier_for(slug) == expected_tier


# ─────────────────── compute_targets — Tier E split ───────────────────


def test_tier_e_combined_budget_split_proportional_to_record_counts():
    """The 100k Tier-E budget must split proportionally across hermes
    sources by record count, not evenly. With three hermes sources at
    100k / 50k / 50k records the split is 50k / 25k / 25k."""
    counts = {
        "hermes-3": 100_000,
        "aureth-corpus-hermes": 50_000,
        "hermes-omniforge-qwen36": 50_000,
        # A non-hermes source should not change Tier E math.
        "agent-trove": 200_000,
    }
    targets = compute_targets(counts, per_source_cap=10_000_000, no_weights=False)

    e_budget = TIER_CAPS["E"][0]
    assert e_budget == 100_000

    # Total E allocation should match the budget (within int truncation).
    e_alloc_total = sum(targets[s] for s in counts if s in TIER_E_HERMES_COMBINED)
    assert e_alloc_total <= e_budget
    # int() truncates: 100k * 100k / 200k = 50000 exactly; same for the
    # 25k slots. So the sum is exactly the budget here.
    assert e_alloc_total == e_budget

    assert targets["hermes-3"] == 50_000
    assert targets["aureth-corpus-hermes"] == 25_000
    assert targets["hermes-omniforge-qwen36"] == 25_000

    # Non-hermes slugs are untouched by the Tier E math; agent-trove is
    # capped at its Tier B 50k.
    assert targets["agent-trove"] == 50_000


def test_tier_e_combined_budget_with_single_source_takes_full_budget():
    """When only one hermes source has data, it gets the full 100k budget
    (or less, capped by available records)."""
    counts = {"hermes-3": 30_000, "agent-trove": 200_000}
    targets = compute_targets(counts, per_source_cap=10_000_000, no_weights=False)
    # 100k budget × 30k / 30k = 100k, but only 30k records available, and
    # int truncation: 100000 * 30000 / 30000 = 100000.
    # The compute_targets code does NOT cap E by `n` — that's by design;
    # the reservoir sampler at pass-2 will only produce min(n, target)
    # records. Verify the raw allocation here.
    assert targets["hermes-3"] == 100_000


# ─────────────────── compute_targets — Tier S replicate ───────────────────


def test_tier_s_replicate_factor_multiplies_target_by_5():
    """Tier S target must be min(cap, n) × replicate_factor (=5)."""
    cap, rep = TIER_CAPS["S"]
    assert (cap, rep) == (5_000, 5)

    # Below cap: target = n × rep.
    counts_small = {"nubilio-trajectories": 1_000}
    targets = compute_targets(counts_small, per_source_cap=10_000_000,
                              no_weights=False)
    # per-source-cap default in main() is 100_000; we pass a huge value
    # so the Tier S target survives. Caveat: per_source_cap caps even
    # Tier S, so the test passes a large enough override.
    assert targets["nubilio-trajectories"] == 1_000 * 5

    # At cap: target = cap × rep = 25,000.
    counts_at_cap = {"nubilio-trajectories": 5_000}
    targets = compute_targets(counts_at_cap, per_source_cap=10_000_000,
                              no_weights=False)
    assert targets["nubilio-trajectories"] == 25_000

    # Above cap: target = cap × rep (cap is the unique-record bound).
    counts_above = {"nubilio-trajectories": 100_000}
    targets = compute_targets(counts_above, per_source_cap=10_000_000,
                              no_weights=False)
    assert targets["nubilio-trajectories"] == 25_000


def test_per_source_cap_override_caps_tier_target():
    """When the operator passes --per-source-cap below the tier cap, the
    CLI override wins. This protects against accidentally picking up an
    enormous Tier-A source full-corpus."""
    counts = {
        "nubilio-trajectories": 5_000,   # Tier S → would be 25_000
        "agent-trove": 1_500_000,        # Tier B → would be 50_000
    }
    targets = compute_targets(counts, per_source_cap=10_000, no_weights=False)
    assert targets["nubilio-trajectories"] == 10_000
    assert targets["agent-trove"] == 10_000


def test_no_weights_falls_back_to_flat_per_source_cap():
    """When --no-weights is set, every source uses the flat global cap
    regardless of tier. The flat cap is bounded by record count."""
    counts = {
        "nubilio-trajectories": 5_000,
        "agent-trove": 1_500_000,
        "scambench": 100,
    }
    targets = compute_targets(counts, per_source_cap=20_000, no_weights=True)
    # nubilio: min(20k, 5k) = 5k (no rep applied in no_weights mode).
    assert targets["nubilio-trajectories"] == 5_000
    # agent-trove: min(20k, 1.5M) = 20k.
    assert targets["agent-trove"] == 20_000
    # scambench: min(20k, 100) = 100.
    assert targets["scambench"] == 100


# ─────────────────── compute_targets — Tier A/B/C/D ─────────────────


def test_tier_b_caps_at_50k_when_more_records_available():
    counts = {"agent-trove": 1_500_000}
    targets = compute_targets(counts, per_source_cap=10_000_000,
                              no_weights=False)
    assert targets["agent-trove"] == 50_000


def test_tier_d_caps_at_15k():
    counts = {"kimi-k25-reasoning-1m": 1_000_000}
    targets = compute_targets(counts, per_source_cap=10_000_000,
                              no_weights=False)
    assert targets["kimi-k25-reasoning-1m"] == 15_000


def test_tier_a_full_with_50k_cap():
    counts = {"scambench": 12_000}
    targets = compute_targets(counts, per_source_cap=10_000_000,
                              no_weights=False)
    # n < cap → full corpus.
    assert targets["scambench"] == 12_000
