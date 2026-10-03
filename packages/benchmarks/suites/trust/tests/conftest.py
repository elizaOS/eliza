"""Test fixtures for trust benchmark tests."""

import sys
from pathlib import Path

import pytest

# Add benchmark path
benchmark_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(benchmark_root))

from elizaos_trust_bench.baselines import PerfectHandler, RandomHandler
from elizaos_trust_bench.corpus import TEST_CORPUS


@pytest.fixture
def perfect_handler() -> PerfectHandler:
    """Return a perfect/oracle handler."""
    return PerfectHandler()


@pytest.fixture
def random_handler() -> RandomHandler:
    """Return a random baseline handler."""
    return RandomHandler()


@pytest.fixture
def corpus() -> list:
    """Return the full test corpus."""
    return TEST_CORPUS
