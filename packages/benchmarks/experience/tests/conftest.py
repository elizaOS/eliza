"""Test fixtures for experience benchmark tests."""

import sys
from pathlib import Path

import pytest

# Add benchmark and plugin paths
benchmark_root = Path(__file__).resolve().parents[1]
plugin_root = Path(__file__).resolve().parents[3] / "plugins" / "plugin-experience" / "python"
sys.path.insert(0, str(benchmark_root))
sys.path.insert(0, str(plugin_root))

from elizaos_experience_bench.generator import ExperienceGenerator


@pytest.fixture
def generator() -> ExperienceGenerator:
    return ExperienceGenerator(seed=42)


@pytest.fixture
def small_experience_set(generator: ExperienceGenerator):
    return generator.generate_experiences(count=50)


@pytest.fixture
def large_experience_set(generator: ExperienceGenerator):
    return generator.generate_experiences(count=1000)
