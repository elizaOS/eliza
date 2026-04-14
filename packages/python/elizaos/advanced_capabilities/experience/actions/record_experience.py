from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING
from uuid import uuid4

from elizaos.types import Action, ActionResult

if TYPE_CHECKING:
    from elizaos.types import (
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )

logger = logging.getLogger("elizaos.experience")


async def _validate_record_experience(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> bool:
    """Validate that the message is requesting to record an experience."""
    text = ""
    if hasattr(message, "content") and message.content:
        text_val = getattr(message.content, "text", None)
        if isinstance(text_val, str):
            text = text_val.lower()

    if not text:
        return False

    # Check for relevant keywords
    return "remember" in text or "record" in text or "experience" in text


async def _handle_record_experience(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult | None:
    """Record an experience from the current message context."""
    _ = options, callback, responses  # Unused parameters

    logger.info("Recording experience for message: %s", getattr(message, "id", "unknown"))

    # Create experience memory with context
    experience_id = str(uuid4())
    message_text = ""
    message_source = ""
    if hasattr(message, "content") and message.content:
        text_val = getattr(message.content, "text", None)
        if isinstance(text_val, str):
            message_text = text_val
        source_val = getattr(message.content, "source", None)
        if isinstance(source_val, str):
            message_source = source_val

    state_text = ""
    if state and hasattr(state, "text"):
        state_text = str(getattr(state, "text", ""))

    experience_memory = {
        "id": experience_id,
        "entity_id": str(getattr(message, "entity_id", "")),
        "agent_id": str(runtime.agent_id),
        "room_id": str(getattr(message, "room_id", "")),
        "content": {
            "text": message_text,
            "source": message_source,
            "type": "experience",
            "context": state_text,
        },
        "created_at": int(time.time() * 1000),
    }

    # Store in experiences table
    await runtime.create_memory(experience_memory, "experiences", True)
    logger.info("Experience recorded successfully")

    return ActionResult(
        success=True,
        text="Experience recorded.",
        data={"experienceMemoryId": experience_id},
    )


record_experience_action = Action(
    name="RECORD_EXPERIENCE",
    description="Records an experience or learning from the current conversation context for future reference",
    handler=_handle_record_experience,
    validate=_validate_record_experience,
    similes=["remember experience", "save learning", "record learning"],
    examples=[],
)
