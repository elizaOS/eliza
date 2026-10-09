"""Shared pytest fixtures for tau-bench tests."""

import sys
from pathlib import Path

import pytest

# Adapter contracts run from a source checkout without editable installs.
for harness in ("eliza", "hermes", "openclaw"):
    harness_path = str(Path(__file__).resolve().parents[3] / "harnesses" / harness)
    if harness_path not in sys.path:
        sys.path.insert(0, harness_path)

from elizaos_tau_bench.types import TauBenchConfig


@pytest.fixture
def mock_config(tmp_path) -> TauBenchConfig:
    return TauBenchConfig(
        domains=["retail", "airline"],
        use_sample_tasks=True,
        use_mock=True,
        num_trials=1,
        pass_k_values=[1],
        use_llm_judge=False,
        output_dir=str(tmp_path / "out"),
        verbose=False,
    )
