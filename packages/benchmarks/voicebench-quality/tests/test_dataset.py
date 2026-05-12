"""Unit tests for the dataset loader (mock / fixture mode)."""

from __future__ import annotations

import pytest

from elizaos_voicebench.dataset import load_samples
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
