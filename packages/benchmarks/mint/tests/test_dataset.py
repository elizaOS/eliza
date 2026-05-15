"""
Tests for MINT dataset loader.
"""

import pytest

from benchmarks.mint.types import MINTSubtask
from benchmarks.mint.dataset import MINTDataset


class TestUpstreamMINTDataset:
    @pytest.fixture
    def dataset(self) -> MINTDataset:
        dataset = MINTDataset()
        if not dataset.data_path.exists() or not any(dataset.data_path.rglob("*.jsonl")):
            pytest.skip(
                f"upstream MINT processed data is not installed at {dataset.data_path}"
            )
        return dataset

    @pytest.mark.asyncio
    async def test_load_upstream(self, dataset: MINTDataset) -> None:
        await dataset.load()

        # We expect samples from each non-alfworld subtask.
        loaded_subtasks = [
            st for st, entries in dataset.tasks.items() if entries
        ]
        assert MINTSubtask.GSM8K in loaded_subtasks
        assert MINTSubtask.HUMANEVAL in loaded_subtasks
        assert MINTSubtask.MATH in loaded_subtasks
        # AlfWorld is intentionally lazy.
        assert dataset.tasks[MINTSubtask.ALFWORLD] == []

    @pytest.mark.asyncio
    async def test_get_tasks_filters_by_subtask(self, dataset: MINTDataset) -> None:
        await dataset.load()
        gsm = dataset.get_tasks(subtasks=[MINTSubtask.GSM8K])
        assert gsm
        assert all(t.subtask == MINTSubtask.GSM8K for t in gsm)

    @pytest.mark.asyncio
    async def test_limit_per_subtask(self, dataset: MINTDataset) -> None:
        await dataset.load()
        tasks = dataset.get_tasks(limit=2)
        # 7 non-alfworld subtasks * 2 -> at most 14.
        assert len(tasks) <= 14
        per_subtask: dict[MINTSubtask, int] = {}
        for t in tasks:
            per_subtask[t.subtask] = per_subtask.get(t.subtask, 0) + 1
        for cnt in per_subtask.values():
            assert cnt <= 2

    @pytest.mark.asyncio
    async def test_task_fields(self, dataset: MINTDataset) -> None:
        await dataset.load()
        tasks = dataset.get_tasks(subtasks=[MINTSubtask.GSM8K], limit=3)
        for t in tasks:
            assert t.id.startswith("gsm8k-")
            assert t.initial_prompt
            assert t.ground_truth
            assert t.evaluation_metric == "numeric"
            assert t.subtask == MINTSubtask.GSM8K

    @pytest.mark.asyncio
    async def test_double_load_is_safe(self, dataset: MINTDataset) -> None:
        await dataset.load()
        first = sum(len(v) for v in dataset.tasks.values())
        await dataset.load()
        second = sum(len(v) for v in dataset.tasks.values())
        assert first == second


class TestSampleSmokeTasks:
    @pytest.fixture
    def dataset(self) -> MINTDataset:
        return MINTDataset(use_sample_tasks=True)

    @pytest.mark.asyncio
    async def test_smoke_set_has_three_tasks(self, dataset: MINTDataset) -> None:
        await dataset.load()
        tasks = dataset.get_tasks()
        assert len(tasks) == 3
        subtasks = {t.subtask for t in tasks}
        assert subtasks == {MINTSubtask.GSM8K, MINTSubtask.HUMANEVAL, MINTSubtask.MMLU}

    @pytest.mark.asyncio
    async def test_get_task_by_id(self, dataset: MINTDataset) -> None:
        await dataset.load()
        task = dataset.get_task_by_id("gsm8k-smoke-0")
        assert task is not None
        assert task.subtask is MINTSubtask.GSM8K
