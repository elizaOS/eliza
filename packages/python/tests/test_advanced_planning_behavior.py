from __future__ import annotations

from uuid import uuid4

import pytest

from elizaos.advanced_planning.planning_service import ActionPlan, ActionStep
from elizaos.runtime import AgentRuntime
from elizaos.types.agent import Character
from elizaos.types.components import ActionDefinition, ActionResult
from elizaos.types.memory import Memory
from elizaos.types.model import ModelType
from elizaos.types.primitives import Content, as_uuid


@pytest.mark.asyncio
async def test_advanced_planning_provider_parses_model_output() -> None:
    character = Character(name="AdvPlanningProvider", bio="Test", advancedPlanning=True)
    runtime = AgentRuntime(character=character, plugins=[])

    async def small_model_handler(_rt: AgentRuntime, _params: dict[str, object]) -> object:
        return "\n".join(
            [
                "COMPLEXITY: medium",
                "PLANNING: sequential_planning",
                "CAPABILITIES: analysis, project_management",
                "STAKEHOLDERS: engineering",
                "CONSTRAINTS: time",
                "DEPENDENCIES: none",
                "CONFIDENCE: 0.9",
            ]
        )

    runtime.register_model(ModelType.TEXT_SMALL, small_model_handler, provider="test", priority=10)

    await runtime.initialize()
    provider = next((p for p in runtime.providers if p.name == "messageClassifier"), None)
    assert provider is not None

    msg = Memory(
        id=as_uuid("12345678-1234-1234-1234-123456789100"),
        entity_id=as_uuid("12345678-1234-1234-1234-123456789101"),
        room_id=as_uuid("12345678-1234-1234-1234-123456789102"),
        content=Content(text="Please plan a small project"),
    )
    state = await runtime.compose_state(msg)
    result = await provider.get(runtime, msg, state)
    assert result.data is not None
    assert result.data.get("planningRequired") is True


@pytest.mark.asyncio
async def test_advanced_planning_service_creates_simple_plan() -> None:
    character = Character(name="AdvPlanningSvc", bio="Test", advancedPlanning=True)
    runtime = AgentRuntime(character=character, plugins=[])
    await runtime.initialize()

    planning_service = runtime.get_service("planning")
    assert planning_service is not None

    msg = Memory(
        id=as_uuid("12345678-1234-1234-1234-123456789110"),
        entity_id=as_uuid("12345678-1234-1234-1234-123456789111"),
        room_id=as_uuid("12345678-1234-1234-1234-123456789112"),
        content=Content(text="email the team"),
    )
    plan = await planning_service.create_simple_plan(msg)
    assert plan is not None
    assert any(step.action_name == "SEND_EMAIL" for step in plan.steps)


@pytest.mark.asyncio
async def test_advanced_planning_service_creates_comprehensive_plan_and_executes() -> None:
    character = Character(name="AdvPlanningSvcExec", bio="Test", advancedPlanning=True)
    runtime = AgentRuntime(character=character, plugins=[])

    # Mock TEXT_LARGE planner output
    async def large_model_handler(_rt: AgentRuntime, _params: dict[str, object]) -> object:
        return "\n".join(
            [
                "<plan>",
                "<goal>Do thing</goal>",
                "<execution_model>sequential</execution_model>",
                "<steps>",
                "<step>",
                "<id>step_1</id>",
                "<action>REPLY</action>",
                '<parameters>{"text":"ok"}</parameters>',
                "<dependencies>[]</dependencies>",
                "</step>",
                "</steps>",
                "<estimated_duration>1000</estimated_duration>",
                "</plan>",
            ]
        )

    runtime.register_model(ModelType.TEXT_LARGE, large_model_handler, provider="test", priority=10)

    await runtime.initialize()
    planning_service = runtime.get_service("planning")
    assert planning_service is not None

    plan = await planning_service.create_comprehensive_plan(
        {
            "goal": "Do thing",
            "constraints": [],
            "availableActions": ["REPLY"],
            "preferences": {"executionModel": "sequential", "maxSteps": 3},
        }
    )
    assert plan.total_steps >= 1
    msg = Memory(
        id=as_uuid("12345678-1234-1234-1234-123456789120"),
        entity_id=as_uuid("12345678-1234-1234-1234-123456789121"),
        room_id=as_uuid("12345678-1234-1234-1234-123456789122"),
        content=Content(text="hi"),
    )
    state = await runtime.compose_state(msg)
    result = await planning_service.execute_plan(plan, msg, state=state, callback=None)
    assert result.total_steps >= 1


@pytest.mark.asyncio
async def test_advanced_planning_dag_executes_in_dependency_order() -> None:
    character = Character(name="AdvPlanningDag", bio="Test", advancedPlanning=True)
    runtime = AgentRuntime(character=character, plugins=[])
    execution_order: list[str] = []

    async def handler_a(_rt, _msg, _state, _options, _callback, _responses):
        execution_order.append("STEP_A")
        return ActionResult(success=True)

    async def handler_b(_rt, _msg, _state, _options, _callback, _responses):
        execution_order.append("STEP_B")
        return ActionResult(success=True)

    async def handler_c(_rt, _msg, _state, _options, _callback, _responses):
        execution_order.append("STEP_C")
        return ActionResult(success=True)

    runtime.register_action(
        ActionDefinition(
            name="STEP_A",
            description="Step A",
            handler=handler_a,
            validate=lambda *_: True,
        )
    )
    runtime.register_action(
        ActionDefinition(
            name="STEP_B",
            description="Step B",
            handler=handler_b,
            validate=lambda *_: True,
        )
    )
    runtime.register_action(
        ActionDefinition(
            name="STEP_C",
            description="Step C",
            handler=handler_c,
            validate=lambda *_: True,
        )
    )

    await runtime.initialize()
    planning_service = runtime.get_service("planning")
    assert planning_service is not None

    step_a = uuid4()
    step_b = uuid4()
    step_c = uuid4()
    plan = ActionPlan(
        id=uuid4(),
        goal="Run DAG",
        thought="Run DAG",
        total_steps=3,
        current_step=0,
        steps=[
            ActionStep(id=step_a, action_name="STEP_A", parameters={}, dependencies=[]),
            ActionStep(id=step_b, action_name="STEP_B", parameters={}, dependencies=[step_a]),
            ActionStep(id=step_c, action_name="STEP_C", parameters={}, dependencies=[step_b]),
        ],
        execution_model="dag",
    )

    msg = Memory(
        id=as_uuid("12345678-1234-1234-1234-123456789130"),
        entity_id=as_uuid("12345678-1234-1234-1234-123456789131"),
        room_id=as_uuid("12345678-1234-1234-1234-123456789132"),
        content=Content(text="run"),
    )
    state = await runtime.compose_state(msg)
    await planning_service.execute_plan(plan, msg, state=state, callback=None)

    assert execution_order == ["STEP_A", "STEP_B", "STEP_C"]
