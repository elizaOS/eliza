"""HTTP/SSE transport for MCP connections."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from elizaos_plugin_mcp.transports.base import Transport
from elizaos_plugin_mcp.types import HttpServerConfig, McpError


class HttpTransport(Transport):
    def __init__(self, config: HttpServerConfig) -> None:
        self._config = config
        self._client: httpx.AsyncClient | None = None
        self._request_id = 0
        self._pending_responses: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._sse_task: asyncio.Task[None] | None = None
        self._connected = False

    async def connect(self) -> None:
        if self._connected:
            raise McpError("Transport already connected", "ALREADY_CONNECTED")

        self._client = httpx.AsyncClient(timeout=httpx.Timeout(self._config.timeout_ms / 1000))

        self._sse_task = asyncio.create_task(self._sse_listener())
        self._connected = True

    async def _sse_listener(self) -> None:
        if self._client is None:
            return

        try:
            async with self._client.stream("GET", self._config.url) as response:
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        data = json.loads(line[6:])
                        await self._handle_message(data)
        except httpx.HTTPError as e:
            if self._connected:
                raise McpError.connection_error("http", str(e)) from e

    async def _handle_message(self, message: dict[str, Any]) -> None:
        if "id" in message and message["id"] in self._pending_responses:
            future = self._pending_responses.pop(message["id"])
            if not future.done():
                future.set_result(message)

    async def send(self, message: dict[str, Any]) -> None:
        if self._client is None:
            raise McpError("Transport not connected", "NOT_CONNECTED")

        response = await self._client.post(
            self._config.url,
            json=message,
            headers={"Content-Type": "application/json"},
        )
        response.raise_for_status()

    async def receive(self) -> dict[str, Any]:
        if not self._connected:
            raise McpError("Transport not connected", "NOT_CONNECTED")

        raise McpError(
            "Direct receive not supported for HTTP transport, use send_request",
            "NOT_SUPPORTED",
        )

    async def send_request(self, message: dict[str, Any]) -> dict[str, Any]:
        if self._client is None:
            raise McpError("Transport not connected", "NOT_CONNECTED")

        request_id = message.get("id")
        if request_id is None:
            raise McpError("Request must have an id", "INVALID_REQUEST")

        future: asyncio.Future[dict[str, Any]] = asyncio.get_event_loop().create_future()
        self._pending_responses[request_id] = future

        await self.send(message)

        try:
            return await asyncio.wait_for(
                future,
                timeout=self._config.timeout_ms / 1000,
            )
        except TimeoutError as e:
            self._pending_responses.pop(request_id, None)
            raise McpError.timeout_error(f"Request {request_id}") from e

    async def close(self) -> None:
        self._connected = False

        if self._sse_task is not None:
            self._sse_task.cancel()
            try:
                await self._sse_task
            except asyncio.CancelledError:
                pass
            self._sse_task = None

        if self._client is not None:
            await self._client.aclose()
            self._client = None

        for future in self._pending_responses.values():
            if not future.done():
                future.cancel()
        self._pending_responses.clear()

    def next_request_id(self) -> int:
        self._request_id += 1
        return self._request_id
