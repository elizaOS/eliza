import asyncio
import time

import pytest

from elizaos.runtime import AgentRuntime
from elizaos.services.message_service import (
    DefaultMessageService,
    MessageProcessingOptions,
)
from elizaos.types import Action, ActionResult, Character, Content, HandlerOptions, Memory, State
from elizaos.types.primitives import ChannelType, as_uuid


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

    result = await service.handle_message(
        runtime,
        Memory(
            entity_id=as_uuid("12345678-1234-1234-1234-123456789011"),
            room_id=as_uuid("12345678-1234-1234-1234-123456789012"),
            content=Content(text="TestAgent, stop", channel_type=ChannelType.GROUP.value),
            created_at=int(time.time() * 1000),
        ),
        callback,
    )

    assert result.did_respond is False
    assert len(callback_payloads) == 1
    assert list(callback_payloads[0].actions) == ["STOP"]


@pytest.mark.asyncio
async def test_group_chatter_still_uses_should_respond_classifier(character: Character) -> None:
    runtime = AgentRuntime(character=character, check_should_respond=True)
    small_calls = 0

    async def small_model(_runtime: AgentRuntime, _params: dict[str, object]) -> str:
        nonlocal small_calls
        small_calls += 1
        return "<response><action>IGNORE</action></response>"

    async def large_model(_runtime: AgentRuntime, _params: dict[str, object]) -> str:
        raise AssertionError("TEXT_LARGE should not run for unaddressed group chatter")

    runtime.register_model("TEXT_SMALL", small_model, provider="test")
    runtime.register_model("TEXT_LARGE", large_model, provider="test")

    service = DefaultMessageService()
    callback_payloads: list[Content] = []

    async def callback(content: Content) -> list[Memory]:
        callback_payloads.append(content)
        return []

    message = Memory(
        entity_id=as_uuid("12345678-1234-1234-1234-123456789011"),
        room_id=as_uuid("12345678-1234-1234-1234-123456789012"),
        content=Content(text="you gotta shut up", channel_type=ChannelType.GROUP.value),
        created_at=int(time.time() * 1000),
    )

    result = await service.handle_message(runtime, message, callback)

    assert result.did_respond is False
    assert small_calls == 1
    assert len(callback_payloads) == 1
    assert list(callback_payloads[0].actions) == ["IGNORE"]


@pytest.mark.asyncio
async def test_plain_name_mention_still_uses_should_respond_classifier(
    character: Character,
) -> None:
    runtime = AgentRuntime(character=character, check_should_respond=True)
    small_calls = 0

    async def small_model(_runtime: AgentRuntime, _params: dict[str, object]) -> str:
        nonlocal small_calls
        small_calls += 1
        return "<response><action>IGNORE</action></response>"

    async def large_model(_runtime: AgentRuntime, _params: dict[str, object]) -> str:
        raise AssertionError("TEXT_LARGE should not run after shouldRespond IGNORE")

    runtime.register_model("TEXT_SMALL", small_model, provider="test")
    runtime.register_model("TEXT_LARGE", large_model, provider="test")

    service = DefaultMessageService()
    result = await service.handle_message(
        runtime,
        Memory(
            entity_id=as_uuid("12345678-1234-1234-1234-123456789011"),
            room_id=as_uuid("12345678-1234-1234-1234-123456789012"),
            content=Content(text="hey TestAgent", channel_type=ChannelType.GROUP.value),
            created_at=int(time.time() * 1000),
        ),
        None,
    )

    assert result.did_respond is False
    assert small_calls == 1


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


@pytest.mark.asyncio
async def test_keep_existing_responses_keeps_both_replies(character: Character) -> None:
    runtime = AgentRuntime(character=character, check_should_respond=False)
    call_count = 0

    async def large_model(_runtime: AgentRuntime, _params: dict[str, object]) -> str:
        nonlocal call_count
        call_count += 1
        call_number = call_count
        await asyncio.sleep(0.01 if call_number == 1 else 0.025)
        return (
            "<response>"
            f"<thought>reply-{call_number}</thought>"
            "<actions>REPLY</actions>"
            "<providers></providers>"
            f"<text>{'First reply' if call_number == 1 else 'Second reply'}</text>"
            "</response>"
        )

    runtime.register_model("TEXT_LARGE", large_model, provider="test")

    service = DefaultMessageService()
    first_callback_payloads: list[Content] = []
    second_callback_payloads: list[Content] = []

    async def first_callback(content: Content) -> list[Memory]:
        first_callback_payloads.append(content)
        return []

    async def second_callback(content: Content) -> list[Memory]:
        second_callback_payloads.append(content)
        return []

    first_result, second_result = await asyncio.gather(
        service.handle_message(
            runtime,
            _message("first question"),
            first_callback,
            MessageProcessingOptions(keep_existing_responses=True),
        ),
        service.handle_message(
            runtime,
            _message("second question"),
            second_callback,
            MessageProcessingOptions(keep_existing_responses=True),
        ),
    )

    assert first_result.did_respond is True
    assert first_result.response_content is not None
    assert first_result.response_content.text == "First reply"
    assert second_result.did_respond is True
    assert second_result.response_content is not None
    assert second_result.response_content.text == "Second reply"
    assert [content.text for content in first_callback_payloads] == ["First reply"]
    assert [content.text for content in second_callback_payloads] == ["Second reply"]


@pytest.mark.asyncio
async def test_superseded_reply_is_discarded_by_default(character: Character) -> None:
    runtime = AgentRuntime(character=character, check_should_respond=False)
    call_count = 0

    async def large_model(_runtime: AgentRuntime, _params: dict[str, object]) -> str:
        nonlocal call_count
        call_count += 1
        call_number = call_count
        await asyncio.sleep(0.01 if call_number == 1 else 0.025)
        return (
            "<response>"
            f"<thought>reply-{call_number}</thought>"
            "<actions>REPLY</actions>"
            "<providers></providers>"
            f"<text>{'Discard me' if call_number == 1 else 'Keep me'}</text>"
            "</response>"
        )

    runtime.register_model("TEXT_LARGE", large_model, provider="test")

    service = DefaultMessageService()
    first_callback_payloads: list[Content] = []
    second_callback_payloads: list[Content] = []

    async def first_callback(content: Content) -> list[Memory]:
        first_callback_payloads.append(content)
        return []

    async def second_callback(content: Content) -> list[Memory]:
        second_callback_payloads.append(content)
        return []

    first_result, second_result = await asyncio.gather(
        service.handle_message(runtime, _message("older question"), first_callback),
        service.handle_message(runtime, _message("newer question"), second_callback),
    )

    assert first_result.did_respond is False
    assert first_result.response_content is None
    assert second_result.did_respond is True
    assert second_result.response_content is not None
    assert second_result.response_content.text == "Keep me"
    assert first_callback_payloads == []
    assert [content.text for content in second_callback_payloads] == ["Keep me"]
