"""Stdio transport for MCP connections."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from elizaos_plugin_mcp.transports.base import Transport
from elizaos_plugin_mcp.types import McpError, StdioServerConfig


class StdioTransport(Transport):
    """Transport that communicates with an MCP server via stdio."""

    def __init__(self, config: StdioServerConfig) -> None:
        """Initialize the stdio transport.

        Args:
            config: Configuration for the stdio server.
        """
        self._config = config
        self._process: asyncio.subprocess.Process | None = None
        self._request_id = 0

    async def connect(self) -> None:
        """Start the MCP server subprocess and establish communication."""
        if self._process is not None:
            raise McpError("Transport already connected", "ALREADY_CONNECTED")

        # Build environment
        env = {**os.environ, **self._config.env}
        if "PATH" not in env and "PATH" in os.environ:
            env["PATH"] = os.environ["PATH"]

        # Start the subprocess
        self._process = await asyncio.create_subprocess_exec(
            self._config.command,
            *self._config.args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=self._config.cwd,
        )

        if self._process.stdin is None or self._process.stdout is None:
            raise McpError("Failed to create stdin/stdout pipes", "PIPE_ERROR")

    async def send(self, message: dict[str, Any]) -> None:
        """Send a JSON-RPC message to the server."""
        if self._process is None or self._process.stdin is None:
            raise McpError("Transport not connected", "NOT_CONNECTED")

        # MCP uses newline-delimited JSON (NDJSON) format
        json_str = json.dumps(message)
        content = f"{json_str}\n"

        self._process.stdin.write(content.encode("utf-8"))
        await self._process.stdin.drain()

    async def receive(self) -> dict[str, Any]:
        """Receive a JSON-RPC message from the server."""
        if self._process is None or self._process.stdout is None:
            raise McpError("Transport not connected", "NOT_CONNECTED")

        # MCP uses newline-delimited JSON (NDJSON) format
        # Read lines until we get a valid JSON response
        while True:
            line = await asyncio.wait_for(
                self._process.stdout.readline(),
                timeout=self._config.timeout_ms / 1000,
            )

            if not line:
                raise McpError("Connection closed by server", "CONNECTION_CLOSED")

            text = line.decode("utf-8").strip()

            # Skip empty lines and non-JSON lines (like log messages)
            if not text or not text.startswith("{"):
                continue

            # Parse the JSON response
            try:
                return json.loads(text)  # type: ignore[no-any-return]
            except json.JSONDecodeError:
                continue  # Skip malformed lines

    async def close(self) -> None:
        """Close the connection and terminate the subprocess."""
        if self._process is not None:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5.0)
            except TimeoutError:
                self._process.kill()
                await self._process.wait()
            self._process = None

    def next_request_id(self) -> int:
        """Generate the next request ID."""
        self._request_id += 1
        return self._request_id
