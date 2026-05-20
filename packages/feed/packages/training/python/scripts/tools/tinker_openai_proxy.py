#!/usr/bin/env python3
"""Serve a Tinker sampling checkpoint behind a minimal OpenAI-compatible API."""

from __future__ import annotations

import argparse
import inspect
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.training.tinker_client import TINKER_AVAILABLE, tinker, tinker_types


def _require_tinker_api_key() -> None:
    if any(os.getenv(key) for key in ("TINKER_API_KEY", "TM_API_KEY", "THINKINGMACHINES_API_KEY")):
        return
    raise ValueError(
        "TINKER_API_KEY environment variable not set. "
        "Set TINKER_API_KEY, TM_API_KEY, or THINKINGMACHINES_API_KEY."
    )


def _infer_assistant_prefix(messages: list[dict[str, Any]]) -> str | None:
    combined = "\n".join(
        str(message.get("content", "")) for message in messages if isinstance(message, dict)
    ).lower()

    json_markers = (
        "output valid json only",
        "respond only with valid json",
        "return exactly one json object",
        'the first character of your reply must be "{"',
        'the last character must be "}"',
        "double-quoted keys and strings only",
    )
    if any(marker in combined for marker in json_markers):
        return "{"

    xml_markers = (
        "output valid xml only",
        "respond only with valid xml",
        "start your response immediately with <",
    )
    if any(marker in combined for marker in xml_markers):
        return "<"

    return None


class ProxyHandler(BaseHTTPRequestHandler):
    sampling_client: Any = None
    tokenizer: Any = None
    served_model_name = "tinker-proxy"
    model_ref = ""
    default_max_tokens = 256

    def log_message(self, format: str, *args: object) -> None:
        del format, args

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json_body(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0") or 0)
        if content_length <= 0:
            return {}
        return json.loads(self.rfile.read(content_length).decode("utf-8"))

    def do_GET(self) -> None:
        normalized_path = self.path.rstrip("/")
        if normalized_path in {"", "/v1/models"}:
            self._send_json(
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": self.served_model_name,
                            "object": "model",
                            "owned_by": "tinker",
                        }
                    ],
                },
            )
            return
        if normalized_path in {"/health", "/v1/health"}:
            self._send_json(200, {"status": "ok"})
            return
        self._send_json(404, {"error": {"message": f"Unknown path: {self.path}"}})

    def do_POST(self) -> None:
        normalized_path = self.path.rstrip("/")
        if normalized_path != "/v1/chat/completions":
            self._send_json(404, {"error": {"message": f"Unknown path: {self.path}"}})
            return

        try:
            payload = self._json_body()
            self._send_json(200, self._chat_completion(payload))
        except Exception as exc:
            self._send_json(500, {"error": {"message": str(exc)}})

    def _chat_completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("messages must be a non-empty list")

        temperature = float(payload.get("temperature", 0.0) or 0.0)
        max_tokens = int(payload.get("max_tokens") or self.default_max_tokens)
        num_samples = max(1, int(payload.get("n") or 1))
        assistant_prefix = payload.get("assistant_prefix")
        if not isinstance(assistant_prefix, str) or not assistant_prefix.strip():
            assistant_prefix = _infer_assistant_prefix(messages)
        stop = payload.get("stop") or []
        if isinstance(stop, str):
            stop = [stop]
        elif not isinstance(stop, list):
            stop = []

        if assistant_prefix is not None:
            template_messages = [
                *messages,
                {"role": "assistant", "content": assistant_prefix},
            ]
            template_kwargs: dict[str, Any] = {
                "tokenize": False,
                "add_generation_prompt": False,
            }
            parameters = inspect.signature(self.tokenizer.apply_chat_template).parameters
            if "continue_final_message" in parameters:
                template_kwargs["continue_final_message"] = True
            prompt = self.tokenizer.apply_chat_template(
                template_messages,
                **template_kwargs,
            )
        else:
            prompt = self.tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
        prompt_tokens = tinker_types.ModelInput.from_ints(self.tokenizer.encode(prompt))
        sampling_params = tinker_types.SamplingParams(
            max_tokens=max_tokens,
            temperature=temperature,
            stop=stop,
        )
        result = self.sampling_client.sample(
            prompt=prompt_tokens,
            sampling_params=sampling_params,
            num_samples=num_samples,
            include_prompt_logprobs=False,
        ).result()

        choices = []
        for index, sequence in enumerate(result.sequences):
            content = self.tokenizer.decode(sequence.tokens)
            if assistant_prefix is not None and not content.lower().startswith(
                assistant_prefix.lower()
            ):
                content = f"{assistant_prefix}{content.lstrip()}"
            choices.append(
                {
                    "index": index,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": getattr(sequence, "finish_reason", "stop"),
                }
            )

        return {
            "id": f"chatcmpl-{int(time.time() * 1000)}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": self.served_model_name,
            "choices": choices,
        }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Expose a Tinker sampler checkpoint behind a minimal OpenAI-compatible API."
    )
    parser.add_argument("--model-ref", required=True)
    parser.add_argument("--served-model-name", default="tinker-proxy")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--max-tokens", type=int, default=256)
    args = parser.parse_args()

    if not TINKER_AVAILABLE:
        raise RuntimeError("Tinker is not installed in this environment.")
    _require_tinker_api_key()

    service_client = tinker.ServiceClient()
    sampling_client = service_client.create_sampling_client(model_path=args.model_ref)
    tokenizer = sampling_client.get_tokenizer()

    handler_cls = type(
        "ConfiguredTinkerProxyHandler",
        (ProxyHandler,),
        {
            "sampling_client": sampling_client,
            "tokenizer": tokenizer,
            "served_model_name": args.served_model_name,
            "model_ref": args.model_ref,
            "default_max_tokens": args.max_tokens,
        },
    )
    server = ThreadingHTTPServer((args.host, args.port), handler_cls)
    print(
        f"Tinker proxy listening on http://{args.host}:{args.port} "
        f"for {args.model_ref} as {args.served_model_name}"
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
