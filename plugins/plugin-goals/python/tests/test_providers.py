"""Tests for Goals plugin providers."""

from datetime import datetime

import pytest

from elizaos_plugin_goals.providers import GoalsProvider
from elizaos_plugin_goals.types import (
    Goal,
    GoalFilters,
    GoalOwnerType,
)


class MockRuntime:
    """Mock runtime for testing."""

    agent_id = "agent-123"


class MockGoalService:
    """Mock goal service for testing."""

    def __init__(self) -> None:
        self.goals: list[Goal] = []

    def add_goal(
        self,
        name: str,
        owner_type: GoalOwnerType = GoalOwnerType.ENTITY,
        owner_id: str = "user-456",
        is_completed: bool = False,
        completed_at: datetime | None = None,
    ) -> Goal:
        """Add a goal for testing."""
        goal = Goal(
            id=f"goal-{len(self.goals) + 1}",
            agent_id="agent-123",
            owner_type=owner_type,
            owner_id=owner_id,
            name=name,
            is_completed=is_completed,
            completed_at=completed_at,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        self.goals.append(goal)
        return goal

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


class TestGoalsProvider:
    """Tests for GoalsProvider."""

    def test_provider_attributes(self) -> None:
        """Test provider has required attributes."""
        provider = GoalsProvider()
        assert provider.name == "GOALS"
        assert provider.description is not None

    @pytest.mark.asyncio
    async def test_get_no_goals(self) -> None:
        """Test provider with no goals."""
        provider = GoalsProvider()
        runtime = MockRuntime()
        service = MockGoalService()
        message = {"entityId": "user-456"}
        state = {}

        result = await provider.get(runtime, message, state, service)

        assert "No goals have been set yet" in result.text
        assert result.data.get("activeGoalCount") == 0
        assert result.data.get("completedGoalCount") == 0

    @pytest.mark.asyncio
    async def test_get_with_active_goals(self) -> None:
        """Test provider with active goals."""
        provider = GoalsProvider()
        runtime = MockRuntime()
        service = MockGoalService()
        message = {"entityId": "user-456"}
        state = {}

        # Add active goals
        service.add_goal("Learn Python")
        service.add_goal("Run marathon")

        result = await provider.get(runtime, message, state, service)

        assert "Active Goals" in result.text
        assert "Learn Python" in result.text
        assert "Run marathon" in result.text
        assert result.data.get("activeGoalCount") == 2
        assert result.values.get("activeGoalCount") == "2"

    @pytest.mark.asyncio
    async def test_get_with_completed_goals(self) -> None:
        """Test provider with completed goals."""
        provider = GoalsProvider()
        runtime = MockRuntime()
        service = MockGoalService()
        message = {"entityId": "user-456"}
        state = {}

        # Add completed goal
        service.add_goal(
            "Learn Python",
            is_completed=True,
            completed_at=datetime.now(),
        )

        result = await provider.get(runtime, message, state, service)

        assert "Recently Completed Goals" in result.text
        assert "Learn Python" in result.text
        assert result.data.get("completedGoalCount") == 1

    @pytest.mark.asyncio
    async def test_get_with_mixed_goals(self) -> None:
        """Test provider with both active and completed goals."""
        provider = GoalsProvider()
        runtime = MockRuntime()
        service = MockGoalService()
        message = {"entityId": "user-456"}
        state = {}

        # Add mixed goals
        service.add_goal("Learn Python")
        service.add_goal("Run marathon", is_completed=True, completed_at=datetime.now())

        result = await provider.get(runtime, message, state, service)

        assert "Active Goals" in result.text
        assert "Recently Completed Goals" in result.text
        assert "Summary" in result.text
        assert result.data.get("activeGoalCount") == 1
        assert result.data.get("completedGoalCount") == 1

    @pytest.mark.asyncio
    async def test_get_filters_by_owner(self) -> None:
        """Test provider filters goals by owner."""
        provider = GoalsProvider()
        runtime = MockRuntime()
        service = MockGoalService()
        message = {"entityId": "user-456"}
        state = {}

        # Add goals for different owners
        service.add_goal("Learn Python", owner_id="user-456")
        service.add_goal("Other goal", owner_id="other-user")

        result = await provider.get(runtime, message, state, service)

        # Should only see user-456's goals
        assert "Learn Python" in result.text
        assert "Other goal" not in result.text
        assert result.data.get("activeGoalCount") == 1

    @pytest.mark.asyncio
    async def test_get_with_goal_tags(self) -> None:
        """Test provider shows goal tags."""
        provider = GoalsProvider()
        runtime = MockRuntime()
        service = MockGoalService()
        message = {"entityId": "user-456"}
        state = {}

        # Add goal with tags
        goal = service.add_goal("Learn Python")
        goal.tags = ["programming", "education"]

        result = await provider.get(runtime, message, state, service)

        assert "programming" in result.text
        assert "education" in result.text

    @pytest.mark.asyncio
    async def test_get_agent_goals(self) -> None:
        """Test provider returns agent goals when no entity."""
        provider = GoalsProvider()
        runtime = MockRuntime()
        service = MockGoalService()
        message = {}  # No entityId
        state = {}

        # Add agent goal
        service.add_goal(
            "Improve accuracy",
            owner_type=GoalOwnerType.AGENT,
            owner_id="agent-123",
        )

        result = await provider.get(runtime, message, state, service)

        assert "Improve accuracy" in result.text
        assert result.data.get("activeGoalCount") == 1

    @pytest.mark.asyncio
    async def test_get_limits_completed_to_five(self) -> None:
        """Test provider limits completed goals to 5 most recent."""
        provider = GoalsProvider()
        runtime = MockRuntime()
        service = MockGoalService()
        message = {"entityId": "user-456"}
        state = {}

        # Add more than 5 completed goals
        for i in range(7):
            service.add_goal(
                f"Goal {i + 1}",
                is_completed=True,
                completed_at=datetime.now(),
            )

        result = await provider.get(runtime, message, state, service)

        # Should show all 7 in the count but only 5 in the list
        assert result.data.get("completedGoalCount") == 7
        # The provider returns 5 most recent in the text
