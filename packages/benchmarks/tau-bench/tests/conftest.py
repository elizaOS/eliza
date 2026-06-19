"""Shared pytest fixtures for tau-bench tests."""

import pytest

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
