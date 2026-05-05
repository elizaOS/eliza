import pytest

from benchmarks.realm.dataset import REALMDataset
from benchmarks.realm.types import REALMCategory


@pytest.mark.asyncio
async def test_get_test_cases_limit_is_per_category() -> None:
    dataset = REALMDataset(data_path="./does-not-exist")
    await dataset.load()

    # One per category (6 categories)
    test_cases = dataset.get_test_cases(limit=1)
    assert len(test_cases) == len(list(REALMCategory))
    assert {tc.task.category for tc in test_cases} == set(REALMCategory)

    # Two per category (but some categories only have 2 tasks in built-ins)
    test_cases_2 = dataset.get_test_cases(limit=2)
    # Built-in set has >=2 tasks for each category
    assert len(test_cases_2) == 12


@pytest.mark.asyncio
async def test_get_test_cases_category_filtering_respects_limit() -> None:
    dataset = REALMDataset(data_path="./does-not-exist")
    await dataset.load()

    test_cases = dataset.get_test_cases(categories=[REALMCategory.SEQUENTIAL], limit=2)
    assert len(test_cases) == 2
    assert all(tc.task.category == REALMCategory.SEQUENTIAL for tc in test_cases)


@pytest.mark.asyncio
async def test_required_actions_default_to_expected_actions() -> None:
    dataset = REALMDataset(data_path="./does-not-exist")
    await dataset.load()

    # Pick a task where available_tools has more items than expected actions
    tc = next(tc for tc in dataset.test_cases if tc.task.id == "react-001")
    expected_actions = tc.expected.get("actions")
    assert isinstance(expected_actions, list)

    metrics = tc.expected.get("metrics")
    assert isinstance(metrics, dict)
    required_actions = metrics.get("required_actions")
    assert isinstance(required_actions, list)

    assert required_actions == expected_actions

