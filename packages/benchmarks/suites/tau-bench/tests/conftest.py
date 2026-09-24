"""Shared pytest fixtures for tau-bench tests."""

import sys
from pathlib import Path

import pytest

# The smoke tests drive the eliza harness adapter directly; make it importable
# from a plain checkout (it is an editable install when running under uv).
_ELIZA_HARNESS = str(Path(__file__).resolve().parents[3] / "harnesses" / "eliza")
if _ELIZA_HARNESS not in sys.path:
    sys.path.insert(0, _ELIZA_HARNESS)

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
