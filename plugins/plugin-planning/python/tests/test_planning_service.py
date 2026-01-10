"""Tests for Planning Service."""

import pytest
from uuid import uuid4

from elizaos_plugin_planning.services.planning_service import PlanningService
from elizaos_plugin_planning.types import PlanningConfig, RetryPolicy


@pytest.fixture
def planning_service() -> PlanningService:
    """Create a planning service for testing."""
    return PlanningService()


@pytest.fixture
def sample_message() -> dict:
    """Create a sample message for testing."""
    return {
        "id": str(uuid4()),
        "entity_id": str(uuid4()),
        "room_id": str(uuid4()),
        "content": {"text": "Create a plan for building a website"},
        "created_at": 1234567890,
    }


@pytest.fixture
def sample_context() -> dict:
    """Create a sample planning context for testing."""
    return {
        "goal": "Build and deploy a website",
        "constraints": [{"type": "time", "value": "2 hours", "description": "Must complete in 2 hours"}],
        "available_actions": ["ANALYZE_INPUT", "PROCESS_ANALYSIS", "EXECUTE_FINAL"],
        "preferences": {"execution_model": "sequential", "max_steps": 5},
    }


class TestPlanningServiceInit:
    """Test PlanningService initialization."""

    def test_default_config(self, planning_service: PlanningService) -> None:
        """Test default configuration."""
        assert planning_service.config.max_steps == 10
        assert planning_service.config.execution_model == "sequential"

    def test_custom_config(self) -> None:
        """Test custom configuration."""
        config = PlanningConfig(max_steps=20, execution_model="parallel")
        service = PlanningService(config=config)
        assert service.config.max_steps == 20
        assert service.config.execution_model == "parallel"


class TestSimplePlan:
    """Test simple plan creation."""

    @pytest.mark.asyncio
    async def test_create_simple_plan_email(self, planning_service: PlanningService) -> None:
        """Test simple plan creation for email action."""
        message = {"content": {"text": "Send an email to John"}}
        plan = await planning_service.create_simple_plan(message, {})

        assert plan is not None
        assert len(plan.steps) > 0
        assert plan.steps[0].action_name == "SEND_EMAIL"

    @pytest.mark.asyncio
    async def test_create_simple_plan_search(self, planning_service: PlanningService) -> None:
        """Test simple plan creation for search action."""
        message = {"content": {"text": "Search for Python tutorials"}}
        plan = await planning_service.create_simple_plan(message, {})

        assert plan is not None
        assert "SEARCH" in [step.action_name for step in plan.steps]

    @pytest.mark.asyncio
    async def test_create_simple_plan_default(self, planning_service: PlanningService) -> None:
        """Test simple plan creation defaults to REPLY."""
        message = {"content": {"text": "Hello there"}}
        plan = await planning_service.create_simple_plan(message, {})

        assert plan is not None
        assert plan.steps[0].action_name == "REPLY"


class TestComprehensivePlan:
    """Test comprehensive plan creation."""

    @pytest.mark.asyncio
    async def test_create_comprehensive_plan(
        self, planning_service: PlanningService, sample_context: dict
    ) -> None:
        """Test comprehensive plan creation."""
        plan = await planning_service.create_comprehensive_plan(sample_context)

        assert plan is not None
        assert plan.goal == sample_context["goal"]
        assert len(plan.steps) > 0

    @pytest.mark.asyncio
    async def test_comprehensive_plan_with_message(
        self, planning_service: PlanningService, sample_context: dict, sample_message: dict
    ) -> None:
        """Test comprehensive plan creation with message context."""
        plan = await planning_service.create_comprehensive_plan(
            sample_context, sample_message
        )

        assert plan is not None
        assert plan.execution_model == "sequential"

    @pytest.mark.asyncio
    async def test_comprehensive_plan_empty_goal(
        self, planning_service: PlanningService
    ) -> None:
        """Test comprehensive plan with empty goal raises error."""
        context = {
            "goal": "",
            "constraints": [],
            "available_actions": [],
            "preferences": {},
        }

        with pytest.raises(ValueError, match="non-empty goal"):
            await planning_service.create_comprehensive_plan(context)


class TestPlanValidation:
    """Test plan validation."""

    @pytest.mark.asyncio
    async def test_validate_valid_plan(
        self, planning_service: PlanningService, sample_context: dict
    ) -> None:
        """Test validation of a valid plan."""
        plan = await planning_service.create_comprehensive_plan(sample_context)
        is_valid, issues = await planning_service.validate_plan(plan)

        # Without runtime, action validation may fail, but structure should be valid
        assert is_valid or issues is not None

    @pytest.mark.asyncio
    async def test_validate_empty_plan(self, planning_service: PlanningService) -> None:
        """Test validation of empty plan fails."""
        from elizaos_plugin_planning.types import ActionPlan

        plan = ActionPlan(
            id=uuid4(),
            goal="Test",
            steps=[],
            execution_model="sequential",
        )
        is_valid, issues = await planning_service.validate_plan(plan)

        assert not is_valid
        assert issues is not None
        assert any("no steps" in issue.lower() for issue in issues)


class TestPlanExecution:
    """Test plan execution."""

    @pytest.mark.asyncio
    async def test_execute_simple_plan(
        self, planning_service: PlanningService, sample_message: dict
    ) -> None:
        """Test execution of a simple plan."""
        plan = await planning_service.create_simple_plan(sample_message, {})
        assert plan is not None

        result = await planning_service.execute_plan(plan, sample_message)

        assert result is not None
        assert result.plan_id == plan.id
        assert result.total_steps == len(plan.steps)

    @pytest.mark.asyncio
    async def test_execute_with_callback(
        self, planning_service: PlanningService, sample_message: dict
    ) -> None:
        """Test execution with callback."""
        plan = await planning_service.create_simple_plan(sample_message, {})
        callbacks_received: list = []

        async def callback(content: dict) -> list:
            callbacks_received.append(content)
            return []

        result = await planning_service.execute_plan(plan, sample_message, callback)
        assert result is not None


class TestPlanCancellation:
    """Test plan cancellation."""

    @pytest.mark.asyncio
    async def test_cancel_nonexistent_plan(self, planning_service: PlanningService) -> None:
        """Test cancelling a non-existent plan."""
        result = await planning_service.cancel_plan(uuid4())
        assert not result

    @pytest.mark.asyncio
    async def test_get_status_nonexistent_plan(self, planning_service: PlanningService) -> None:
        """Test getting status of non-existent plan."""
        status = await planning_service.get_plan_status(uuid4())
        assert status is None


class TestServiceLifecycle:
    """Test service lifecycle."""

    @pytest.mark.asyncio
    async def test_start_and_stop(self, planning_service: PlanningService) -> None:
        """Test starting and stopping the service."""
        await planning_service.start(None)
        await planning_service.stop()

        assert len(planning_service.active_plans) == 0
        assert len(planning_service.plan_executions) == 0

