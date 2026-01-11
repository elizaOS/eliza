"""Tests for Goals types."""

from datetime import datetime

from elizaos_plugin_goals.types import (
    ConfirmationResult,
    CreateGoalParams,
    Goal,
    GoalFilters,
    GoalOwnerType,
    GoalSelectionResult,
    GoalStatus,
    SimilarityCheckResult,
    UpdateGoalParams,
)


class TestGoalStatus:
    """Tests for GoalStatus."""

    def test_status_values(self) -> None:
        """Test status enum values."""
        assert GoalStatus.PENDING == "pending"
        assert GoalStatus.IN_PROGRESS == "in_progress"
        assert GoalStatus.COMPLETED == "completed"
        assert GoalStatus.CANCELLED == "cancelled"


class TestGoalOwnerType:
    """Tests for GoalOwnerType."""

    def test_owner_type_values(self) -> None:
        """Test owner type enum values."""
        assert GoalOwnerType.AGENT == "agent"
        assert GoalOwnerType.ENTITY == "entity"


class TestGoal:
    """Tests for Goal."""

    def test_goal_creation(self) -> None:
        """Test goal creation with all fields."""
        now = datetime.now()
        goal = Goal(
            id="goal-123",
            agent_id="agent-456",
            owner_type=GoalOwnerType.ENTITY,
            owner_id="user-789",
            name="Learn Python",
            description="Become proficient in Python programming",
            is_completed=False,
            created_at=now,
            updated_at=now,
            tags=["programming", "learning"],
        )

        assert goal.id == "goal-123"
        assert goal.name == "Learn Python"
        assert goal.owner_type == GoalOwnerType.ENTITY
        assert len(goal.tags) == 2

    def test_goal_minimal(self) -> None:
        """Test goal with minimal fields."""
        now = datetime.now()
        goal = Goal(
            id="goal-123",
            agent_id="agent-456",
            owner_type=GoalOwnerType.AGENT,
            owner_id="agent-456",
            name="Simple Goal",
            created_at=now,
            updated_at=now,
        )

        assert goal.description is None
        assert not goal.is_completed
        assert goal.tags == []


class TestCreateGoalParams:
    """Tests for CreateGoalParams."""

    def test_create_params(self) -> None:
        """Test creation parameters."""
        params = CreateGoalParams(
            agent_id="agent-123",
            owner_type=GoalOwnerType.ENTITY,
            owner_id="user-456",
            name="New Goal",
            description="Goal description",
            tags=["tag1", "tag2"],
        )

        assert params.name == "New Goal"
        assert params.tags == ["tag1", "tag2"]


class TestUpdateGoalParams:
    """Tests for UpdateGoalParams."""

    def test_update_params(self) -> None:
        """Test update parameters."""
        params = UpdateGoalParams(
            name="Updated Name",
            is_completed=True,
        )

        assert params.name == "Updated Name"
        assert params.is_completed is True
        assert params.description is None


class TestGoalFilters:
    """Tests for GoalFilters."""

    def test_filters(self) -> None:
        """Test filter creation."""
        filters = GoalFilters(
            owner_type=GoalOwnerType.ENTITY,
            is_completed=False,
            tags=["important"],
        )

        assert filters.owner_type == GoalOwnerType.ENTITY
        assert not filters.is_completed
        assert filters.tags == ["important"]


class TestSimilarityCheckResult:
    """Tests for SimilarityCheckResult."""

    def test_similar_found(self) -> None:
        """Test when similar goal is found."""
        result = SimilarityCheckResult(
            has_similar=True,
            similar_goal_name="Existing Goal",
            confidence=85,
        )

        assert result.has_similar
        assert result.similar_goal_name == "Existing Goal"
        assert result.confidence == 85

    def test_no_similar(self) -> None:
        """Test when no similar goal is found."""
        result = SimilarityCheckResult(has_similar=False)

        assert not result.has_similar
        assert result.similar_goal_name is None
        assert result.confidence == 0


class TestGoalSelectionResult:
    """Tests for GoalSelectionResult."""

    def test_goal_found(self) -> None:
        """Test when goal is found."""
        result = GoalSelectionResult(
            goal_id="goal-123",
            goal_name="My Goal",
            is_found=True,
        )

        assert result.is_found
        assert result.goal_id == "goal-123"

    def test_goal_not_found(self) -> None:
        """Test when goal is not found."""
        result = GoalSelectionResult(is_found=False)

        assert not result.is_found
        assert result.goal_id is None


class TestConfirmationResult:
    """Tests for ConfirmationResult."""

    def test_confirmed(self) -> None:
        """Test confirmation result."""
        result = ConfirmationResult(
            is_confirmation=True,
            should_proceed=True,
            modifications=None,
        )

        assert result.is_confirmation
        assert result.should_proceed

    def test_rejected(self) -> None:
        """Test rejection result."""
        result = ConfirmationResult(
            is_confirmation=True,
            should_proceed=False,
        )

        assert result.is_confirmation
        assert not result.should_proceed
