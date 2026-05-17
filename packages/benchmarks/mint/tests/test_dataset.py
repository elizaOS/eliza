"""
Tests for MINT dataset loader.
"""

import pytest

from benchmarks.mint.types import MINTSubtask
from benchmarks.mint.dataset import MINTDataset


class TestUpstreamMINTDataset:
    @pytest.fixture
    def dataset(self, official_format_data_path) -> MINTDataset:
        return MINTDataset(
            data_path=official_format_data_path,
            auto_fetch=False,
        )

    @pytest.mark.asyncio
    async def test_load_upstream(self, dataset: MINTDataset) -> None:
        await dataset.load()

        # The fixture mirrors upstream's processed JSONL shape without
        # requiring the full upstream data checkout.
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
        assert len(tasks) <= 6
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

    @pytest.mark.asyncio
    async def test_load_only_requested_subtasks(self, official_format_data_path) -> None:
        dataset = MINTDataset(
            data_path=official_format_data_path,
            auto_fetch=False,
        )
        await dataset.load(subtasks=[MINTSubtask.GSM8K])
        assert dataset.get_tasks(subtasks=[MINTSubtask.GSM8K])
        assert dataset.get_tasks(subtasks=[MINTSubtask.HUMANEVAL]) == []


class TestLazyFetch:
    @pytest.mark.asyncio
    async def test_missing_default_path_fetches_to_cache(
        self,
        tmp_path,
        monkeypatch,
    ) -> None:
        def fake_fetch_file(self, url, target) -> None:
            assert url.endswith("/gsm8k/test_prompts.json")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                '{"id": 0, "prompt": "What is 1 + 1?", "reference": "2"}\n',
                encoding="utf-8",
            )

        monkeypatch.setattr(MINTDataset, "_fetch_file", fake_fetch_file)

        dataset = MINTDataset(
            data_path="",
            cache_dir=tmp_path,
            auto_fetch=True,
        )
        dataset.data_path = tmp_path / "missing-vendored"

        await dataset.load(subtasks=[MINTSubtask.GSM8K])

        tasks = dataset.get_tasks(subtasks=[MINTSubtask.GSM8K])
        assert len(tasks) == 1
        assert tasks[0].id == "gsm8k-0"

    @pytest.mark.asyncio
    async def test_no_auto_fetch_errors_with_cache_guidance(self, tmp_path) -> None:
        dataset = MINTDataset(
            data_path=tmp_path / "missing",
            cache_dir=tmp_path / "cache",
            auto_fetch=False,
        )
        with pytest.raises(RuntimeError, match="use_sample_tasks=True"):
            await dataset.load(subtasks=[MINTSubtask.GSM8K])


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
