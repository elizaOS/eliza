"""
Tests for AgentOrchestratorService.
"""

import pytest

from elizaos_plugin_agent_orchestrator import (
    AgentOrchestratorService,
    TaskStatus,
    TaskUserStatus,
)


@pytest.mark.asyncio
async def test_create_task(mock_runtime, configured_options):
    """Test creating a task."""
    svc = await AgentOrchestratorService.start(mock_runtime)
    mock_runtime.register_service("CODE_TASK", svc)

    task = await svc.create_task("Test Task", "Test description")

    assert task.name == "Test Task"
    assert task.description == "Test description"
    assert task.metadata.status == TaskStatus.PENDING
    assert task.metadata.progress == 0
    assert task.metadata.provider_id == "noop"


@pytest.mark.asyncio
async def test_get_recent_tasks(mock_runtime, configured_options):
    """Test getting recent tasks."""
    svc = await AgentOrchestratorService.start(mock_runtime)
    mock_runtime.register_service("CODE_TASK", svc)

    await svc.create_task("Task 1", "Description 1")
    await svc.create_task("Task 2", "Description 2")
    await svc.create_task("Task 3", "Description 3")

    tasks = await svc.get_recent_tasks(2)
    assert len(tasks) == 2


@pytest.mark.asyncio
async def test_search_tasks(mock_runtime, configured_options):
    """Test searching tasks."""
    svc = await AgentOrchestratorService.start(mock_runtime)
    mock_runtime.register_service("CODE_TASK", svc)

    await svc.create_task("Implement feature", "Feature description")
    await svc.create_task("Fix bug", "Bug description")

    results = await svc.search_tasks("feature")
    assert len(results) == 1
    assert results[0].name == "Implement feature"


@pytest.mark.asyncio
async def test_pause_resume_task(mock_runtime, configured_options):
    """Test pausing and resuming a task."""
    svc = await AgentOrchestratorService.start(mock_runtime)
    mock_runtime.register_service("CODE_TASK", svc)

    task = await svc.create_task("Test Task", "Description")

    await svc.pause_task(task.id)
    paused = await svc.get_task(task.id)
    assert paused.metadata.status == TaskStatus.PAUSED

    await svc.resume_task(task.id)
    resumed = await svc.get_task(task.id)
    assert resumed.metadata.status == TaskStatus.RUNNING


@pytest.mark.asyncio
async def test_cancel_task(mock_runtime, configured_options):
    """Test cancelling a task."""
    svc = await AgentOrchestratorService.start(mock_runtime)
    mock_runtime.register_service("CODE_TASK", svc)

    task = await svc.create_task("Test Task", "Description")

    await svc.cancel_task(task.id)
    cancelled = await svc.get_task(task.id)
    assert cancelled.metadata.status == TaskStatus.CANCELLED


@pytest.mark.asyncio
async def test_update_progress(mock_runtime, configured_options):
    """Test updating task progress."""
    svc = await AgentOrchestratorService.start(mock_runtime)
    mock_runtime.register_service("CODE_TASK", svc)

    task = await svc.create_task("Test Task", "Description")

    await svc.update_task_progress(task.id, 50)
    updated = await svc.get_task(task.id)
    assert updated.metadata.progress == 50


@pytest.mark.asyncio
async def test_add_step(mock_runtime, configured_options):
    """Test adding steps to a task."""
    svc = await AgentOrchestratorService.start(mock_runtime)
    mock_runtime.register_service("CODE_TASK", svc)

    task = await svc.create_task("Test Task", "Description")

    step = await svc.add_step(task.id, "Step 1")
    assert step.description == "Step 1"
    assert step.status == TaskStatus.PENDING

    updated = await svc.get_task(task.id)
    assert len(updated.metadata.steps) == 1


@pytest.mark.asyncio
async def test_set_user_status(mock_runtime, configured_options):
    """Test setting user status."""
    svc = await AgentOrchestratorService.start(mock_runtime)
    mock_runtime.register_service("CODE_TASK", svc)

    task = await svc.create_task("Test Task", "Description")

    await svc.set_user_status(task.id, TaskUserStatus.DONE)
    updated = await svc.get_task(task.id)
    assert updated.metadata.user_status == TaskUserStatus.DONE


@pytest.mark.asyncio
async def test_get_task_context(mock_runtime, configured_options):
    """Test getting task context."""
    svc = await AgentOrchestratorService.start(mock_runtime)
    mock_runtime.register_service("CODE_TASK", svc)

    context = await svc.get_task_context()
    assert "No tasks" in context

    await svc.create_task("Test Task", "Description")
    context = await svc.get_task_context()
    assert "Test Task" in context
