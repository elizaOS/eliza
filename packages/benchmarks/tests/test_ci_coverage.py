"""Every registered benchmark must declare a CI lane (#9475).

This is the de-larp guard: the suite advertised "40+ benchmarks" while 42/43 had
zero scheduled real-model runs. This test makes the CI-coverage classification
in ``orchestrator/ci_coverage.py`` stay 1:1 with the registry, so a new
benchmark cannot be added without an explicit CI lane (``scheduled`` / ``smoke``)
or an explicit ``manual``-only marker — no benchmark silently gets zero CI
coverage.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent))

from benchmarks.orchestrator.ci_coverage import (  # noqa: E402
    CI_LANE_BY_BENCHMARK,
    CI_LANES,
    SCHEDULED_ORCHESTRATOR_SUBSET,
    ci_lane_for,
    classified_benchmark_ids,
    registry_benchmark_ids,
)


def _workspace_root() -> Path:
    return Path(__file__).resolve().parents[2]


def test_every_registered_benchmark_has_a_ci_lane_or_manual_marker() -> None:
    registry_ids = registry_benchmark_ids(_workspace_root())
    classified = classified_benchmark_ids()

    missing = registry_ids - classified
    assert missing == frozenset(), (
        "registered benchmarks with NO CI lane (add to CI_LANE_BY_BENCHMARK in "
        f"orchestrator/ci_coverage.py): {sorted(missing)}"
    )

    stale = classified - registry_ids
    assert stale == frozenset(), (
        "CI_LANE_BY_BENCHMARK lists benchmarks that are no longer registered "
        f"(remove them): {sorted(stale)}"
    )


def test_every_ci_lane_value_is_valid() -> None:
    for benchmark_id, lane in CI_LANE_BY_BENCHMARK.items():
        assert lane in CI_LANES, f"{benchmark_id}: invalid CI lane {lane!r}"


def test_scheduled_orchestrator_subset_is_scheduled_and_registered() -> None:
    registry_ids = registry_benchmark_ids(_workspace_root())
    for benchmark_id in SCHEDULED_ORCHESTRATOR_SUBSET:
        assert benchmark_id in registry_ids, (
            f"{benchmark_id} is in the scheduled orchestrator workflow subset "
            "but is not a registered benchmark"
        )
        assert ci_lane_for(benchmark_id) == "scheduled"


def test_at_least_one_benchmark_per_lane() -> None:
    # The whole point is honest coverage: every lane is actually used, so the
    # taxonomy reflects reality rather than being aspirational.
    lanes_in_use = set(CI_LANE_BY_BENCHMARK.values())
    assert lanes_in_use == set(CI_LANES)
