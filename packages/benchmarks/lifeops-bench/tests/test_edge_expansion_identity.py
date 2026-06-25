"""Guard: edge-expanded scenarios are prompt-robustness clones, not new work.

LifeOpsBench inflates its corpus 10x by re-emitting every base scenario under
fixed prompt-prefix framings (polite/urgent/mobile/…). That is honest
*prompt-robustness* coverage **only if** a variant changes the prompt wording
and nothing else: it must share its base's ``ground_truth_actions``,
``required_outputs`` and ``world_seed``. If a variant ever diverged on any of
those, the 10x count would silently become uncredited "new" scenarios — the
exact dishonesty this guard exists to prevent (#8795).

These tests pin the contract so the expansion can never quietly drift.
"""

from __future__ import annotations

import dataclasses

import pytest

from eliza_lifeops_bench.scenarios import (
    CORE_SCENARIOS,
    EDGE_EXPANDED_SCENARIOS,
    EDGE_EXPANSION_MULTIPLIER,
    EDGE_VARIANTS,
    count_lifeops_scenarios,
)

# Fields the expansion is allowed to rewrite (prompt wording / identity only).
PROMPT_FIELDS: frozenset[str] = frozenset({"id", "name", "instruction", "description"})

# Fields that MUST be byte-identical between a base and each of its variants.
# Everything in the Scenario dataclass that is not a prompt field — most
# importantly the scored ground truth, required outputs, and world seed.
IDENTITY_FIELDS: tuple[str, ...] = tuple(
    f.name for f in dataclasses.fields(CORE_SCENARIOS[0]) if f.name not in PROMPT_FIELDS
)


def _variants_for(base_id: str) -> list:
    prefix = f"{base_id}--edge-"
    return [s for s in EDGE_EXPANDED_SCENARIOS if s.id.startswith(prefix)]


def test_identity_fields_cover_the_scored_contract() -> None:
    # The three fields #8795 calls out must be in the identity set, not the
    # prompt set — otherwise the guard would be vacuous.
    for required in ("ground_truth_actions", "required_outputs", "world_seed"):
        assert required in IDENTITY_FIELDS, (
            f"{required} must be an identity field, not a prompt field"
        )
    assert "persona" in IDENTITY_FIELDS  # scored personas must not drift either


def test_each_base_has_exactly_the_declared_variants() -> None:
    assert len(EDGE_VARIANTS) == EDGE_EXPANSION_MULTIPLIER
    variant_ids = {vid for vid, _desc, _tmpl in EDGE_VARIANTS}
    assert len(variant_ids) == EDGE_EXPANSION_MULTIPLIER, "duplicate edge-variant ids"

    for base in CORE_SCENARIOS:
        variants = _variants_for(base.id)
        assert len(variants) == EDGE_EXPANSION_MULTIPLIER, (
            f"{base.id} has {len(variants)} edge variants, "
            f"expected {EDGE_EXPANSION_MULTIPLIER}"
        )
        got = {v.id[len(f"{base.id}--edge-"):] for v in variants}
        assert got == variant_ids, (
            f"{base.id} variant suffixes {sorted(got)} != {sorted(variant_ids)}"
        )


def test_variants_share_base_identity_fields() -> None:
    """Every non-prompt field is identical between a base and each variant."""
    bad: list[str] = []
    for base in CORE_SCENARIOS:
        for variant in _variants_for(base.id):
            for field_name in IDENTITY_FIELDS:
                if getattr(base, field_name) != getattr(variant, field_name):
                    bad.append(
                        f"{variant.id}: field {field_name!r} diverged from base "
                        f"{base.id!r}"
                    )
    assert not bad, (
        "edge variants must be prompt-only clones of their base; diverged on:\n"
        + "\n".join(bad)
    )


def test_variants_actually_change_the_prompt() -> None:
    """The expansion is real robustness coverage: prompt fields DO differ."""
    bad: list[str] = []
    for base in CORE_SCENARIOS:
        for variant in _variants_for(base.id):
            if variant.id == base.id:
                bad.append(f"{variant.id}: id not rewritten")
            if variant.instruction == base.instruction:
                bad.append(f"{variant.id}: instruction not reframed")
            if base.instruction not in variant.instruction:
                bad.append(
                    f"{variant.id}: reframed instruction dropped the base instruction"
                )
    assert not bad, "edge variants must reframe the prompt:\n" + "\n".join(bad)


def test_count_summary_states_base_vs_runs() -> None:
    counts = count_lifeops_scenarios()
    assert counts["base"] == len(CORE_SCENARIOS)
    assert counts["variantsPerBase"] == EDGE_EXPANSION_MULTIPLIER
    assert counts["totalRuns"] == len(CORE_SCENARIOS) * (1 + EDGE_EXPANSION_MULTIPLIER)
    # The human-facing summary must distinguish base scenarios from runs so the
    # 10x inflation can never read as 11220 distinct scenarios.
    summary = counts["summary"]
    assert isinstance(summary, str)
    assert "base" in summary and "robustness" in summary and "runs" in summary


@pytest.mark.parametrize("seed_field", ["world_seed", "ground_truth_actions", "required_outputs"])
def test_guard_is_not_vacuous(seed_field: str) -> None:
    """If a variant's scored field diverged, the identity check must catch it.

    We never mutate the real corpus — we build a one-off diverged variant in
    memory and assert the same comparison the guard uses would flag it.
    """
    base = CORE_SCENARIOS[0]
    if seed_field == "world_seed":
        diverged = dataclasses.replace(base, world_seed=base.world_seed + 1)
    elif seed_field == "ground_truth_actions":
        diverged = dataclasses.replace(base, ground_truth_actions=[])
    else:
        diverged = dataclasses.replace(base, required_outputs=["__divergent__"])
    assert getattr(diverged, seed_field) != getattr(base, seed_field)
