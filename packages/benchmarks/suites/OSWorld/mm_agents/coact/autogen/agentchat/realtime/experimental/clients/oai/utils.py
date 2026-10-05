# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import json
from typing import Any

from ...realtime_events import (
    AudioDelta,
    FunctionCall,
    InputAudioBufferDelta,
    RealtimeEvent,
    SessionCreated,
    SessionUpdated,
    SpeechStarted,
)

__all__ = ["parse_oai_message"]


def parse_oai_message(message: dict[str, Any]) -> RealtimeEvent:
    """Parse a message from the OpenAI Realtime API.

    Args:
        message (dict[str, Any]): The message to parse.

    Returns:
        RealtimeEvent: The parsed event.
    """
    if message.get("type") == "session.created":
        return SessionCreated(raw_message=message)
    elif message.get("type") == "session.updated":
        return SessionUpdated(raw_message=message)
    elif message.get("type") == "response.audio.delta":
        return AudioDelta(raw_message=message, delta=message["delta"], item_id=message["item_id"])
    elif message.get("type") == "input_audio_buffer.speech_started":
        return SpeechStarted(raw_message=message)
    elif message.get("type") == "input_audio_buffer.delta":
        return InputAudioBufferDelta(delta=message["delta"], item_id=None, raw_message=message)
    elif message.get("type") == "response.function_call_arguments.done":
        return FunctionCall(
            raw_message=message,
            call_id=message["call_id"],
            name=message["name"],
            arguments=json.loads(message["arguments"]),
        )
    else:
        return RealtimeEvent(raw_message=message)
