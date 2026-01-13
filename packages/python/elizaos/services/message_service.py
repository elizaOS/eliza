from __future__ import annotations

import time
import uuid
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Callable, Coroutine
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from elizaos.types.memory import Memory
from elizaos.types.model import ModelType
from elizaos.types.primitives import Content, as_uuid
from elizaos.types.state import State

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

HandlerCallback = Callable[[Content], Coroutine[Any, Any, list[Memory]]]
StreamChunkCallback = Callable[[str], Coroutine[Any, Any, None]]


@dataclass
class MessageProcessingResult:
    did_respond: bool
    response_content: Content | None
    response_messages: list[Memory] = field(default_factory=list)
    state: State | None = None


@dataclass
class StreamingMessageResult:
    """Result metadata for streaming message processing."""

    response_memory: Memory
    state: State | None = None


class IMessageService(ABC):
    @abstractmethod
    async def handle_message(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        callback: HandlerCallback | None = None,
    ) -> MessageProcessingResult: ...

    @abstractmethod
    def handle_message_stream(
        self,
        runtime: IAgentRuntime,
        message: Memory,
    ) -> AsyncIterator[str | StreamingMessageResult]:
        """
        Process a message and stream the response token by token.

        Yields:
            str: Text chunks as they are generated
            StreamingMessageResult: Final result with metadata (yielded last)
        """
        ...


class DefaultMessageService(IMessageService):
    async def handle_message(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        callback: HandlerCallback | None = None,
    ) -> MessageProcessingResult:
        _ = runtime.start_run(message.room_id)
        start_time = time.time()

        try:
            check_should_respond = runtime.is_check_should_respond_enabled()
            if not check_should_respond:
                runtime.logger.debug(
                    "check_should_respond disabled, always responding (ChatGPT mode)"
                )

            runtime.logger.debug("Saving incoming message to memory")
            if message.id:
                # Check if memory already exists
                existing_memory = await runtime.get_memory_by_id(message.id)
                if not existing_memory:
                    await runtime.create_memory(message, "messages")
            else:
                # Generate ID and save
                message.id = as_uuid(str(uuid.uuid4()))
                await runtime.create_memory(message, "messages")

            # Compose state from providers
            state = await runtime.compose_state(message)

            # Build the prompt
            prompt = self._build_prompt(runtime, message, state)

            # Generate response using the model
            response_text = await runtime.use_model(
                ModelType.TEXT_LARGE.value,
                {
                    "prompt": prompt,
                    "system": runtime.character.system,
                    "temperature": 0.7,
                },
            )

            response_content = Content(text=str(response_text))
            response_id = as_uuid(str(uuid.uuid4()))
            response_memory = Memory(
                id=response_id,
                entity_id=runtime.agent_id,
                agent_id=runtime.agent_id,
                room_id=message.room_id,
                content=response_content,
                created_at=int(time.time() * 1000),
            )

            # Save response memory
            runtime.logger.debug("Saving response to memory")
            await runtime.create_memory(response_memory, "messages")

            # Call the callback if provided
            if callback:
                await callback(response_content)

            _ = time.time() - start_time

            return MessageProcessingResult(
                did_respond=True,
                response_content=response_content,
                response_messages=[response_memory],
                state=state,
            )

        except Exception as e:
            runtime.logger.error(f"Error processing message: {e}")
            raise
        finally:
            runtime.end_run()

    def _build_prompt(self, runtime: IAgentRuntime, message: Memory, state: State) -> str:
        """Build the prompt for the model."""
        character = runtime.character
        user_text = message.content.text or ""
        context = state.text if state.text else ""

        prompt_parts = []

        if context:
            prompt_parts.append(context)

        prompt_parts.append(f"User: {user_text}")
        prompt_parts.append(f"{character.name}:")

        return "\n".join(prompt_parts)

    async def _handle_message_stream_impl(
        self,
        runtime: IAgentRuntime,
        message: Memory,
    ) -> AsyncIterator[str | StreamingMessageResult]:
        """Internal implementation of streaming message handling."""
        _ = runtime.start_run(message.room_id)

        try:
            check_should_respond = runtime.is_check_should_respond_enabled()
            if not check_should_respond:
                runtime.logger.debug(
                    "check_should_respond disabled, always responding (ChatGPT mode)"
                )

            runtime.logger.debug("Saving incoming message to memory")
            if message.id:
                existing_memory = await runtime.get_memory_by_id(message.id)
                if not existing_memory:
                    await runtime.create_memory(message, "messages")
            else:
                message.id = as_uuid(str(uuid.uuid4()))
                await runtime.create_memory(message, "messages")

            # Compose state from providers
            state = await runtime.compose_state(message)

            # Build the prompt
            prompt = self._build_prompt(runtime, message, state)

            # Collect full response while streaming
            full_response_parts: list[str] = []

            # Stream response using the streaming model
            async for chunk in runtime.use_model_stream(
                ModelType.TEXT_LARGE_STREAM.value,
                {
                    "prompt": prompt,
                    "system": runtime.character.system,
                    "temperature": 0.7,
                },
            ):
                full_response_parts.append(chunk)
                yield chunk

            # Build the complete response
            full_response = "".join(full_response_parts)
            response_content = Content(text=full_response)
            response_id = as_uuid(str(uuid.uuid4()))
            response_memory = Memory(
                id=response_id,
                entity_id=runtime.agent_id,
                agent_id=runtime.agent_id,
                room_id=message.room_id,
                content=response_content,
                created_at=int(time.time() * 1000),
            )

            # Save response memory
            runtime.logger.debug("Saving response to memory")
            await runtime.create_memory(response_memory, "messages")

            # Yield final result with metadata
            yield StreamingMessageResult(
                response_memory=response_memory,
                state=state,
            )

        except Exception as e:
            runtime.logger.error(f"Error processing streaming message: {e}")
            raise
        finally:
            runtime.end_run()

    def handle_message_stream(
        self,
        runtime: IAgentRuntime,
        message: Memory,
    ) -> AsyncIterator[str | StreamingMessageResult]:
        """
        Process a message and stream the response token by token.

        Yields:
            str: Text chunks as they are generated
            StreamingMessageResult: Final result with metadata (yielded last)
        """
        return self._handle_message_stream_impl(runtime, message)
