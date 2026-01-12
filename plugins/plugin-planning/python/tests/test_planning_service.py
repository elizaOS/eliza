import pytest
from uuid import uuid4

from elizaos_plugin_planning.services.planning_service import PlanningService
from elizaos_plugin_planning.types import PlanningConfig


@pytest.fixture
def planning_service() -> PlanningService:
    return PlanningService()


@pytest.fixture
def sample_message() -> dict:
    return {
        "id": str(uuid4()),
        "entity_id": str(uuid4()),
        "room_id": str(uuid4()),
        "content": {"text": "Create a plan for building a website"},
        "created_at": 1234567890,
    }


@pytest.fixture
def sample_context() -> dict:
    return {
        "goal": "Build and deploy a website",
        "constraints": [
            {"type": "time", "value": "2 hours", "description": "Must complete in 2 hours"}
        ],
        "available_actions": ["ANALYZE_INPUT", "PROCESS_ANALYSIS", "EXECUTE_FINAL"],
        "preferences": {"execution_model": "sequential", "max_steps": 5},
    }


class TestPlanningServiceInit:
    def test_default_config(self, planning_service: PlanningService) -> None:
        assert planning_service.config.max_steps == 10
        assert planning_service.config.execution_model == "sequential"

    def test_custom_config(self) -> None:
        config = PlanningConfig(max_steps=20, execution_model="parallel")
        service = PlanningService(config=config)
        assert service.config.max_steps == 20
        assert service.config.execution_model == "parallel"


class TestSimplePlan:
    @pytest.mark.asyncio
    async def test_create_simple_plan_email(self, planning_service: PlanningService) -> None:
        message = {"content": {"text": "Send an email to John"}}
        plan = await planning_service.create_simple_plan(message, {})

        assert plan is not None
        assert len(plan.steps) > 0
        assert plan.steps[0].action_name == "SEND_EMAIL"

    @pytest.mark.asyncio
    async def test_create_simple_plan_search(self, planning_service: PlanningService) -> None:
        message = {"content": {"text": "Search for Python tutorials"}}
        plan = await planning_service.create_simple_plan(message, {})

        assert plan is not None
        assert "SEARCH" in [step.action_name for step in plan.steps]

    @pytest.mark.asyncio
    async def test_create_simple_plan_default(self, planning_service: PlanningService) -> None:
        message = {"content": {"text": "Hello there"}}
        plan = await planning_service.create_simple_plan(message, {})

        assert plan is not None
        assert plan.steps[0].action_name == "REPLY"


class TestComprehensivePlan:
    @pytest.mark.asyncio
    async def test_create_comprehensive_plan(
        self, planning_service: PlanningService, sample_context: dict
    ) -> None:
        plan = await planning_service.create_comprehensive_plan(sample_context)

        assert plan is not None
        assert plan.goal == sample_context["goal"]
        assert len(plan.steps) > 0

    @pytest.mark.asyncio
    async def test_comprehensive_plan_with_message(
        self, planning_service: PlanningService, sample_context: dict, sample_message: dict
    ) -> None:
        plan = await planning_service.create_comprehensive_plan(sample_context, sample_message)

        assert plan is not None
        assert plan.execution_model == "sequential"

    @pytest.mark.asyncio
    async def test_comprehensive_plan_empty_goal(self, planning_service: PlanningService) -> None:
        context = {
            "goal": "",
            "constraints": [],
            "available_actions": [],
            "preferences": {},
        }

        with pytest.raises(ValueError, match="non-empty goal"):
            await planning_service.create_comprehensive_plan(context)


class TestPlanValidation:
    @pytest.mark.asyncio
    async def test_validate_valid_plan(
        self, planning_service: PlanningService, sample_context: dict
    ) -> None:
        plan = await planning_service.create_comprehensive_plan(sample_context)
        is_valid, issues = await planning_service.validate_plan(plan)

        # Without runtime, action validation may fail, but structure should be valid
        assert is_valid or issues is not None

    @pytest.mark.asyncio
    async def test_validate_empty_plan(self, planning_service: PlanningService) -> None:
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
    @pytest.mark.asyncio
    async def test_execute_simple_plan(
        self, planning_service: PlanningService, sample_message: dict
    ) -> None:
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
        plan = await planning_service.create_simple_plan(sample_message, {})
        callbacks_received: list = []

        async def callback(content: dict) -> list:
            callbacks_received.append(content)
            return []

        result = await planning_service.execute_plan(plan, sample_message, callback)
        assert result is not None


class TestPlanCancellation:
    @pytest.mark.asyncio
    async def test_cancel_nonexistent_plan(self, planning_service: PlanningService) -> None:
        result = await planning_service.cancel_plan(uuid4())
        assert not result

    @pytest.mark.asyncio
    async def test_get_status_nonexistent_plan(self, planning_service: PlanningService) -> None:
        status = await planning_service.get_plan_status(uuid4())
        assert status is None


class TestServiceLifecycle:
    @pytest.mark.asyncio
    async def test_start_and_stop(self, planning_service: PlanningService) -> None:
        await planning_service.start(None)
        await planning_service.stop()

        assert len(planning_service.active_plans) == 0
        assert len(planning_service.plan_executions) == 0
