# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from logging import Logger, getLogger
from typing import TYPE_CHECKING, Any, Callable, Optional, Union

from autogen.import_utils import optional_import_block, require_optional_import

from ......doc_utils import export_module
from ......llm_config import LLMConfig
from ...realtime_events import RealtimeEvent
from ..realtime_client import RealtimeClientBase, Role, register_realtime_client
from .utils import parse_oai_message

if TYPE_CHECKING:
    from ...websockets import WebSocketProtocol as WebSocket
    from ..realtime_client import RealtimeClientProtocol

with optional_import_block():
    import httpx

__all__ = ["OpenAIRealtimeWebRTCClient"]

global_logger = getLogger(__name__)


@register_realtime_client()
@require_optional_import("httpx", "openai-realtime", except_for="get_factory")
@export_module("autogen.agentchat.realtime.experimental.clients.oai")
class OpenAIRealtimeWebRTCClient(RealtimeClientBase):
    """(Experimental) Client for OpenAI Realtime API that uses WebRTC protocol."""

    def __init__(
        self,
        *,
        llm_config: Union[LLMConfig, dict[str, Any]],
        websocket: "WebSocket",
        logger: Optional[Logger] = None,
    ) -> None:
        """(Experimental) Client for OpenAI Realtime API.

        Args:
            llm_config: The config for the client.
            websocket: the websocket to use for the connection
            logger: the logger to use for logging events
        """
        super().__init__()
        self._llm_config = llm_config
        self._logger = logger
        self._websocket = websocket

        config = llm_config["config_list"][0]
        self._model: str = config["model"]
        self._voice: str = config.get("voice", "alloy")
        self._temperature: float = llm_config.get("temperature", 0.8)  # type: ignore[union-attr]
        self._config = config
        self._base_url = config.get("base_url", "https://api.openai.com/v1/realtime/sessions")

    @property
    def logger(self) -> Logger:
        """Get the logger for the OpenAI Realtime API."""
        return self._logger or global_logger

    async def send_function_result(self, call_id: str, result: str) -> None:
        """Send the result of a function call to the OpenAI Realtime API.

        Args:
            call_id (str): The ID of the function call.
            result (str): The result of the function call.
        """
        await self._websocket.send_json({
            "type": "conversation.item.create",
            "item": {
                "type": "function_call_output",
                "call_id": call_id,
                "output": result,
            },
        })
        await self._websocket.send_json({"type": "response.create"})

    async def send_text(self, *, role: Role, text: str) -> None:
        """Send a text message to the OpenAI Realtime API.

        Args:
            role (str): The role of the message.
            text (str): The text of the message.
        """
        # await self.connection.response.cancel() #why is this here?
        await self._websocket.send_json({
            "type": "response.cancel",
        })
        await self._websocket.send_json({
            "type": "conversation.item.create",
            "item": {"type": "message", "role": role, "content": [{"type": "input_text", "text": text}]},
        })
        # await self.connection.response.create()
        await self._websocket.send_json({"type": "response.create"})

    async def send_audio(self, audio: str) -> None:
        """Send audio to the OpenAI Realtime API.
        in case of WebRTC, audio is already sent by js client, so we just queue it in order to be logged.

        Args:
            audio (str): The audio to send.
        """
        await self.queue_input_audio_buffer_delta(audio)

    async def truncate_audio(self, audio_end_ms: int, content_index: int, item_id: str) -> None:
        """Truncate audio in the OpenAI Realtime API.

        Args:
            audio_end_ms (int): The end of the audio to truncate.
            content_index (int): The index of the content to truncate.
            item_id (str): The ID of the item to truncate.
        """
        await self._websocket.send_json({
            "type": "conversation.item.truncate",
            "content_index": content_index,
            "item_id": item_id,
            "audio_end_ms": audio_end_ms,
        })

    async def session_update(self, session_options: dict[str, Any]) -> None:
        """Send a session update to the OpenAI Realtime API.

        In the case of WebRTC we can not send it directly, but we can send it
        to the javascript over the websocket, and rely on it to send session
        update to OpenAI

        Args:
            session_options (dict[str, Any]): The session options to update.
        """
        logger = self.logger
        logger.info(f"Sending session update: {session_options}")
        # await self.connection.session.update(session=session_options)  # type: ignore[arg-type]
        await self._websocket.send_json({"type": "session.update", "session": session_options})
        logger.info("Sending session update finished")

    def session_init_data(self) -> list[dict[str, Any]]:
        """Control initial session with OpenAI."""
        session_update = {
            "turn_detection": {"type": "server_vad"},
            "voice": self._voice,
            "modalities": ["audio", "text"],
            "temperature": self._temperature,
        }
        return [{"type": "session.update", "session": session_update}]

    async def _initialize_session(self) -> None: ...

    @asynccontextmanager
    async def connect(self) -> AsyncGenerator[None, None]:
        """Connect to the OpenAI Realtime API.

        In the case of WebRTC, we pass connection information over the
        websocket, so that javascript on the other end of websocket open
        actual connection to OpenAI
        """
        try:
            base_url = self._base_url
            api_key = self._config.get("api_key", None)
            headers = {
                "Authorization": f"Bearer {api_key}",  # Use os.getenv to get from environment
                "Content-Type": "application/json",
            }
            data = {
                # "model": "gpt-4o-realtime-preview-2024-12-17",
                "model": self._model,
                "voice": self._voice,
            }
            async with httpx.AsyncClient() as client:
                response = await client.post(base_url, headers=headers, json=data)
                response.raise_for_status()
                json_data = response.json()
                json_data["model"] = self._model
            if self._websocket is not None:
                session_init = self.session_init_data()
                await self._websocket.send_json({"type": "ag2.init", "config": json_data, "init": session_init})
            yield
        finally:
            pass

    async def read_events(self) -> AsyncGenerator[RealtimeEvent, None]:
        """Read events from the OpenAI Realtime API."""
        async for event in self._read_events():
            yield event

    async def _read_from_connection(self) -> AsyncGenerator[RealtimeEvent, None]:
        """Read messages from the OpenAI Realtime API connection.
        Again, in case of WebRTC, we do not read OpenAI messages directly since we
        do not hold connection to OpenAI. Instead we read messages from the websocket, and javascript
        client on the other side of the websocket that is connected to OpenAI is relaying events to us.
        """
        while True:
            try:
                message_json = await self._websocket.receive_text()
                message = json.loads(message_json)
                for event in self._parse_message(message):
                    yield event
            except Exception as e:
                self.logger.exception(f"Error reading from connection {e}")
                break

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
            **kwargs: Additional arguments.

        Returns:
            RealtimeClientProtocol: The Realtime API client is returned if the model matches the pattern
        """
        if llm_config["config_list"][0].get("api_type", "openai") == "openai" and list(kwargs.keys()) == ["websocket"]:
            return lambda: OpenAIRealtimeWebRTCClient(llm_config=llm_config, logger=logger, **kwargs)

        return None


# needed for mypy to check if OpenAIRealtimeWebRTCClient implements RealtimeClientProtocol
if TYPE_CHECKING:

    def _rtc_client(websocket: "WebSocket") -> RealtimeClientProtocol:
        return OpenAIRealtimeWebRTCClient(llm_config={}, websocket=websocket)
