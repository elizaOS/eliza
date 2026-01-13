"""
E2E test runner for the Python A2A server.

Starts the FastAPI app with uvicorn on an ephemeral port, runs the client tests,
then shuts down the server.
"""

from __future__ import annotations

import asyncio
import socket

import uvicorn

from server import app
from test_client import run_a2a_test_client


def _get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


async def main() -> None:
    port = _get_free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)

    server_task = asyncio.create_task(server.serve())
    try:
        # Wait for startup
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.05)

        await run_a2a_test_client(f"http://127.0.0.1:{port}")
    finally:
        server.should_exit = True
        await server_task


if __name__ == "__main__":
    asyncio.run(main())

