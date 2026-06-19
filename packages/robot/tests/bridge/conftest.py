"""Shared pytest fixtures for the bridge test suite."""

from __future__ import annotations

import asyncio
import socket
from collections.abc import AsyncIterator

import pytest_asyncio
from websockets.asyncio.server import serve

from eliza_robot.bridge.backends.mock_backend import MockBackend
from eliza_robot.bridge.server import RuntimeConfig, _handler


def _free_port() -> int:
    """Bind, read, release a free TCP port. Race-prone but acceptable for tests."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


@pytest_asyncio.fixture
async def mock_server() -> AsyncIterator[str]:
    """Boot the bridge with the MockBackend on a random port.

    Yields the websocket URL (``ws://127.0.0.1:<port>``). Shuts the server
    down on teardown.
    """
    port = _free_port()
    config = RuntimeConfig(
        queue_size=64,
        max_commands_per_sec=200,
        deadman_timeout_sec=10.0,
        trace_log_path="",
    )

    async def handler(ws) -> None:
        await _handler(ws, MockBackend, config)

    server = await serve(handler, "127.0.0.1", port)
    serve_task = asyncio.create_task(server.serve_forever())
    # Allow the listener to fully bind before clients connect.
    await asyncio.sleep(0.05)

    try:
        yield f"ws://127.0.0.1:{port}"
    finally:
        server.close()
        await server.wait_closed()
        serve_task.cancel()
        try:
            await serve_task
        except (asyncio.CancelledError, Exception):
            pass
