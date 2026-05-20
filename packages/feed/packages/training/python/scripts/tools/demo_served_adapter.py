#!/usr/bin/env python3
"""
Serve a locally trained MLX adapter and issue a demo completion.

This is a reproducible post-train smoke test for the "can it actually serve?"
question. It boots the MLX HTTP server against a training manifest or explicit
model/adapter pair, waits for readiness, issues one OpenAI-style chat request,
prints the response, and then shuts the server down.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

DEFAULT_PROMPT = (
    "Balance: $10,000. Open positions: 0. "
    "Market: OpenAGI update at 81% YES. "
    "What trade do you place and why?"
)


def load_manifest(manifest_path: Path) -> tuple[str, str]:
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    model_name = manifest.get("model_name")
    adapter_path = manifest.get("output_path")
    if not model_name or not adapter_path:
        raise ValueError(f"Manifest {manifest_path} is missing model_name or output_path")

    return str(model_name), str(adapter_path)


def request_json(url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = Request(url, data=data, headers=headers)
    with urlopen(request, timeout=60) as response:
        return json.load(response)


def wait_for_server(base_url: str, timeout_seconds: int) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None

    while time.time() < deadline:
        try:
            return request_json(f"{base_url}/v1/models")
        except Exception as exc:
            last_error = exc
            time.sleep(1)

    raise TimeoutError(f"Timed out waiting for MLX server at {base_url}: {last_error}")


def terminate_process(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return

    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Serve a trained MLX adapter and run a demo chat completion."
    )
    parser.add_argument(
        "--manifest",
        help="Path to training_manifest.json with model_name and output_path",
    )
    parser.add_argument("--model", help="Base MLX model id/path")
    parser.add_argument("--adapter-path", help="Path to adapter directory")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8093)
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--max-tokens", type=int, default=120)
    parser.add_argument(
        "--prompt",
        default=DEFAULT_PROMPT,
        help="User prompt to send to the served adapter",
    )
    args = parser.parse_args()

    if args.manifest:
        model_name, adapter_path = load_manifest(Path(args.manifest))
    else:
        if not args.model or not args.adapter_path:
            parser.error("Provide either --manifest or both --model and --adapter-path")
        model_name, adapter_path = args.model, args.adapter_path

    base_url = f"http://{args.host}:{args.port}"
    command = [
        sys.executable,
        "-m",
        "mlx_lm",
        "server",
        "--model",
        model_name,
        "--adapter-path",
        adapter_path,
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--max-tokens",
        str(args.max_tokens),
    ]

    print("Starting MLX server:")
    print(" ", " ".join(command))
    proc = subprocess.Popen(
        command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True
    )

    try:
        models = wait_for_server(base_url, args.timeout)
        print("Server models:")
        print(json.dumps(models, indent=2))

        payload = {
            "model": model_name,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a Babylon trading agent. Reply concisely in 2-4 sentences.",
                },
                {
                    "role": "user",
                    "content": args.prompt,
                },
            ],
            "temperature": 0.0,
            "max_tokens": args.max_tokens,
        }
        completion = request_json(f"{base_url}/v1/chat/completions", payload)
        print("Completion:")
        print(json.dumps(completion, indent=2))
        return 0
    except (TimeoutError, ValueError, URLError) as exc:
        print(f"Demo failed: {exc}", file=sys.stderr)
        return 1
    finally:
        terminate_process(proc)


if __name__ == "__main__":
    raise SystemExit(main())
