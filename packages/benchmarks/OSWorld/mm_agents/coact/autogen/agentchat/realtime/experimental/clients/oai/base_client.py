# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from logging import Logger, getLogger
from typing import TYPE_CHECKING, Any, Callable, Optional, Union

from ......doc_utils import export_module
from ......import_utils import optional_import_block, require_optional_import
from ......llm_config import LLMConfig
from ...realtime_events import RealtimeEvent
from ..realtime_client import RealtimeClientBase, Role, register_realtime_client
from .utils import parse_oai_message

with optional_import_block():
    from openai import DEFAULT_MAX_RETRIES, NOT_GIVEN, AsyncOpenAI
    from openai.resources.beta.realtime.realtime import AsyncRealtimeConnection


if TYPE_CHECKING:
    from ..realtime_client import RealtimeClientProtocol

__all__ = ["OpenAIRealtimeClient"]

global_logger = getLogger(__name__)


@register_realtime_client()
@require_optional_import("openai>=1.66.2", "openai-realtime", except_for=["get_factory", "__init__"])
@export_module("autogen.agentchat.realtime.experimental.clients")
class OpenAIRealtimeClient(RealtimeClientBase):
    """(Experimental) Client for OpenAI Realtime API."""

    def __init__(
        self,
        *,
        llm_config: Union[LLMConfig, dict[str, Any]],
        logger: Optional[Logger] = None,
    ) -> None:
        """(Experimental) Client for OpenAI Realtime API.

        Args:
            llm_config: The config for the client.
            logger: the logger to use for logging events
        """
        super().__init__()
        self._llm_config = llm_config
        self._logger = logger

        self._connection: Optional["AsyncRealtimeConnection"] = None

        self.config = llm_config["config_list"][0]
        # model is passed to self._client.beta.realtime.connect function later
        self._model: str = self.config["model"]
        self._voice: str = self.config.get("voice", "alloy")
        self._temperature: float = llm_config.get("temperature", 0.8)  # type: ignore[union-attr]

        self._client: Optional["AsyncOpenAI"] = None

    @property
    def logger(self) -> Logger:
        """Get the logger for the OpenAI Realtime API."""
        return self._logger or global_logger

    @property
    def connection(self) -> "AsyncRealtimeConnection":
        """Get the OpenAI WebSocket connection."""
        if self._connection is None:
            raise RuntimeError("OpenAI WebSocket is not initialized")
        return self._connection

    async def send_function_result(self, call_id: str, result: str) -> None:
        """Send the result of a function call to the OpenAI Realtime API.

        Args:
            call_id (str): The ID of the function call.
            result (str): The result of the function call.
        """
        await self.connection.conversation.item.create(
            item={
                "type": "function_call_output",
                "call_id": call_id,
                "output": result,
            },
        )

        await self.connection.response.create()

    async def send_text(self, *, role: Role, text: str) -> None:
        """Send a text message to the OpenAI Realtime API.

        Args:
            role (str): The role of the message.
            text (str): The text of the message.
        """
        await self.connection.response.cancel()
        await self.connection.conversation.item.create(
            item={"type": "message", "role": role, "content": [{"type": "input_text", "text": text}]}
        )
        await self.connection.response.create()

    async def send_audio(self, audio: str) -> None:
        """Send audio to the OpenAI Realtime API.

        Args:
            audio (str): The audio to send.
        """
        await self.queue_input_audio_buffer_delta(audio)
        await self.connection.input_audio_buffer.append(audio=audio)

    async def truncate_audio(self, audio_end_ms: int, content_index: int, item_id: str) -> None:
        """Truncate audio in the OpenAI Realtime API.

        Args:
            audio_end_ms (int): The end of the audio to truncate.
            content_index (int): The index of the content to truncate.
            item_id (str): The ID of the item to truncate.
        """
        await self.connection.conversation.item.truncate(
            audio_end_ms=audio_end_ms, content_index=content_index, item_id=item_id
        )

    async def _initialize_session(self) -> None:
        """Control initial session with OpenAI."""
        session_update = {
            "turn_detection": {"type": "server_vad"},
            "voice": self._voice,
            "modalities": ["audio", "text"],
            "temperature": self._temperature,
        }
        await self.session_update(session_options=session_update)

    async def session_update(self, session_options: dict[str, Any]) -> None:
        """Send a session update to the OpenAI Realtime API.

        Args:
            session_options (dict[str, Any]): The session options to update.
        """
        logger = self.logger
        logger.info(f"Sending session update: {session_options}")
        await self.connection.session.update(session=session_options)  # type: ignore[arg-type]
        logger.info("Sending session update finished")

    @asynccontextmanager
    async def connect(self) -> AsyncGenerator[None, None]:
        """Connect to the OpenAI Realtime API."""
        try:
            if not self._client:
                self._client = AsyncOpenAI(
                    api_key=self.config.get("api_key", None),
                    organization=self.config.get("organization", None),
                    project=self.config.get("project", None),
                    base_url=self.config.get("base_url", None),
                    websocket_base_url=self.config.get("websocket_base_url", None),
                    timeout=self.config.get("timeout", NOT_GIVEN),
                    max_retries=self.config.get("max_retries", DEFAULT_MAX_RETRIES),
                    default_headers=self.config.get("default_headers", None),
                    default_query=self.config.get("default_query", None),
                )
            async with self._client.beta.realtime.connect(
                model=self._model,
            ) as self._connection:
                await self._initialize_session()
                yield
        finally:
            self._connection = None

    async def read_events(self) -> AsyncGenerator[RealtimeEvent, None]:
        """Read messages from the OpenAI Realtime API."""
        if self._connection is None:
            raise RuntimeError("Client is not connected, call connect() first.")

        try:
            async for event in self._read_events():
                yield event

        finally:
            self._connection = None

    async def _read_from_connection(self) -> AsyncGenerator[RealtimeEvent, None]:
        """Read messages from the OpenAI Realtime API."""
        async for message in self._connection:
            for event in self._parse_message(message.model_dump()):
                yield event

    def _parse_message(self, message: dict[str, Any]) -> list[RealtimeEvent]:
        """Parse a message from the OpenAI Realtime API.

        Args:
            message (dict[str, Any]): The message to parse.

        Returns:
            RealtimeEvent: The parsed event.
        """
        return [parse_oai_message(message)]

    @classmethod
    def get_factory(
        cls, llm_config: Union[LLMConfig, dict[str, Any]], logger: Logger, **kwargs: Any
    ) -> Optional[Callable[[], "RealtimeClientProtocol"]]:
        """Create a Realtime API client.

        Args:
            llm_config: The config for the client.
            logger: The logger to use for logging events.
            kwargs: Additional arguments.

        Returns:
            RealtimeClientProtocol: The Realtime API client is returned if the model matches the pattern
        """
        if llm_config["config_list"][0].get("api_type", "openai") == "openai" and list(kwargs.keys()) == []:
            return lambda: OpenAIRealtimeClient(llm_config=llm_config, logger=logger, **kwargs)
        return None


# needed for mypy to check if OpenAIRealtimeWebRTCClient implements RealtimeClientProtocol
if TYPE_CHECKING:
    _client: RealtimeClientProtocol = OpenAIRealtimeClient(llm_config={})
