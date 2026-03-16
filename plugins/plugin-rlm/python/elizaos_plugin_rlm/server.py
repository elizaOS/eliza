"""
RLM IPC server for TypeScript and Rust clients.

This module provides a JSON-RPC style server that allows TypeScript and Rust
implementations to call the Python RLM client via subprocess/IPC.

Protocol:
- Communication via stdin/stdout using JSON lines
- Request: {"id": int, "method": str, "params": dict}
- Response: {"id": int, "result": any} or {"id": int, "error": str}

Methods:
- "infer": Run RLM inference
- "status": Get client status
- "shutdown": Clean shutdown

Usage:
    python -m elizaos_plugin_rlm.server

Or as a module:
    from elizaos_plugin_rlm.server import run_server
    asyncio.run(run_server())
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Dict, Optional

from .client import RLMClient, RLMConfig


class RLMServer:
    """JSON-RPC style IPC server for RLM."""

    def __init__(self, config: Optional[RLMConfig] = None) -> None:
        """Initialize the server with optional config."""
        self.client = RLMClient(config)
        self._running = False

    async def handle_request(self, request: Dict[str, object]) -> Dict[str, object]:
        """
        Handle a single JSON-RPC style request.

        Args:
            request: Request dict with "id", "method", and "params".

        Returns:
            Response dict with "id" and either "result" or "error".
        """
        request_id = request.get("id", 0)
        method = request.get("method", "")
        params = request.get("params", {})

        if not isinstance(params, dict):
            params = {}

        try:
            if method == "infer":
                messages = params.get("messages", params.get("prompt", ""))
                opts = params.get("opts", {})
                if not isinstance(opts, dict):
                    opts = {}
                result = await self.client.infer(messages, opts)
                return {"id": request_id, "result": result.to_dict()}

            elif method == "status":
                return {
                    "id": request_id,
                    "result": {
                        "available": self.client.is_available,
                        "backend": self.client.config.backend,
                        "environment": self.client.config.environment,
                        "max_iterations": self.client.config.max_iterations,
                        "max_depth": self.client.config.max_depth,
                    },
                }

            elif method == "shutdown":
                self._running = False
                await self.client.close()
                return {"id": request_id, "result": {"shutdown": True}}

            else:
                return {"id": request_id, "error": f"Unknown method: {method}"}

        except Exception as e:
            return {"id": request_id, "error": str(e)}

    async def run(self) -> None:
        """Run the IPC server, reading from stdin and writing to stdout."""
        self._running = True

        # Use asyncio streams for non-blocking I/O
        loop = asyncio.get_event_loop()
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)

        # Write initial ready message
        ready_msg = json.dumps({"ready": True, "available": self.client.is_available})
        sys.stdout.write(ready_msg + "\n")
        sys.stdout.flush()

        while self._running:
            try:
                line = await asyncio.wait_for(reader.readline(), timeout=1.0)
                if not line:
                    break

                line_str = line.decode("utf-8").strip()
                if not line_str:
                    continue

                request = json.loads(line_str)
                response = await self.handle_request(request)

                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()

            except asyncio.TimeoutError:
                continue
            except json.JSONDecodeError as e:
                error_response = {"id": 0, "error": f"Invalid JSON: {e}"}
                sys.stdout.write(json.dumps(error_response) + "\n")
                sys.stdout.flush()
            except Exception as e:
                error_response = {"id": 0, "error": f"Server error: {e}"}
                sys.stdout.write(json.dumps(error_response) + "\n")
                sys.stdout.flush()

        await self.client.close()


async def run_server(config: Optional[RLMConfig] = None) -> None:
    """
    Run the RLM IPC server.

    Args:
        config: Optional RLM configuration.
    """
    server = RLMServer(config)
    await server.run()


def main() -> None:
    """Entry point for the server."""
    asyncio.run(run_server())


if __name__ == "__main__":
    main()
