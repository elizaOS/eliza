"""
Message service for elizaOS.

This module provides the message handling service that processes incoming messages
and generates responses using the agent's character, providers, and model handlers.
"""

from __future__ import annotations

import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Coroutine

from elizaos.types.memory import Memory
from elizaos.types.model import ModelType
from elizaos.types.primitives import UUID, Content, as_uuid
from elizaos.types.state import State

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

HandlerCallback = Callable[[Content], Coroutine[Any, Any, list[Memory]]]

@dataclass
class MessageProcessingResult:
    """Result of message processing."""

    did_respond: bool
    response_content: Content | None
    response_messages: list[Memory] = field(default_factory=list)
    state: State | None = None


class IMessageService(ABC):
    """Interface for message handling service."""

    @abstractmethod
    async def handle_message(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        callback: HandlerCallback | None = None,
    ) -> MessageProcessingResult:
        """Process an incoming message and generate a response."""
        ...


class DefaultMessageService(IMessageService):
    """
    Default implementation of the message service.

    This service handles the complete message processing pipeline:
    - Composes state from providers
    - Generates response using the model
    - Returns the result
    """

    async def handle_message(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        callback: HandlerCallback | None = None,
    ) -> MessageProcessingResult:
        """Process an incoming message and generate a response."""

        # Start run tracking
        run_id = runtime.start_run(message.room_id)
        start_time = time.time()

        try:
            # Check if shouldRespond evaluation is enabled
            # When disabled (ChatGPT mode), we always respond
            check_should_respond = runtime.is_check_should_respond_enabled()
            if not check_should_respond:
                runtime.logger.debug(
                    "check_should_respond disabled, always responding (ChatGPT mode)"
                )
            # Note: This implementation always responds, so check_should_respond=False
            # maintains the default behavior. When shouldRespond logic is added,
            # this check will bypass it when check_should_respond is False.

            # Save the incoming message to memory first
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

            # Create response content
            response_content = Content(text=str(response_text))

            # Create response memory
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

            elapsed = time.time() - start_time

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

    def _build_prompt(
        self, runtime: IAgentRuntime, message: Memory, state: State
    ) -> str:
        """Build the prompt for the model."""
        character = runtime.character
        user_text = message.content.text or ""

        # Include state text from providers if available
        context = state.text if state.text else ""

        prompt_parts = []

        if context:
            prompt_parts.append(context)

        prompt_parts.append(f"User: {user_text}")
        prompt_parts.append(f"{character.name}:")

        return "\n".join(prompt_parts)

