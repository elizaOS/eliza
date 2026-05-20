from __future__ import annotations

import json
import threading
from collections.abc import Callable, Iterable
from contextlib import AbstractContextManager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Queue
from typing import Any


@dataclass(frozen=True)
class RequestRecord:
    path: str
    headers: dict[str, str]
    payload: dict[str, Any]


ResponseFactory = Callable[[RequestRecord], dict[str, Any] | str]


class _OpenAICompatHandler(BaseHTTPRequestHandler):
    server: _OpenAICompatHTTPServer

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or "0")
        raw_body = self.rfile.read(length).decode("utf-8") if length else "{}"
        payload = json.loads(raw_body)
        record = RequestRecord(
            path=self.path,
            headers={key: value for key, value in self.headers.items()},
            payload=payload if isinstance(payload, dict) else {"raw": payload},
        )
        self.server.request_records.append(record)

        response_item = self.server.responses.get_nowait()
        if callable(response_item):
            response_item = response_item(record)
        content = (
            response_item
            if isinstance(response_item, str)
            else json.dumps(response_item, ensure_ascii=False)
        )
        body = {
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 0,
            "model": "test-judge",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
        }
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class _OpenAICompatHTTPServer(ThreadingHTTPServer):
    responses: Queue[dict[str, Any] | str | ResponseFactory]
    request_records: list[RequestRecord]


class OpenAICompatTestServer(AbstractContextManager["OpenAICompatTestServer"]):
    def __init__(self, responses: Iterable[dict[str, Any] | str | ResponseFactory]) -> None:
        self._responses = list(responses)
        self._server: _OpenAICompatHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def __enter__(self) -> OpenAICompatTestServer:
        server = _OpenAICompatHTTPServer(("127.0.0.1", 0), _OpenAICompatHandler)
        server.responses = Queue()
        for response in self._responses:
            server.responses.put(response)
        server.request_records = []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self._server = server
        self._thread = thread
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=2)

    @property
    def base_url(self) -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_port}/v1"

    @property
    def requests(self) -> list[RequestRecord]:
        assert self._server is not None
        return list(self._server.request_records)
