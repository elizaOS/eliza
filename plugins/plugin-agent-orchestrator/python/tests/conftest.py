"""
Pytest configuration and fixtures for Agent Orchestrator plugin tests.
"""

from dataclasses import dataclass, field
from typing import Any

import pytest

from elizaos_plugin_agent_orchestrator import (
    AgentOrchestratorPluginOptions,
    TaskResult,
    configure_agent_orchestrator_plugin,
    reset_configuration,
)


@dataclass
class MockTask:
    """Mock task for testing."""

    id: str
    name: str
    description: str
    metadata: dict[str, Any]
    tags: list[str] = field(default_factory=list)
    room_id: str | None = None
    world_id: str | None = None


class MockRuntime:
    """Mock runtime for testing."""

    def __init__(self) -> None:
        self.agent_id = "test-agent-id"
        self._tasks: dict[str, MockTask] = {}
        self._services: dict[str, Any] = {}
        self._task_counter = 0

    async def create_task(self, task_input: dict[str, Any]) -> str:
        self._task_counter += 1
        task_id = f"task-{self._task_counter}"
        self._tasks[task_id] = MockTask(
            id=task_id,
            name=task_input.get("name", ""),
            description=task_input.get("description", ""),
            metadata=task_input.get("metadata", {}),
            tags=task_input.get("tags", []),
            room_id=task_input.get("roomId"),
            world_id=task_input.get("worldId"),
        )
        return task_id

    async def get_task(self, task_id: str) -> MockTask | None:
        return self._tasks.get(task_id)

    async def get_tasks(self, options: dict[str, Any]) -> list[MockTask]:
        tags = options.get("tags", [])
        if not tags:
            return list(self._tasks.values())
        return [t for t in self._tasks.values() if any(tag in t.tags for tag in tags)]

    async def update_task(self, task_id: str, updates: dict[str, Any]) -> None:
        task = self._tasks.get(task_id)
        if task and "metadata" in updates:
            task.metadata = updates["metadata"]

    async def delete_task(self, task_id: str) -> None:
        self._tasks.pop(task_id, None)

    async def get_room(self, room_id: str) -> Any | None:
        return None

    def get_service(self, service_type: str) -> Any | None:
        return self._services.get(service_type)

    def register_service(self, service_type: str, service: Any) -> None:
        self._services[service_type] = service


class NoOpProvider:
    """No-op provider for testing."""

    id = "noop"
    label = "No-Op Provider"
    description = "Does nothing"

    async def execute_task(self, task: Any, ctx: Any) -> TaskResult:
        await ctx.append_output("No-op execution")
        await ctx.update_progress(100)
        return TaskResult(
            success=True,
            summary="No-op completed",
            files_created=[],
            files_modified=[],
        )


@pytest.fixture
def mock_runtime() -> MockRuntime:
    """Create a mock runtime."""
    return MockRuntime()


@pytest.fixture
def noop_provider() -> NoOpProvider:
    """Create a no-op provider."""
    return NoOpProvider()


@pytest.fixture(autouse=True)
def reset_config():
    """Reset configuration before each test."""
    reset_configuration()
    yield
    reset_configuration()


@pytest.fixture
def configured_options(noop_provider: NoOpProvider) -> AgentOrchestratorPluginOptions:
    """Configure plugin with no-op provider."""
    import os

    options = AgentOrchestratorPluginOptions(
        providers=[noop_provider],
        default_provider_id="noop",
        get_working_directory=lambda: os.getcwd(),
    )
    configure_agent_orchestrator_plugin(options)
    return options
