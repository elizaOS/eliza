"""Unit tests for the dataset loader (mock / fixture mode)."""

from __future__ import annotations

import pytest

from elizaos_voicebench.dataset import count_samples, expand_samples, load_samples, validate_samples
from elizaos_voicebench.types import SUITES


@pytest.mark.parametrize("suite", SUITES)
def test_fixture_loads_for_every_suite(suite: str) -> None:
    samples = load_samples(suite, limit=None, mock=True)  # type: ignore[arg-type]
    assert samples, f"suite {suite} has empty fixture"
    for s in samples:
        assert s.suite == suite
        assert s.sample_id
        assert s.reference_text


def test_fixture_respects_limit() -> None:
    samples = load_samples("openbookqa", limit=1, mock=True)
    assert len(samples) == 1


def test_mcq_choices_pulled_into_metadata() -> None:
    samples = load_samples("openbookqa", limit=None, mock=True)
    assert all(isinstance(s.metadata.get("choices"), list) for s in samples)


def test_ifeval_instructions_pulled_into_metadata() -> None:
    samples = load_samples("ifeval", limit=None, mock=True)
    assert all(isinstance(s.metadata.get("instructions"), list) for s in samples)


def test_edge_expansion_adds_ten_variants_per_sample() -> None:
    samples = load_samples("openbookqa", limit=1, mock=True)
    expanded = expand_samples(samples)

    assert count_samples(samples, include_edge_scenarios=True) == {
        "base": 1,
        "edge": 10,
        "edge_multiplier": 10,
        "total": 11,
    }
    assert len(expanded) == 11
    assert expanded[1].sample_id.startswith(f"{samples[0].sample_id}__edge_")
    assert expanded[1].answer == samples[0].answer
    assert expanded[1].metadata["base_sample_id"] == samples[0].sample_id
    assert expanded[1].metadata["scenario_id"]
    validate_samples(samples, include_edge_scenarios=True)


def test_load_samples_can_expand_selected_fixture_samples() -> None:
    samples = load_samples(
        "openbookqa",
        limit=1,
        mock=True,
        include_edge_scenarios=True,
    )
    assert len(samples) == 11


def test_hf_split_mapping_covers_sharded_suite_layouts() -> None:
    """sd-qa is dialect-region-sharded (USA is canonical); mmsu is
    subject-sharded (all splits form the suite); the rest use "test"."""
    from elizaos_voicebench.dataset import hf_split_for_suite
    from elizaos_voicebench.types import SUITES

    assert hf_split_for_suite("sd-qa") == "usa"
    assert hf_split_for_suite("mmsu") is None
    for suite in SUITES:
        if suite in ("sd-qa", "mmsu"):
            continue
        assert hf_split_for_suite(suite) == "test"
