import pytest

from elizaos.action_docs import with_canonical_action_docs
from elizaos.bootstrap.actions import send_message_action
from elizaos.runtime import AgentRuntime
from elizaos.types import Character, Content, Memory, as_uuid


@pytest.mark.asyncio
async def test_actions_provider_includes_examples_and_parameter_examples() -> None:
    runtime = AgentRuntime(
        character=Character(name="DocsTest", bio="docs test", system="test"),
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
    assert "examples:" in text
