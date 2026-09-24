# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from collections.abc import AsyncGenerator
from logging import Logger
from typing import Any, AsyncContextManager, Callable, Literal, Optional, Protocol, TypeVar, Union, runtime_checkable

from asyncer import create_task_group

from .....doc_utils import export_module
from .....llm_config import LLMConfig
from ..realtime_events import InputAudioBufferDelta, RealtimeEvent

__all__ = ["RealtimeClientProtocol", "Role", "get_client", "register_realtime_client"]

# define role literal type for typing
Role = Literal["user", "assistant", "system"]


@runtime_checkable
@export_module("autogen.agentchat.realtime.experimental.clients")
class RealtimeClientProtocol(Protocol):
    async def send_function_result(self, call_id: str, result: str) -> None:
        """Send the result of a function call to a Realtime API.

        Args:
            call_id (str): The ID of the function call.
            result (str): The result of the function call.
        """
        ...

    async def send_text(self, *, role: Role, text: str) -> None:
        """Send a text message to a Realtime API.

        Args:
            role (str): The role of the message.
            text (str): The text of the message.
        """
        ...

    async def send_audio(self, audio: str) -> None:
        """Send audio to a Realtime API.

        Args:
            audio (str): The audio to send.
        """
        ...

    async def truncate_audio(self, audio_end_ms: int, content_index: int, item_id: str) -> None:
        """Truncate audio in a Realtime API.

        Args:
            audio_end_ms (int): The end of the audio to truncate.
            content_index (int): The index of the content to truncate.
            item_id (str): The ID of the item to truncate.
        """
        ...

    async def session_update(self, session_options: dict[str, Any]) -> None:
        """Send a session update to a Realtime API.

        Args:
            session_options (dict[str, Any]): The session options to update.
        """
        ...

    def connect(self) -> AsyncContextManager[None]: ...

    def read_events(self) -> AsyncGenerator[RealtimeEvent, None]:
        """Read events from a Realtime Client."""
        ...

    async def _read_from_connection(self) -> AsyncGenerator[RealtimeEvent, None]:
        """Read events from a Realtime connection."""
        ...

    def _parse_message(self, message: dict[str, Any]) -> list[RealtimeEvent]:
        """Parse a message from a Realtime API.

        Args:
            message (dict[str, Any]): The message to parse.

        Returns:
            list[RealtimeEvent]: The parsed events.
        """
        ...

    @classmethod
    def get_factory(
        cls, llm_config: Union[LLMConfig, dict[str, Any]], logger: Logger, **kwargs: Any
    ) -> Optional[Callable[[], "RealtimeClientProtocol"]]:
        """Create a Realtime API client.

        Args:
            llm_config: The config for the client.
            logger: The logger to use for logging events.
            **kwargs: Additional arguments.

        Returns:
            RealtimeClientProtocol: The Realtime API client is returned if the model matches the pattern
        """
        ...


class RealtimeClientBase:
    def __init__(self):
        self._eventQueue = asyncio.Queue()

    async def add_event(self, event: Optional[RealtimeEvent]):
        await self._eventQueue.put(event)

    async def get_event(self) -> Optional[RealtimeEvent]:
        return await self._eventQueue.get()

    async def _read_from_connection_task(self):
        async for event in self._read_from_connection():
            await self.add_event(event)
        await self.add_event(None)

    async def _read_events(self) -> AsyncGenerator[RealtimeEvent, None]:
        """Read events from a Realtime Client."""
        async with create_task_group() as tg:
            tg.start_soon(self._read_from_connection_task)
            while True:
                try:
                    event = await self._eventQueue.get()
                    if event is not None:
                        yield event
                    else:
                        break
                except Exception:
                    break

    async def queue_input_audio_buffer_delta(self, audio: str) -> None:
        """queue InputAudioBufferDelta.

        Args:
            audio (str): The audio.
        """
        await self.add_event(InputAudioBufferDelta(delta=audio, item_id=None, raw_message=dict()))


_realtime_client_classes: dict[str, type[RealtimeClientProtocol]] = {}

T = TypeVar("T", bound=RealtimeClientProtocol)


def register_realtime_client() -> Callable[[type[T]], type[T]]:
    """Register a Realtime API client.

    Returns:
        Callable[[type[T]], type[T]]: The decorator to register the Realtime API client
    """

    def decorator(client_cls: type[T]) -> type[T]:
        """Register a Realtime API client.

        Args:
            client_cls: The client to register.
        """
        global _realtime_client_classes
        fqn = f"{client_cls.__module__}.{client_cls.__name__}"
        _realtime_client_classes[fqn] = client_cls

        return client_cls

    return decorator


@export_module("autogen.agentchat.realtime.experimental.clients")
def get_client(llm_config: Union[LLMConfig, dict[str, Any]], logger: Logger, **kwargs: Any) -> "RealtimeClientProtocol":
    """Get a registered Realtime API client.

    Args:
        llm_config: The config for the client.
        logger: The logger to use for logging events.
        **kwargs: Additional arguments.

    Returns:
        RealtimeClientProtocol: The Realtime API client.
    """
    global _realtime_client_classes
    for _, client_cls in _realtime_client_classes.items():
        factory = client_cls.get_factory(llm_config=llm_config, logger=logger, **kwargs)
        if factory:
            return factory()

    raise ValueError("Realtime API client not found.")
