# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from logging import Logger, getLogger
from typing import TYPE_CHECKING, Any, Callable, Optional, Union

from ......doc_utils import export_module
from ......import_utils import optional_import_block, require_optional_import
from ......llm_config import LLMConfig
from ...realtime_events import AudioDelta, FunctionCall, RealtimeEvent, SessionCreated
from ..realtime_client import RealtimeClientBase, Role, register_realtime_client

with optional_import_block():
    from websockets.asyncio.client import connect


if TYPE_CHECKING:
    from websockets.asyncio.client import ClientConnection

    from ..realtime_client import RealtimeClientProtocol

__all__ = ["GeminiRealtimeClient"]

global_logger = getLogger(__name__)


HOST = "generativelanguage.googleapis.com"
API_VERSION = "v1alpha"


@register_realtime_client()
@require_optional_import("websockets", "gemini", except_for=["get_factory", "__init__"])
@export_module("autogen.agentchat.realtime.experimental.clients")
class GeminiRealtimeClient(RealtimeClientBase):
    """(Experimental) Client for Gemini Realtime API."""

    def __init__(
        self,
        *,
        llm_config: Union[LLMConfig, dict[str, Any]],
        logger: Optional[Logger] = None,
    ) -> None:
        """(Experimental) Client for Gemini Realtime API.

        Args:
            llm_config: The config for the client.
            logger: The logger for the client.
        """
        super().__init__()
        self._llm_config = llm_config
        self._logger = logger

        self._connection: Optional["ClientConnection"] = None
        config = llm_config["config_list"][0]

        self._model: str = config["model"]
        self._voice = config.get("voice", "charon")
        self._temperature: float = config.get("temperature", 0.8)  # type: ignore[union-attr]

        self._response_modality = "AUDIO"

        self._api_key = config.get("api_key", None)
        # todo: add test with base_url just to make sure it works
        self._base_url: str = config.get(
            "base_url",
            f"wss://{HOST}/ws/google.ai.generativelanguage.{API_VERSION}.GenerativeService.BidiGenerateContent?key={self._api_key}",
        )
        self._final_config: dict[str, Any] = {}
        self._pending_session_updates: dict[str, Any] = {}
        self._is_reading_events = False

    @property
    def logger(self) -> Logger:
        """Get the logger for the Gemini Realtime API."""
        return self._logger or global_logger

    @property
    def connection(self) -> "ClientConnection":
        """Get the Gemini WebSocket connection."""
        if self._connection is None:
            raise RuntimeError("Gemini WebSocket is not initialized")
        return self._connection

    async def send_function_result(self, call_id: str, result: str) -> None:
        """Send the result of a function call to the Gemini Realtime API.

        Args:
            call_id (str): The ID of the function call.
            result (str): The result of the function call.
        """
        msg = {
            "tool_response": {"function_responses": [{"id": call_id, "response": {"result": {"string_value": result}}}]}
        }
        if self._is_reading_events:
            await self.connection.send(json.dumps(msg))

    async def send_text(self, *, role: Role, text: str, turn_complete: bool = True) -> None:
        """Send a text message to the Gemini Realtime API.

        Args:
            role: The role of the message.
            text: The text of the message.
            turn_complete: A flag indicating if the turn is complete.
        """
        msg = {
            "client_content": {
                "turn_complete": turn_complete,
                "turns": [{"role": role, "parts": [{"text": text}]}],
            }
        }
        if self._is_reading_events:
            await self.connection.send(json.dumps(msg))

    async def send_audio(self, audio: str) -> None:
        """Send audio to the Gemini Realtime API.

        Args:
            audio (str): The audio to send.
        """
        msg = {
            "realtime_input": {
                "media_chunks": [
                    {
                        "data": audio,
                        "mime_type": "audio/pcm",
                    }
                ]
            }
        }
        await self.queue_input_audio_buffer_delta(audio)
        if self._is_reading_events:
            await self.connection.send(json.dumps(msg))

    async def truncate_audio(self, audio_end_ms: int, content_index: int, item_id: str) -> None:
        self.logger.info("This is not natively supported by Gemini Realtime API.")
        pass

    async def _initialize_session(self) -> None:
        """Initialize the session with the Gemini Realtime API."""
        session_config = {
            "setup": {
                "system_instruction": {
                    "role": "system",
                    "parts": [{"text": self._pending_session_updates.get("instructions", "")}],
                },
                "model": f"models/{self._model}",
                "tools": [
                    {
                        "function_declarations": [
                            {
                                "name": tool_schema["name"],
                                "description": tool_schema["description"],
                                "parameters": tool_schema["parameters"],
                            }
                            for tool_schema in self._pending_session_updates.get("tools", [])
                        ]
                    },
                ],
                "generation_config": {
                    "response_modalities": [self._response_modality],
                    "speech_config": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": self._voice}}},
                    "temperature": self._temperature,
                },
            }
        }

        self.logger.info(f"Sending session update: {session_config}")
        await self.connection.send(json.dumps(session_config))

    async def session_update(self, session_options: dict[str, Any]) -> None:
        """Record session updates to be applied when the connection is established.

        Args:
            session_options (dict[str, Any]): The session options to update.
        """
        if self._is_reading_events:
            self.logger.warning("Is reading events. Session update will be ignored.")
        else:
            self._pending_session_updates.update(session_options)

    @asynccontextmanager
    async def connect(self) -> AsyncGenerator[None, None]:
        """Connect to the Gemini Realtime API."""
        try:
            async with connect(
                self._base_url, additional_headers={"Content-Type": "application/json"}
            ) as self._connection:
                yield
        finally:
            self._connection = None

    async def read_events(self) -> AsyncGenerator[RealtimeEvent, None]:
        """Read Events from the Gemini Realtime Client"""
        if self._connection is None:
            raise RuntimeError("Client is not connected, call connect() first.")
        await self._initialize_session()

        self._is_reading_events = True

        async for event in self._read_events():
            yield event

    async def _read_from_connection(self) -> AsyncGenerator[RealtimeEvent, None]:
        """Read messages from the Gemini Realtime connection."""
        async for raw_message in self.connection:
            message = raw_message.decode("ascii") if isinstance(raw_message, bytes) else raw_message
            events = self._parse_message(json.loads(message))
            for event in events:
                yield event

    def _parse_message(self, response: dict[str, Any]) -> list[RealtimeEvent]:
        """Parse a message from the Gemini Realtime API.

        Args:
            response (dict[str, Any]): The response to parse.

        Returns:
            list[RealtimeEvent]: The parsed events.
        """
        if "serverContent" in response and "modelTurn" in response["serverContent"]:
            try:
                b64data = response["serverContent"]["modelTurn"]["parts"][0]["inlineData"].pop("data")
                return [
                    AudioDelta(
                        delta=b64data,
                        item_id=None,
                        raw_message=response,
                    )
                ]
            except KeyError:
                return []
        elif "toolCall" in response:
            return [
                FunctionCall(
                    raw_message=response,
                    call_id=call["id"],
                    name=call["name"],
                    arguments=call["args"],
                )
                for call in response["toolCall"]["functionCalls"]
            ]
        elif "setupComplete" in response:
            return [
                SessionCreated(raw_message=response),
            ]
        else:
            return [RealtimeEvent(raw_message=response)]

    @classmethod
    def get_factory(
        cls, llm_config: Union[LLMConfig, dict[str, Any]], logger: Logger, **kwargs: Any
    ) -> Optional[Callable[[], "RealtimeClientProtocol"]]:
        """Create a Realtime API client.

        Args:
            llm_config: The LLM config for the client.
            logger: The logger for the client.
            **kwargs: Additional arguments.

        Returns:
            RealtimeClientProtocol: The Realtime API client is returned if the model matches the pattern
        """
        if llm_config["config_list"][0].get("api_type") == "google" and list(kwargs.keys()) == []:
            return lambda: GeminiRealtimeClient(llm_config=llm_config, logger=logger, **kwargs)
        return None


# needed for mypy to check if GeminiRealtimeClient implements RealtimeClientProtocol
if TYPE_CHECKING:
    _client: RealtimeClientProtocol = GeminiRealtimeClient(llm_config={})
