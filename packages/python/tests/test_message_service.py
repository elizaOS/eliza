import time

import pytest

from elizaos.runtime import AgentRuntime
from elizaos.services.message_service import DefaultMessageService
from elizaos.types import Action, ActionResult, Character, Content, HandlerOptions, Memory, State
from elizaos.types.primitives import as_uuid


def _message(text: str) -> Memory:
    return Memory(
        entity_id=as_uuid("12345678-1234-1234-1234-123456789011"),
        room_id=as_uuid("12345678-1234-1234-1234-123456789012"),
        content=Content(text=text),
        created_at=int(time.time() * 1000),
    )


@pytest.fixture
def character() -> Character:
    return Character(
        name="TestAgent",
        bio=["Test agent"],
        system="You are a helpful test agent.",
    )


@pytest.mark.asyncio
async def test_should_respond_stop_short_circuits(character: Character) -> None:
    runtime = AgentRuntime(character=character, check_should_respond=True)

    async def small_model(_runtime: AgentRuntime, _params: dict[str, object]) -> str:
        return "<response><action>STOP</action></response>"

    async def large_model(_runtime: AgentRuntime, _params: dict[str, object]) -> str:
        raise AssertionError("TEXT_LARGE should not be called after shouldRespond STOP")

    runtime.register_model("TEXT_SMALL", small_model, provider="test")
    runtime.register_model("TEXT_LARGE", large_model, provider="test")

    service = DefaultMessageService()
    callback_payloads: list[Content] = []

    async def callback(content: Content) -> list[Memory]:
        callback_payloads.append(content)
        return []

    result = await service.handle_message(runtime, _message("stop"), callback)

    assert result.did_respond is False
    assert len(callback_payloads) == 1
    assert list(callback_payloads[0].actions) == ["STOP"]


@pytest.mark.asyncio
async def test_continues_after_action_results(character: Character) -> None:
    runtime = AgentRuntime(character=character, check_should_respond=False)
    call_count = 0

    async def large_model(_runtime: AgentRuntime, _params: dict[str, object]) -> str:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return (
                "<response>"
                "<thought>Run the tool first.</thought>"
                "<actions>TEST_ACTION</actions>"
                "<providers></providers>"
                "<text></text>"
                "</response>"
            )
        return (
            "<response>"
            "<thought>Task is complete.</thought>"
            "<actions>REPLY</actions>"
            "<providers></providers>"
            "<text>Final answer from continuation.</text>"
            "</response>"
        )

    async def validate(_runtime: AgentRuntime, _message: Memory, _state: State | None) -> bool:
        return True

    async def handler(
        _runtime: AgentRuntime,
        _message: Memory,
        _state: State | None,
        _options: HandlerOptions | None,
        _callback,
        _responses: list[Memory] | None,
    ) -> ActionResult | None:
        return ActionResult(success=True, text="tool output")

    runtime.register_model("TEXT_LARGE", large_model, provider="test")
    runtime.register_action(
        Action(
            name="TEST_ACTION",
            description="A test action",
            validate=validate,
            handler=handler,
        )
    )

    service = DefaultMessageService()
    callback_payloads: list[Content] = []

    async def callback(content: Content) -> list[Memory]:
        callback_payloads.append(content)
        return []

    result = await service.handle_message(runtime, _message("continue"), callback)

    assert call_count == 2
    assert result.did_respond is True
    assert result.response_content is not None
    assert result.response_content.text == "Final answer from continuation."
    assert callback_payloads[-1].text == "Final answer from continuation."
