"""Tests for the planning plugin actions, types, and providers."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest

from elizaos_plugin_planning.actions.complete_task import complete_task_action
from elizaos_plugin_planning.actions.create_plan import create_plan_action
from elizaos_plugin_planning.actions.get_plan import get_plan_action
from elizaos_plugin_planning.actions.update_plan import update_plan_action
from elizaos_plugin_planning.providers.plan_status import plan_status_provider
from elizaos_plugin_planning.types import (
    PLAN_SOURCE,
    Plan,
    PlanStatus,
    Task,
    TaskStatus,
    decode_plan,
    encode_plan,
    format_plan,
    generate_task_id,
    get_plan_progress,
)


# --- Type Utilities ---


def make_test_plan(task_statuses: list[TaskStatus]) -> Plan:
    tasks = [
        Task(
            id=generate_task_id(i),
            title=f"Task {i + 1}",
            description="",
            status=status,
            order=i + 1,
            dependencies=[],
            assignee=None,
            created_at=1000,
            completed_at=1000 if status == TaskStatus.COMPLETED else None,
        )
        for i, status in enumerate(task_statuses)
    ]
    return Plan(
        id="plan-test",
        title="Test Plan",
        description="A test plan",
        status=PlanStatus.ACTIVE,
        tasks=tasks,
        created_at=1000,
        updated_at=1000,
        metadata={},
    )


class TestTypes:
    def test_generate_task_id(self) -> None:
        assert generate_task_id(0) == "task-1"
        assert generate_task_id(1) == "task-2"
        assert generate_task_id(9) == "task-10"

    def test_encode_decode_roundtrip(self) -> None:
        plan = make_test_plan([TaskStatus.PENDING, TaskStatus.COMPLETED])
        encoded = encode_plan(plan)
        decoded = decode_plan(encoded)

        assert decoded is not None
        assert decoded.id == plan.id
        assert decoded.title == plan.title
        assert len(decoded.tasks) == 2
        assert decoded.tasks[0].status == TaskStatus.PENDING
        assert decoded.tasks[1].status == TaskStatus.COMPLETED

    def test_decode_invalid_data(self) -> None:
        assert decode_plan("not json") is None
        assert decode_plan("{}") is None
        assert decode_plan('{"id": "x"}') is None

    def test_progress_empty(self) -> None:
        plan = make_test_plan([])
        assert get_plan_progress(plan) == 0

    def test_progress_none_done(self) -> None:
        plan = make_test_plan([TaskStatus.PENDING, TaskStatus.PENDING])
        assert get_plan_progress(plan) == 0

    def test_progress_all_done(self) -> None:
        plan = make_test_plan([TaskStatus.COMPLETED, TaskStatus.COMPLETED])
        assert get_plan_progress(plan) == 100

    def test_progress_partial(self) -> None:
        plan = make_test_plan([TaskStatus.COMPLETED, TaskStatus.PENDING])
        assert get_plan_progress(plan) == 50

    def test_progress_two_thirds(self) -> None:
        plan = make_test_plan(
            [TaskStatus.COMPLETED, TaskStatus.COMPLETED, TaskStatus.PENDING]
        )
        assert get_plan_progress(plan) == 67

    def test_format_plan(self) -> None:
        plan = make_test_plan([TaskStatus.COMPLETED, TaskStatus.PENDING])
        plan.title = "Launch Plan"
        plan.description = "Launch the website"
        plan.tasks[1].assignee = "alice"

        formatted = format_plan(plan)
        assert "Launch Plan" in formatted
        assert "50%" in formatted
        assert "[x] Task 1" in formatted
        assert "[ ] Task 2" in formatted
        assert "@alice" in formatted

    def test_format_in_progress(self) -> None:
        plan = make_test_plan([TaskStatus.IN_PROGRESS])
        assert "[~]" in format_plan(plan)

    def test_format_cancelled(self) -> None:
        plan = make_test_plan([TaskStatus.CANCELLED])
        assert "[-]" in format_plan(plan)


# --- Mock Runtime (aligned with runtime DB API) ---


class MockRuntime:
    def __init__(
        self,
        memories: list[dict] | None = None,
        model_response: str | None = None,
    ) -> None:
        self._memories = memories or []
        self._model_response = model_response
        self.agent_id = "test-agent"
        self.create_memory = AsyncMock(return_value="plan-uuid")
        self.update_memory = AsyncMock(return_value=True)
        self.delete_memory = AsyncMock()

    async def get_memories(self, params: dict) -> list[dict]:
        return self._memories

    def get_setting(self, key: str) -> str | None:
        return None

    def get_service(self, name: str) -> object | None:
        return None

    async def use_model(self, model_type: str, params: dict) -> str | None:
        return self._model_response


# --- CREATE_PLAN Action ---


class TestCreatePlan:
    def test_metadata(self) -> None:
        assert create_plan_action.name == "CREATE_PLAN"
        assert create_plan_action.description
        assert "create-plan" in create_plan_action.similes

    @pytest.mark.asyncio
    async def test_validate(self) -> None:
        runtime = MockRuntime()
        assert await create_plan_action.validate(runtime, {"content": {"text": "test"}}) is True

    @pytest.mark.asyncio
    async def test_create_plan_with_llm(self) -> None:
        runtime = MockRuntime(
            model_response=json.dumps(
                {
                    "title": "Website Launch",
                    "description": "Steps to launch",
                    "tasks": [
                        {"title": "Setup hosting"},
                        {"title": "Deploy code"},
                    ],
                }
            ),
        )
        message = {"roomId": "r1", "userId": "u1", "content": {"text": "Plan the launch"}}

        result = await create_plan_action.handler(runtime, message)
        assert result["success"] is True
        assert "Website Launch" in result["text"]
        assert "2 tasks" in result["text"]
        runtime.create_memory.assert_called_once()


# --- UPDATE_PLAN Action ---


class TestUpdatePlan:
    def test_metadata(self) -> None:
        assert update_plan_action.name == "UPDATE_PLAN"
        assert "update-plan" in update_plan_action.similes

    @pytest.mark.asyncio
    async def test_no_plans(self) -> None:
        runtime = MockRuntime(memories=[])
        message = {"roomId": "r1", "content": {"text": "update"}}

        result = await update_plan_action.handler(runtime, message)
        assert result["success"] is False
        assert "No plans found" in result["text"]


# --- COMPLETE_TASK Action ---


class TestCompleteTask:
    def test_metadata(self) -> None:
        assert complete_task_action.name == "COMPLETE_TASK"
        assert "complete-task" in complete_task_action.similes

    @pytest.mark.asyncio
    async def test_complete_by_id(self) -> None:
        plan = make_test_plan([TaskStatus.PENDING])
        encoded = encode_plan(plan)
        memories = [
            {
                "id": "mem-1",
                "content": {"text": encoded, "source": PLAN_SOURCE},
                "createdAt": 1000,
            }
        ]
        runtime = MockRuntime(memories=memories)
        message = {"roomId": "r1", "userId": "u1", "content": {"text": "complete task"}}
        options = {"taskId": "task-1"}

        result = await complete_task_action.handler(runtime, message, None, options)
        assert result["success"] is True
        assert "Completed task" in result["text"]
        assert "100%" in result["text"]
        runtime.update_memory.assert_called_once()

    @pytest.mark.asyncio
    async def test_no_plans(self) -> None:
        runtime = MockRuntime(memories=[])
        message = {"roomId": "r1", "content": {"text": "done"}}

        result = await complete_task_action.handler(runtime, message)
        assert result["success"] is False
        assert "No plans found" in result["text"]


# --- GET_PLAN Action ---


class TestGetPlan:
    def test_metadata(self) -> None:
        assert get_plan_action.name == "GET_PLAN"
        assert "get-plan" in get_plan_action.similes

    @pytest.mark.asyncio
    async def test_no_plans(self) -> None:
        runtime = MockRuntime(memories=[])
        message = {"roomId": "r1", "content": {"text": "show plans"}}

        result = await get_plan_action.handler(runtime, message)
        assert result["success"] is True
        assert "No plans found" in result["text"]

    @pytest.mark.asyncio
    async def test_show_all_plans(self) -> None:
        plan = make_test_plan([TaskStatus.COMPLETED, TaskStatus.PENDING])
        encoded = encode_plan(plan)
        memories = [{"content": {"text": encoded, "source": PLAN_SOURCE}}]
        runtime = MockRuntime(memories=memories)
        message = {"roomId": "r1", "content": {"text": "show plans"}}

        result = await get_plan_action.handler(runtime, message)
        assert result["success"] is True
        assert "Plans (1)" in result["text"]
        assert "Test Plan" in result["text"]


# --- Plan Status Provider ---


class TestPlanStatusProvider:
    def test_metadata(self) -> None:
        assert plan_status_provider.name == "PLAN_STATUS"
        assert plan_status_provider.description

    @pytest.mark.asyncio
    async def test_empty(self) -> None:
        runtime = MockRuntime(memories=[])
        result = await plan_status_provider.get(runtime, {"roomId": "r1"}, {})
        assert "No active plans" in result.text

    @pytest.mark.asyncio
    async def test_with_plans(self) -> None:
        plan = make_test_plan([TaskStatus.COMPLETED, TaskStatus.PENDING])
        encoded = encode_plan(plan)
        memories = [
            {"content": {"text": encoded, "source": PLAN_SOURCE}, "createdAt": 1000}
        ]
        runtime = MockRuntime(memories=memories)
        result = await plan_status_provider.get(runtime, {"roomId": "r1"}, {})

        assert "Active Plans (1)" in result.text
        assert "50%" in result.text
        assert "Test Plan" in result.text

    @pytest.mark.asyncio
    async def test_sorted_with_next_task(self) -> None:
        plan = make_test_plan([TaskStatus.COMPLETED, TaskStatus.PENDING])
        encoded = encode_plan(plan)
        memories = [
            {"content": {"text": encoded, "source": PLAN_SOURCE}, "createdAt": 1000}
        ]
        runtime = MockRuntime(memories=memories)
        result = await plan_status_provider.get(runtime, {"roomId": "r1"}, {})

        assert "Next: Task 2" in result.text
