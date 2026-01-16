from __future__ import annotations

import pytest

from elizaos.runtime import AgentRuntime
from elizaos.types.agent import Character
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
