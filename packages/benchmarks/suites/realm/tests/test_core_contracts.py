"""Validates dataset coverage and planning oracle arithmetic."""

from __future__ import annotations

from pathlib import Path

import pytest

from benchmarks.realm.dataset import REALMDataset, parse_jssp_instance
from benchmarks.realm.solvers import (
    disaster_max_coverage_score,
    jssp_compute_makespan,
    jssp_oracle_makespan,
    tsp_tw_oracle,
)
from benchmarks.realm.types import RealmProblem






@pytest.mark.asyncio
async def test_sample_dataset_loads_p1_and_p11() -> None:
    ds = REALMDataset(data_path="./does-not-exist", use_sample_tasks=True)
    await ds.load()
    problems = {t.problem for t in ds.tasks}
    assert RealmProblem.P1 in problems
    assert RealmProblem.P11 in problems


@pytest.mark.asyncio
async def test_upstream_dataset_loads_all_eleven_problems() -> None:
    upstream = Path(__file__).resolve().parents[1] / "upstream" / "datasets"
    if not upstream.exists():
        pytest.skip("upstream datasets not vendored")
    ds = REALMDataset(data_path=upstream, max_instances_per_problem=1)
    await ds.load()
    problems = {t.problem for t in ds.tasks}
    # Every P-folder we vendor must produce at least one task.
    assert problems == set(RealmProblem), f"missing: {set(RealmProblem) - problems}"




def test_jssp_compute_makespan_sample() -> None:
    # 2 jobs x 2 machines, optimal = 5.
    jobs = [[(0, 3), (1, 2)], [(1, 2), (0, 1)]]
    # Optimal sequence per machine.
    # M0: job0 then job1; M1: job1 then job0.
    seq = [[0, 1], [1, 0]]
    assert jssp_compute_makespan(jobs, seq) == 5

    # FIFO baseline is also feasible.
    seq_fifo = [[0, 1], [0, 1]]
    ms = jssp_compute_makespan(jobs, seq_fifo)
    assert ms is not None and ms >= 5


def test_jssp_oracle_returns_optimum() -> None:
    """When OR-Tools is available, the oracle returns true optimum (=5)."""
    from benchmarks.realm import solvers

    if not solvers.has_ortools():
        pytest.skip("OR-Tools not installed")
    jobs = [[(0, 3), (1, 2)], [(1, 2), (0, 1)]]
    opt = jssp_oracle_makespan(jobs, timeout_s=5.0)
    assert opt == 5


def test_tsp_tw_oracle_brute_force_small() -> None:
    distances = {
        "entrance-library": 5,
        "library-entrance": 5,
        "entrance-cafeteria": 7,
        "cafeteria-entrance": 7,
        "library-cafeteria": 4,
        "cafeteria-library": 4,
    }
    tw = {"library": (9.0, 12.0), "cafeteria": (11.0, 14.0)}
    cost, route = tsp_tw_oracle(
        ["entrance", "library", "cafeteria"],
        distances,
        tw,
        start_location="entrance",
        end_location="entrance",
        max_duration=60,
    )
    assert cost is not None
    assert route[0] == route[-1] == "entrance"
    assert set(route[1:-1]) == {"library", "cafeteria"}


def test_disaster_priority_weighting() -> None:
    regions = [
        {"id": "r1", "severity": "critical", "population": 100},
        {"id": "r2", "severity": "normal", "population": 100},
    ]
    resources = {"food": 100}  # only enough for one region
    # Oracle allocates to critical first.
    alloc_optimal = {"r1": {"food": 100}}
    score_opt, oracle, _ = disaster_max_coverage_score(regions, alloc_optimal, resources)
    # Bad allocation to normal-priority region.
    alloc_bad = {"r2": {"food": 100}}
    score_bad, _, _ = disaster_max_coverage_score(regions, alloc_bad, resources)
    assert score_opt > score_bad
    assert score_opt == pytest.approx(oracle, abs=1e-6)


def test_parse_jssp_short_format() -> None:
    text = "2 2\n0 3 1 2\n1 2 0 1\n"
    parsed = parse_jssp_instance(text)
    assert parsed["n_jobs"] == 2
    assert parsed["n_machines"] == 2
    assert parsed["jobs"][0] == [(0, 3), (1, 2)]
