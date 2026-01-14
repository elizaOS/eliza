import pytest

from elizaos.runtime import AgentRuntime
from elizaos.types import (
    Action,
    ActionParameter,
    ActionResult,
    Character,
    Content,
    Memory,
    as_uuid,
)


@pytest.mark.asyncio
async def test_process_actions_passes_validated_params_to_handler_options() -> None:
    character = Character(name="ParamAgent", bio="Test agent", system="Test")
    runtime = AgentRuntime(character=character, action_planning=False)

    received: list[str] = []

    async def validate(_rt: AgentRuntime, _msg: Memory, _state: object) -> bool:
        return True

    async def handler(
        _rt: AgentRuntime,
        _msg: Memory,
        _state: object,
        options: object,
        _callback: object,
        _responses: list[Memory] | None,
    ) -> ActionResult:
        params = getattr(options, "parameters", None)
        direction = params.get("direction") if isinstance(params, dict) else None
        received.append(str(direction))
        return ActionResult(success=True)

    action = Action(
        name="MOVE",
        description="Move the agent.",
        validate=validate,
        handler=handler,
        parameters=[
            ActionParameter(
                name="direction",
                description="Direction to move.",
                required=False,
                schema={"type": "string", "enum": ["north", "south"], "default": "north"},
            )
        ],
    )
    runtime.register_action(action)

    message = Memory(
        id=as_uuid("12345678-1234-1234-1234-123456789012"),
        entity_id=as_uuid("12345678-1234-1234-1234-123456789013"),
        room_id=as_uuid("12345678-1234-1234-1234-123456789014"),
        content=Content(text="tick"),
    )

    response = Memory(
        id=as_uuid("12345678-1234-1234-1234-123456789015"),
        entity_id=as_uuid("12345678-1234-1234-1234-123456789016"),
        room_id=message.room_id,
        content=Content(
            text="move",
            actions=["MOVE"],
            params={"MOVE": {"direction": "south"}},
        ),
    )

    await runtime.process_actions(message, [response], state=None, callback=None)

    assert received == ["south"]


@pytest.mark.asyncio
async def test_process_actions_skips_action_when_required_param_missing() -> None:
    character = Character(name="ParamAgent", bio="Test agent", system="Test")
    runtime = AgentRuntime(character=character, action_planning=False)

    executed = False
    received_errors: list[str] = []

    async def validate(_rt: AgentRuntime, _msg: Memory, _state: object) -> bool:
        return True

    async def handler(
        _rt: AgentRuntime,
        _msg: Memory,
        _state: object,
        options: object,
        _callback: object,
        _responses: list[Memory] | None,
    ) -> ActionResult:
        nonlocal executed
        executed = True
        errs = getattr(options, "parameter_errors", None)
        received_errors.extend(errs if isinstance(errs, list) else [])
        return ActionResult(success=True)

    action = Action(
        name="MOVE",
        description="Move the agent.",
        validate=validate,
        handler=handler,
        parameters=[
            ActionParameter(
                name="direction",
                description="Direction to move.",
                required=True,
                schema={"type": "string", "enum": ["north", "south"]},
            )
        ],
    )
    runtime.register_action(action)

    message = Memory(
        id=as_uuid("22345678-1234-1234-1234-123456789012"),
        entity_id=as_uuid("22345678-1234-1234-1234-123456789013"),
        room_id=as_uuid("22345678-1234-1234-1234-123456789014"),
        content=Content(text="tick"),
    )

    response = Memory(
        id=as_uuid("22345678-1234-1234-1234-123456789015"),
        entity_id=as_uuid("22345678-1234-1234-1234-123456789016"),
        room_id=message.room_id,
        content=Content(
            text="move",
            actions=["MOVE"],
        ),
    )

    await runtime.process_actions(message, [response], state=None, callback=None)

    assert executed is True
    assert any("Required parameter 'direction'" in e for e in received_errors)
