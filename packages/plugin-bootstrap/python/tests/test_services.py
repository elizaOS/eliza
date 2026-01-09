"""
Tests for Bootstrap Plugin services.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from elizaos_plugin_bootstrap.services.task import (
    Task,
    TaskPriority,
    TaskService,
    TaskStatus,
)
from elizaos_plugin_bootstrap.services.embedding import EmbeddingService


class TestTaskService:
    """Tests for the TaskService."""

    @pytest.mark.asyncio
    async def test_task_service_start_stop(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Test that TaskService starts and stops correctly."""
        service = TaskService()

        await service.start(mock_runtime)
        assert service._runtime is mock_runtime

        await service.stop()
        assert service._runtime is None

    @pytest.mark.asyncio
    async def test_create_task(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Test creating a task."""
        service = TaskService()
        await service.start(mock_runtime)

        task = await service.create_task(
            name="Test Task",
            description="A test task",
            priority=TaskPriority.HIGH,
        )

        assert task.name == "Test Task"
        assert task.description == "A test task"
        assert task.priority == TaskPriority.HIGH
        assert task.status == TaskStatus.PENDING

        await service.stop()

    @pytest.mark.asyncio
    async def test_get_task(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Test getting a task by ID."""
        service = TaskService()
        await service.start(mock_runtime)

        created = await service.create_task(
            name="Test Task",
            description="A test task",
        )

        retrieved = await service.get_task(created.id)

        assert retrieved is not None
        assert retrieved.id == created.id
        assert retrieved.name == created.name

        await service.stop()

    @pytest.mark.asyncio
    async def test_update_task_status(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Test updating task status."""
        service = TaskService()
        await service.start(mock_runtime)

        task = await service.create_task(
            name="Test Task",
            description="A test task",
        )

        updated = await service.update_task_status(task.id, TaskStatus.IN_PROGRESS)

        assert updated is not None
        assert updated.status == TaskStatus.IN_PROGRESS

        await service.stop()

    @pytest.mark.asyncio
    async def test_complete_task(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Test completing a task."""
        service = TaskService()
        await service.start(mock_runtime)

        task = await service.create_task(
            name="Test Task",
            description="A test task",
        )

        completed = await service.complete_task(task.id)

        assert completed is not None
        assert completed.status == TaskStatus.COMPLETED
        assert completed.completed_at is not None

        await service.stop()

    @pytest.mark.asyncio
    async def test_get_pending_tasks_sorted_by_priority(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Test that pending tasks are sorted by priority."""
        service = TaskService()
        await service.start(mock_runtime)

        await service.create_task("Low", "Low priority", TaskPriority.LOW)
        await service.create_task("Urgent", "Urgent priority", TaskPriority.URGENT)
        await service.create_task("Medium", "Medium priority", TaskPriority.MEDIUM)
        await service.create_task("High", "High priority", TaskPriority.HIGH)

        pending = await service.get_pending_tasks()

        assert len(pending) == 4
        assert pending[0].name == "Urgent"
        assert pending[1].name == "High"
        assert pending[2].name == "Medium"
        assert pending[3].name == "Low"

        await service.stop()


class TestEmbeddingService:
    """Tests for the EmbeddingService."""

    @pytest.mark.asyncio
    async def test_embedding_service_start_stop(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Test that EmbeddingService starts and stops correctly."""
        service = EmbeddingService()

        await service.start(mock_runtime)
        assert service._runtime is mock_runtime

        await service.stop()
        assert service._runtime is None

    @pytest.mark.asyncio
    async def test_embed_text(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Test embedding text."""
        mock_runtime.use_model.return_value = [0.1, 0.2, 0.3, 0.4]

        service = EmbeddingService()
        await service.start(mock_runtime)

        embedding = await service.embed("Hello world")

        assert embedding == [0.1, 0.2, 0.3, 0.4]
        mock_runtime.use_model.assert_called_once()

        await service.stop()

    @pytest.mark.asyncio
    async def test_embed_caching(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Test that embeddings are cached."""
        mock_runtime.use_model.return_value = [0.1, 0.2, 0.3, 0.4]

        service = EmbeddingService()
        await service.start(mock_runtime)

        # First call
        await service.embed("Hello world")
        # Second call - should use cache
        await service.embed("Hello world")

        # Should only call model once due to caching
        assert mock_runtime.use_model.call_count == 1

        await service.stop()

    @pytest.mark.asyncio
    async def test_similarity(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Test similarity calculation."""
        # Set up mock to return different embeddings for different texts
        def side_effect(*args, **kwargs):
            if "hello" in kwargs.get("text", "").lower():
                return [1.0, 0.0, 0.0]
            return [0.0, 1.0, 0.0]

        mock_runtime.use_model.side_effect = side_effect

        service = EmbeddingService()
        await service.start(mock_runtime)

        similarity = await service.similarity("Hello", "World")

        # Orthogonal vectors should have 0 similarity
        assert similarity == 0.0

        await service.stop()

