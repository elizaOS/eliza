# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Literal

from pydantic import BaseModel


class RealtimeEvent(BaseModel):
    raw_message: dict[str, Any]


class SessionCreated(RealtimeEvent):
    type: Literal["session.created"] = "session.created"


class SessionUpdated(RealtimeEvent):
    type: Literal["session.updated"] = "session.updated"


class AudioDelta(RealtimeEvent):
    type: Literal["response.audio.delta"] = "response.audio.delta"
    delta: str
    item_id: Any


class InputAudioBufferDelta(RealtimeEvent):
    type: Literal["input_audio_buffer.delta"] = "input_audio_buffer.delta"
    delta: str
    item_id: Any


class SpeechStarted(RealtimeEvent):
    type: Literal["input_audio_buffer.speech_started"] = "input_audio_buffer.speech_started"


class FunctionCall(RealtimeEvent):
    type: Literal["response.function_call_arguments.done"] = "response.function_call_arguments.done"
    name: str
    arguments: dict[str, Any]
    call_id: str
