"""Dataset selection tests for the new P1..P11 taxonomy."""

from __future__ import annotations

from pathlib import Path

import pytest

from benchmarks.realm.dataset import REALMDataset
from benchmarks.realm.types import RealmProblem


UPSTREAM = Path(__file__).resolve().parents[1] / "upstream" / "datasets"


@pytest.mark.asyncio
async def test_sample_loader_returns_exactly_one_per_sample_problem() -> None:
    ds = REALMDataset(use_sample_tasks=True)
    await ds.load()
    by_problem: dict[RealmProblem, int] = {}
    for t in ds.tasks:
        by_problem[t.problem] = by_problem.get(t.problem, 0) + 1
    assert by_problem == {RealmProblem.P1: 1, RealmProblem.P11: 1}


@pytest.mark.asyncio
async def test_problem_filter_applies() -> None:
    ds = REALMDataset(use_sample_tasks=True)
    await ds.load()
    cases = ds.get_test_cases(problems=[RealmProblem.P11])
    assert cases
    assert all(c.task.problem == RealmProblem.P11 for c in cases)


@pytest.mark.asyncio
async def test_limit_is_per_problem() -> None:
    if not UPSTREAM.exists():
        pytest.skip("upstream datasets not vendored")
    ds = REALMDataset(data_path=UPSTREAM, max_instances_per_problem=3)
    await ds.load()
    cases = ds.get_test_cases(limit=2)
    # 11 problems x 2 = at most 22 cases (some may have fewer instances).
    assert 0 < len(cases) <= 11 * 2
    # No problem exceeds limit.
    counts: dict[RealmProblem, int] = {}
    for c in cases:
        counts[c.task.problem] = counts.get(c.task.problem, 0) + 1
    for p, n in counts.items():
        assert n <= 2, f"{p} has {n} > 2"


@pytest.mark.asyncio
async def test_full_dataset_loader_allows_uncapped_instances() -> None:
    if not UPSTREAM.exists():
        pytest.skip("upstream datasets not vendored")
    ds = REALMDataset(data_path=UPSTREAM, max_instances_per_problem=None)
    await ds.load()
    counts: dict[RealmProblem, int] = {}
    for t in ds.tasks:
        counts[t.problem] = counts.get(t.problem, 0) + 1
    assert any(n > 5 for n in counts.values())


@pytest.mark.asyncio
async def test_back_compat_category_attr_exists() -> None:
    """``REALMTask.category`` is preserved as an alias for ``problem``."""
    ds = REALMDataset(use_sample_tasks=True)
    await ds.load()
    t = ds.tasks[0]
    assert t.category == t.problem
