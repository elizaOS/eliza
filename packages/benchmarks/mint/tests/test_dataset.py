"""
Tests for MINT dataset loader.
"""

import pytest

from benchmarks.mint.types import MINTCategory
from benchmarks.mint.dataset import MINTDataset


class TestMINTDataset:
    """Tests for MINTDataset class."""

    @pytest.fixture
    def dataset(self) -> MINTDataset:
        """Create a dataset instance."""
        return MINTDataset()

    @pytest.mark.asyncio
    async def test_load_builtin_tasks(self, dataset: MINTDataset) -> None:
        """Test loading built-in tasks."""
        await dataset.load()
        
        # Should have tasks in all categories
        for cat in MINTCategory:
            assert cat in dataset.tasks
            assert len(dataset.tasks[cat]) > 0

    @pytest.mark.asyncio
    async def test_get_all_tasks(self, dataset: MINTDataset) -> None:
        """Test getting all tasks."""
        await dataset.load()
        tasks = dataset.get_tasks()
        
        assert len(tasks) > 0
        # Should have tasks from all categories
        categories_found = {task.category for task in tasks}
        assert len(categories_found) == len(MINTCategory)

    @pytest.mark.asyncio
    async def test_get_tasks_by_category(self, dataset: MINTDataset) -> None:
        """Test filtering tasks by category."""
        await dataset.load()
        
        reasoning_tasks = dataset.get_tasks(categories=[MINTCategory.REASONING])
        assert all(t.category == MINTCategory.REASONING for t in reasoning_tasks)
        
        coding_tasks = dataset.get_tasks(categories=[MINTCategory.CODING])
        assert all(t.category == MINTCategory.CODING for t in coding_tasks)

    @pytest.mark.asyncio
    async def test_get_tasks_with_limit(self, dataset: MINTDataset) -> None:
        """Test limiting tasks per category."""
        await dataset.load()
        
        tasks = dataset.get_tasks(limit=2)
        # Should have at most 2 tasks per category
        for cat in MINTCategory:
            cat_tasks = [t for t in tasks if t.category == cat]
            assert len(cat_tasks) <= 2

    @pytest.mark.asyncio
    async def test_get_task_by_id(self, dataset: MINTDataset) -> None:
        """Test getting a specific task by ID."""
        await dataset.load()
        
        # Get a known task
        task = dataset.get_task_by_id("reasoning-001")
        assert task is not None
        assert task.id == "reasoning-001"
        assert task.category == MINTCategory.REASONING

    @pytest.mark.asyncio
    async def test_get_nonexistent_task(self, dataset: MINTDataset) -> None:
        """Test getting a task that doesn't exist."""
        await dataset.load()
        
        task = dataset.get_task_by_id("nonexistent-task")
        assert task is None

    @pytest.mark.asyncio
    async def test_get_category_stats(self, dataset: MINTDataset) -> None:
        """Test getting category statistics."""
        await dataset.load()
        
        stats = dataset.get_category_stats()
        
        assert len(stats) == len(MINTCategory)
        for cat_value, cat_stats in stats.items():
            assert "total" in cat_stats
            assert "easy" in cat_stats
            assert "medium" in cat_stats
            assert "hard" in cat_stats
            assert cat_stats["total"] >= 0

    @pytest.mark.asyncio
    async def test_double_load_is_safe(self, dataset: MINTDataset) -> None:
        """Test that loading twice doesn't duplicate tasks."""
        await dataset.load()
        first_count = sum(len(tasks) for tasks in dataset.tasks.values())
        
        await dataset.load()
        second_count = sum(len(tasks) for tasks in dataset.tasks.values())
        
        assert first_count == second_count

    @pytest.mark.asyncio
    async def test_task_has_required_fields(self, dataset: MINTDataset) -> None:
        """Test all tasks have required fields."""
        await dataset.load()
        tasks = dataset.get_tasks()
        
        for task in tasks:
            assert task.id, "Task must have an ID"
            assert task.category in MINTCategory, "Task must have valid category"
            assert task.description, "Task must have description"
            assert task.initial_prompt, "Task must have initial prompt"
            assert task.ground_truth, "Task must have ground truth"
            assert task.max_turns > 0, "Task must have positive max_turns"
            assert task.tools_allowed, "Task must have tools_allowed"

    @pytest.mark.asyncio
    async def test_builtin_tasks_have_variety(self, dataset: MINTDataset) -> None:
        """Test built-in tasks cover different difficulties."""
        await dataset.load()
        tasks = dataset.get_tasks()
        
        difficulties = {task.difficulty for task in tasks}
        # Should have at least 2 different difficulties
        assert len(difficulties) >= 2
