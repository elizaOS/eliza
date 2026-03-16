"""Local server tests for deep research (no mocks, no external API)."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from elizaos_plugin_openai.client import OpenAIClient
from elizaos_plugin_openai.types import OpenAIConfig, ResearchParams


class _ResearchHandler(BaseHTTPRequestHandler):
    last_body: list[str] = []

    def do_POST(self) -> None:  # noqa: N802 - http.server uses do_POST
        if self.path != "/responses":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        _ResearchHandler.last_body.append(body)

        response_body = json.dumps(
            {
                "id": "resp_local",
                "output_text": "Local research response.",
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "Local research response.",
                                "annotations": [
                                    {
                                        "url": "https://example.com",
                                        "title": "Example Source",
                                        "start_index": 0,
                                        "end_index": 24,
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        ).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_body)))
        self.end_headers()
        self.wfile.write(response_body)

    def log_message(self, *_: object) -> None:
        return


def _start_server() -> tuple[HTTPServer, int]:
    server = HTTPServer(("127.0.0.1", 0), _ResearchHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


@pytest.mark.asyncio
async def test_deep_research_local_server() -> None:
    server, port = _start_server()
    try:
        config = OpenAIConfig(
            api_key="sk-test-key-1234567890",
            base_url=f"http://127.0.0.1:{port}",
        )
        client = OpenAIClient(config)

        params = ResearchParams(input="Test research question")
        result = await client.deep_research(params)

        assert result.text == "Local research response."
        assert len(result.annotations) == 1

        assert _ResearchHandler.last_body
        body = json.loads(_ResearchHandler.last_body[-1])
        tools = body.get("tools")
        assert tools == [{"type": "web_search_preview"}]
    finally:
        server.shutdown()
