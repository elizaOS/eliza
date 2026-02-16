import pytest

from elizaos.action_docs import with_canonical_action_docs
from elizaos.bootstrap.actions import send_message_action
from elizaos.runtime import AgentRuntime
from elizaos.types import Action, Character, Content, Memory, as_uuid


async def _noop_handler(
    runtime: AgentRuntime,
    message: Memory,
    state: object | None = None,
    options: object | None = None,
    callback: object | None = None,
    responses: object | None = None,
) -> None:
    return None


async def _always_valid(
    runtime: AgentRuntime,
    message: Memory,
    state: object | None = None,
) -> bool:
    return True


@pytest.mark.asyncio
async def test_actions_provider_includes_examples_and_parameter_examples() -> None:
    runtime = AgentRuntime(
        character=Character(name="DocsTest", bio=["docs test"], system="test"),
        log_level="ERROR",
    )
    await runtime.initialize()

    # Bootstrap initializes with basic actions only; register an extended action to
    # verify parameter example formatting end-to-end.
    runtime.register_action(with_canonical_action_docs(send_message_action))

    # Find the ACTIONS provider
    actions_provider = next(p for p in runtime.providers if p.name == "ACTIONS")

    message = Memory(
        id=as_uuid("32345678-1234-1234-1234-123456789012"),
        entity_id=as_uuid("32345678-1234-1234-1234-123456789013"),
        room_id=as_uuid("32345678-1234-1234-1234-123456789014"),
        content=Content(text="hello"),
    )

    state = await runtime.compose_state(message)
    result = await actions_provider.get(runtime, message, state)

    text = result.text or ""
    assert "# Available Actions" in text
    assert "# Action Examples" in text
    # Canonical docs include examples for SEND_MESSAGE parameters
    assert "SEND_MESSAGE" in text
    assert "# Action Call Examples" in text


@pytest.mark.asyncio
async def test_actions_provider_does_not_trim_available_actions_to_top_10() -> None:
    runtime = AgentRuntime(
        character=Character(name="NoTrimTest", bio=["no trim test"], system="test"),
        log_level="ERROR",
    )
    await runtime.initialize()

    custom_action_names: list[str] = []
    for index in range(12):
        action_name = f"CUSTOM_ACTION_{index:02d}"
        custom_action_names.append(action_name)
        runtime.register_action(
            Action(
                name=action_name,
                description=f"Custom action {index}",
                handler=_noop_handler,
                validate=_always_valid,
            )
        )

    actions_provider = next(p for p in runtime.providers if p.name == "ACTIONS")

    message = Memory(
        id=as_uuid("42345678-1234-1234-1234-123456789012"),
        entity_id=as_uuid("42345678-1234-1234-1234-123456789013"),
        room_id=as_uuid("42345678-1234-1234-1234-123456789014"),
        content=Content(text="show me every action"),
    )

    state = await runtime.compose_state(message)
    result = await actions_provider.get(runtime, message, state)

    text = result.text or ""
    for action_name in custom_action_names:
        assert action_name in text
