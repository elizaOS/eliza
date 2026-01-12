"""Tests for Goals plugin actions.

These tests use mock implementations to test action logic
without requiring actual LLM API calls.
"""

import pytest

from elizaos_plugin_goals.actions import (
    CancelGoalAction,
    CompleteGoalAction,
    ConfirmGoalAction,
    CreateGoalAction,
    UpdateGoalAction,
)
from elizaos_plugin_goals.types import (
    CreateGoalParams,
    Goal,
    GoalFilters,
    GoalOwnerType,
    UpdateGoalParams,
)


class MockRuntime:
    """Mock runtime for testing."""

    agent_id = "agent-123"

    async def use_model(self, model_type: str, params: dict) -> str:
        """Mock model response."""
        prompt = params.get("prompt", "")

        # Mock goal extraction
        if "extract goal" in prompt.lower() or "new goal" in prompt.lower():
            return """<response>
                <name>Learn Python</name>
                <description>Master Python programming</description>
                <ownerType>entity</ownerType>
            </response>"""

        # Mock similarity check
        if "similar" in prompt.lower():
            return """<response>
                <hasSimilar>false</hasSimilar>
                <similarGoalName></similarGoalName>
                <confidence>0</confidence>
            </response>"""

        # Mock goal selection
        if "which" in prompt.lower() and "goal" in prompt.lower():
            return "1"  # Select first goal

        # Mock cancellation extraction
        if "cancel" in prompt.lower():
            return """<response>
                <taskId>goal-1</taskId>
                <taskName>Learn Python</taskName>
                <isFound>true</isFound>
            </response>"""

        # Mock update extraction
        if "update" in prompt.lower():
            return """<response>
                <name>Learn Advanced Python</name>
            </response>"""

        # Mock confirmation
        if "confirm" in prompt.lower():
            return """<response>
                <isConfirmation>true</isConfirmation>
                <shouldProceed>true</shouldProceed>
                <modifications>none</modifications>
            </response>"""

        return ""


class MockGoalService:
    """Mock goal service for testing."""

    def __init__(self) -> None:
        self.goals: list[Goal] = []
        self._next_id = 1

    async def create_goal(self, params: CreateGoalParams) -> str:
        """Create a mock goal."""
        from datetime import datetime

        goal_id = f"goal-{self._next_id}"
        self._next_id += 1

        self.goals.append(
            Goal(
                id=goal_id,
                agent_id=params.agent_id,
                owner_type=params.owner_type,
                owner_id=params.owner_id,
                name=params.name,
                description=params.description,
                tags=params.tags,
                metadata=params.metadata,
                created_at=datetime.now(),
                updated_at=datetime.now(),
            )
        )
        return goal_id

    async def get_goals(self, filters: GoalFilters | None = None) -> list[Goal]:
        """Get goals with optional filtering."""
        if filters is None:
            return self.goals

        result = []
        for goal in self.goals:
            if filters.owner_type and goal.owner_type != filters.owner_type:
                continue
            if filters.owner_id and goal.owner_id != filters.owner_id:
                continue
            if filters.is_completed is not None and goal.is_completed != filters.is_completed:
                continue
            result.append(goal)
        return result

    async def count_goals(
        self, owner_type: GoalOwnerType, owner_id: str, is_completed: bool | None = None
    ) -> int:
        """Count goals."""
        goals = await self.get_goals(
            GoalFilters(owner_type=owner_type, owner_id=owner_id, is_completed=is_completed)
        )
        return len(goals)

    async def update_goal(self, goal_id: str, updates: UpdateGoalParams) -> bool:
        """Update a goal."""
        for goal in self.goals:
            if goal.id == goal_id:
                if updates.name is not None:
                    goal.name = updates.name
                if updates.description is not None:
                    goal.description = updates.description
                if updates.is_completed is not None:
                    goal.is_completed = updates.is_completed
                return True
        return False

    async def delete_goal(self, goal_id: str) -> bool:
        """Delete a goal."""
        for i, goal in enumerate(self.goals):
            if goal.id == goal_id:
                self.goals.pop(i)
                return True
        return False


class TestCreateGoalAction:
    """Tests for CreateGoalAction."""

    def test_action_attributes(self) -> None:
        """Test action has required attributes."""
        action = CreateGoalAction()
        assert action.name == "CREATE_GOAL"
        assert "ADD_GOAL" in action.similes
        assert action.description is not None
        assert len(action.examples) > 0

    @pytest.mark.asyncio
    async def test_validate_always_returns_true(self) -> None:
        """Test validation always passes."""
        action = CreateGoalAction()
        runtime = MockRuntime()
        message = {"content": {"text": "Create a goal"}}

        result = await action.validate(runtime, message)
        assert result is True

    @pytest.mark.asyncio
    async def test_handler_creates_goal(self) -> None:
        """Test handler creates a goal successfully."""
        action = CreateGoalAction()
        runtime = MockRuntime()
        service = MockGoalService()
        message = {
            "content": {"text": "I want to learn Python"},
            "entityId": "user-456",
        }
        state = {"data": {"messages": []}}

        result = await action.handler(runtime, message, state, service)

        assert result.success is True
        assert "Learn Python" in (result.text or "")
        assert len(service.goals) == 1
        assert service.goals[0].name == "Learn Python"


class TestCompleteGoalAction:
    """Tests for CompleteGoalAction."""

    def test_action_attributes(self) -> None:
        """Test action has required attributes."""
        action = CompleteGoalAction()
        assert action.name == "COMPLETE_GOAL"
        assert "ACHIEVE_GOAL" in action.similes

    @pytest.mark.asyncio
    async def test_validate_with_complete_intent(self) -> None:
        """Test validation passes with completion keywords."""
        action = CompleteGoalAction()
        runtime = MockRuntime()

        for keyword in ["complete", "achieve", "finish", "done", "accomplished"]:
            message = {
                "roomId": "room-1",
                "content": {"text": f"I {keyword} my goal"},
            }
            result = await action.validate(runtime, message)
            assert result is True

    @pytest.mark.asyncio
    async def test_validate_without_complete_intent(self) -> None:
        """Test validation fails without completion keywords."""
        action = CompleteGoalAction()
        runtime = MockRuntime()
        message = {
            "roomId": "room-1",
            "content": {"text": "What is the weather?"},
        }

        result = await action.validate(runtime, message)
        assert result is False

    @pytest.mark.asyncio
    async def test_handler_completes_goal(self) -> None:
        """Test handler marks goal as completed."""
        action = CompleteGoalAction()
        runtime = MockRuntime()
        service = MockGoalService()

        # Create a goal first
        await service.create_goal(
            CreateGoalParams(
                agent_id="agent-123",
                owner_type=GoalOwnerType.ENTITY,
                owner_id="user-456",
                name="Learn Python",
            )
        )

        message = {
            "roomId": "room-1",
            "entityId": "user-456",
            "content": {"text": "I completed my Python goal!"},
        }

        result = await action.handler(runtime, message, None, service)

        assert result.success is True
        assert "Congratulations" in (result.text or "")
        assert service.goals[0].is_completed is True


class TestCancelGoalAction:
    """Tests for CancelGoalAction."""

    def test_action_attributes(self) -> None:
        """Test action has required attributes."""
        action = CancelGoalAction()
        assert action.name == "CANCEL_GOAL"
        assert "DELETE_GOAL" in action.similes

    @pytest.mark.asyncio
    async def test_validate_with_goals(self) -> None:
        """Test validation passes when user has goals."""
        action = CancelGoalAction()
        runtime = MockRuntime()
        service = MockGoalService()

        # Create a goal first
        await service.create_goal(
            CreateGoalParams(
                agent_id="agent-123",
                owner_type=GoalOwnerType.ENTITY,
                owner_id="user-456",
                name="Learn Python",
            )
        )

        message = {
            "roomId": "room-1",
            "entityId": "user-456",
            "content": {"text": "Cancel my goal"},
        }

        result = await action.validate(runtime, message, service)
        assert result is True

    @pytest.mark.asyncio
    async def test_validate_without_cancel_intent(self) -> None:
        """Test validation fails without cancel intent keywords."""
        action = CancelGoalAction()
        runtime = MockRuntime()

        message = {
            "roomId": "room-1",
            "entityId": "user-456",
            "content": {"text": "What is my goal?"},
        }

        result = await action.validate(runtime, message)
        assert result is False


class TestUpdateGoalAction:
    """Tests for UpdateGoalAction."""

    def test_action_attributes(self) -> None:
        """Test action has required attributes."""
        action = UpdateGoalAction()
        assert action.name == "UPDATE_GOAL"
        assert "EDIT_GOAL" in action.similes

    @pytest.mark.asyncio
    async def test_validate_with_update_intent(self) -> None:
        """Test validation passes with update intent keywords."""
        action = UpdateGoalAction()
        runtime = MockRuntime()

        message = {
            "roomId": "room-1",
            "entityId": "user-456",
            "content": {"text": "Update my goal"},
        }

        result = await action.validate(runtime, message)
        assert result is True


class TestConfirmGoalAction:
    """Tests for ConfirmGoalAction."""

    def test_action_attributes(self) -> None:
        """Test action has required attributes."""
        action = ConfirmGoalAction()
        assert action.name == "CONFIRM_GOAL"
        assert "APPROVE_GOAL" in action.similes

    @pytest.mark.asyncio
    async def test_validate_with_pending_goal(self) -> None:
        """Test validation passes with pending goal in state."""
        action = ConfirmGoalAction()
        runtime = MockRuntime()
        message = {"content": {"text": "Yes"}}
        state = {
            "data": {
                "pendingGoal": {
                    "name": "Learn Python",
                    "taskType": "one-off",
                }
            }
        }

        result = await action.validate(runtime, message, state)
        assert result is True

    @pytest.mark.asyncio
    async def test_validate_without_pending_goal(self) -> None:
        """Test validation fails without pending goal."""
        action = ConfirmGoalAction()
        runtime = MockRuntime()
        message = {"content": {"text": "Yes"}}
        state = {"data": {}}

        result = await action.validate(runtime, message, state)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_no_state(self) -> None:
        """Test validation fails without state."""
        action = ConfirmGoalAction()
        runtime = MockRuntime()
        message = {"content": {"text": "Yes"}}

        result = await action.validate(runtime, message, None)
        assert result is False
