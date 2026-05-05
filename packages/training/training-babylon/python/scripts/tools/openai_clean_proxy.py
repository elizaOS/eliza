#!/usr/bin/env python3
"""Minimal OpenAI-compatible proxy that strips empty tool-related fields."""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

TOOL_KEYS = {"tools", "tool_choice", "parallel_tool_calls", "tool_calls"}
EMPTY_COLLECTIONS = (list, dict, tuple, set)


def sanitize_payload(value: Any) -> Any:
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            normalized = sanitize_payload(item)
            if normalized is None:
                continue
            if key in TOOL_KEYS and (
                normalized is None or normalized == [] or normalized == {} or normalized == "none"
            ):
                continue
            cleaned[key] = normalized
        return cleaned
    if isinstance(value, list):
        cleaned_list = [sanitize_payload(item) for item in value]
        return [item for item in cleaned_list if item is not None]
    if isinstance(value, tuple):
        return [sanitize_payload(item) for item in value if sanitize_payload(item) is not None]
    return value


class ProxyHandler(BaseHTTPRequestHandler):
    upstream_base_url = ""

    def _forward(self) -> None:
        target_url = urljoin(self.upstream_base_url.rstrip("/") + "/", self.path.lstrip("/"))
        body = None
        if self.command in {"POST", "PUT", "PATCH"}:
            content_length = int(self.headers.get("Content-Length", "0") or 0)
            raw_body = self.rfile.read(content_length) if content_length > 0 else b""
            if raw_body:
                content_type = self.headers.get("Content-Type", "")
                if "application/json" in content_type:
                    payload = json.loads(raw_body.decode("utf-8"))
                    body = json.dumps(sanitize_payload(payload)).encode("utf-8")
                else:
                    body = raw_body

        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in {"host", "content-length", "connection"}
        }
        request = Request(
            target_url,
            data=body,
            headers=headers,
            method=self.command,
        )
        try:
            with urlopen(request, timeout=600) as response:
                response_body = response.read()
                self.send_response(response.status)
                for key, value in response.headers.items():
                    if key.lower() in {"transfer-encoding", "connection"}:
                        continue
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(response_body)
        except HTTPError as exc:
            response_body = exc.read()
            self.send_response(exc.code)
            for key, value in exc.headers.items():
                if key.lower() in {"transfer-encoding", "connection"}:
                    continue
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(response_body)

    def do_GET(self) -> None:
        self._forward()

    def do_POST(self) -> None:
        self._forward()

    def do_PUT(self) -> None:
        self._forward()

    def do_PATCH(self) -> None:
        self._forward()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Strip empty tool fields before forwarding OpenAI-compatible requests."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8098)
    parser.add_argument("--upstream-base-url", required=True)
    args = parser.parse_args()

    handler_cls = type(
        "ConfiguredProxyHandler",
        (ProxyHandler,),
        {"upstream_base_url": args.upstream_base_url},
    )
    server = ThreadingHTTPServer((args.host, args.port), handler_cls)
    print(
        f"OpenAI clean proxy listening on http://{args.host}:{args.port} -> {args.upstream_base_url}"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
