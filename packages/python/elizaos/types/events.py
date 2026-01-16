from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, TypeAlias

from elizaos.types.generated.eliza.v1 import events_pb2

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

EventType = events_pb2.EventType
PlatformPrefix = events_pb2.PlatformPrefix
EventPayload = events_pb2.EventPayload
WorldPayload = events_pb2.WorldPayload
EntityPayload = events_pb2.EntityPayload
MessagePayload = events_pb2.MessagePayload
ChannelClearedPayload = events_pb2.ChannelClearedPayload
InvokePayload = events_pb2.InvokePayload
RunEventPayload = events_pb2.RunEventPayload
ActionEventPayload = events_pb2.ActionEventPayload
EvaluatorEventPayload = events_pb2.EvaluatorEventPayload
ModelEventPayload = events_pb2.ModelEventPayload
EmbeddingGenerationPayload = events_pb2.EmbeddingGenerationPayload
ControlMessagePayload = events_pb2.ControlMessagePayload

EventPayloadMap: TypeAlias = dict[EventType, type]

EventHandler = Callable[[EventPayload, "IAgentRuntime"], Awaitable[None]]

__all__ = [
    "EventType",
    "PlatformPrefix",
    "EventPayload",
    "WorldPayload",
    "EntityPayload",
    "MessagePayload",
    "ChannelClearedPayload",
    "InvokePayload",
    "RunEventPayload",
    "ActionEventPayload",
    "EvaluatorEventPayload",
    "ModelEventPayload",
    "EmbeddingGenerationPayload",
    "ControlMessagePayload",
    "EventPayloadMap",
    "EventHandler",
]
