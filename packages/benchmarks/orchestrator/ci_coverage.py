"""Classify benchmark execution requirements, independently of hosted coverage.

Smoke suites expose a credential-free diagnostic path. Manual suites require
models, external datasets, hardware, or services. Root benchmarks.yml runs a
selected offline harness lane and permits an explicit live framework run; no
scheduled real-model coverage is claimed by this table.
"""

from __future__ import annotations

from pathlib import Path
from benchmarks.registry import WORKLOADS

CI_LANES: tuple[str, ...] = ("smoke", "manual")

# Benchmark id -> CI lane. MUST stay in 1:1 sync with the public benchmark ids
# (registry ids plus public orchestrator adapter ids; enforced by
# tests/test_ci_coverage.py).
CI_LANE_BY_BENCHMARK = {name: row.execution_class for name, row in WORKLOADS.items()}


def ci_lane_for(benchmark_id: str) -> str:
    """Return the CI lane for a registered benchmark id.

    Raises ``KeyError`` if the benchmark has no classification — the test gate
    keeps this exhaustive, so an unclassified id is a real omission.
    """
    return CI_LANE_BY_BENCHMARK[benchmark_id]


def classified_benchmark_ids() -> frozenset[str]:
    """All benchmark ids that carry a CI-lane classification."""
    return frozenset(CI_LANE_BY_BENCHMARK)


def registry_benchmark_ids(workspace_root: Path) -> frozenset[str]:
    """The canonical registered benchmark ids (registry/commands.py)."""
    from benchmarks.registry import get_benchmark_registry

    return frozenset(entry.id for entry in get_benchmark_registry(workspace_root))


def public_benchmark_ids(workspace_root: Path) -> frozenset[str]:
    """Registered ids plus public orchestrator adapter ids."""
    from benchmarks.orchestrator.adapters import discover_adapters

    adapter_ids = frozenset(discover_adapters(workspace_root).adapters)
    return registry_benchmark_ids(workspace_root) | adapter_ids
