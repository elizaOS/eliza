"""Smoke tests for REALM-Bench."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from benchmarks.realm.cli import _parse_env_line, load_env_file
from benchmarks.realm.dataset import REALMDataset, parse_jssp_instance
from benchmarks.realm.plugin.actions import _parse_plan_json
from benchmarks.realm.solvers import (
    disaster_max_coverage_score,
    jssp_compute_makespan,
    jssp_oracle_makespan,
    tsp_tw_oracle,
)
from benchmarks.realm.types import RealmProblem


def test_parse_env_line_basic() -> None:
    assert _parse_env_line("FOO=bar") == ("FOO", "bar")
    assert _parse_env_line(" export FOO=bar ") == ("FOO", "bar")
    assert _parse_env_line("# comment") is None
    assert _parse_env_line("") is None
    assert _parse_env_line("NO_EQUALS") is None
    assert _parse_env_line('QUOTED="a b"') == ("QUOTED", "a b")


def test_load_env_file_does_not_override(monkeypatch, tmp_path) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text("FOO=fromfile\nBAR=fromfile\n", encoding="utf-8")

    monkeypatch.setenv("FOO", "already")
    loaded = load_env_file(env_path, override=False)

    assert os.environ["FOO"] == "already"
    assert os.environ["BAR"] == "fromfile"
    assert loaded["BAR"] == "fromfile"
    assert "FOO" not in loaded


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


def test_parse_plan_response_basic() -> None:
    response = """```json
[
  {"action": "tool1", "description": "first", "parameters": {"step": 1}},
  {"action": "tool2", "parameters": {}}
]
```"""
    actions = _parse_plan_json(response, ["tool1", "tool2"])
    assert [a["action"] for a in actions] == ["tool1", "tool2"]
    assert actions[0]["parameters"]["step"] == 1


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
    """OR-Tools is now required; oracle returns true optimum (=5)."""
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
