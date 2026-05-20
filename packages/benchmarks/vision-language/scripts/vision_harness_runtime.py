#!/usr/bin/env python
"""One-shot vision-language bridge for Hermes/OpenClaw harness clients."""

from __future__ import annotations

import base64
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
import subprocess
import sys
import time
import tempfile
import threading
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
LOCAL_ELIZA_PROVIDERS = {"local-eliza", "local_eliza", "eliza-local", "eliza_local"}


def _data_url(image_path: str) -> str:
    path = Path(image_path)
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{data}"


def _context(image_path: str, question: str, max_tokens: int | None) -> dict[str, Any]:
    content: list[dict[str, Any]] = [
        {"type": "text", "text": question},
        {"type": "image_url", "image_url": {"url": _data_url(image_path)}},
    ]
    ctx: dict[str, Any] = {
        "benchmark": "vision_language",
        "messages": [{"role": "user", "content": content}],
    }
    if max_tokens and max_tokens > 0:
        ctx["max_tokens"] = int(max_tokens)
    return ctx


def _client(
    harness: str,
    provider: str,
    model: str,
    timeout_s: float,
    *,
    api_key: str | None = None,
    base_url: str | None = None,
):
    if harness == "hermes":
        from hermes_adapter.client import HermesClient

        return HermesClient(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
            mode="in_process",
            timeout_s=timeout_s,
        )
    if harness == "openclaw":
        from openclaw_adapter.client import OpenClawClient

        return OpenClawClient(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
            direct_openai_compatible=True,
            timeout_s=timeout_s,
        )
    raise ValueError(f"unsupported vision harness: {harness!r}")


def _extract_text_and_image(messages: object) -> tuple[str, str]:
    if not isinstance(messages, list):
        return "", ""
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content, ""
        if not isinstance(content, list):
            continue
        text_parts: list[str] = []
        image_url = ""
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                text_parts.append(part["text"])
            elif part.get("type") == "image_url" and isinstance(part.get("image_url"), dict):
                raw_url = part["image_url"].get("url")
                if isinstance(raw_url, str):
                    image_url = raw_url
        return "\n".join(text_parts), image_url
    return "", ""


def _write_image_input(raw_url: str, tmpdir: Path) -> str:
    if raw_url.startswith("data:"):
        header, encoded = raw_url.split(",", 1)
        mime = header[5:].split(";", 1)[0] or "image/png"
        ext = mimetypes.guess_extension(mime) or ".png"
        target = tmpdir / f"input{ext}"
        target.write_bytes(base64.b64decode(encoded))
        return str(target)
    if raw_url.startswith("file://"):
        return raw_url[7:]
    return raw_url


def _run_local_eliza_vlm(*, tier: str, image_path: str, question: str, max_tokens: int | None) -> str:
    script = PACKAGE_ROOT / "scripts" / "local_eliza_vlm.ts"
    payload: dict[str, Any] = {
        "tier": tier,
        "imagePath": image_path,
        "question": question,
    }
    if max_tokens and max_tokens > 0:
        payload["maxTokens"] = max_tokens
    result = subprocess.run(
        ["bun", "run", str(script)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        cwd=str(PACKAGE_ROOT.parents[2]),
        env=os.environ.copy(),
        timeout=900,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout or "local Eliza VLM failed")
    parsed: dict[str, Any] | None = None
    for line in (result.stdout or "").splitlines():
        stripped = line.strip()
        if not stripped.startswith("{"):
            continue
        try:
            candidate = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and "text" in candidate:
            parsed = candidate
            break
    if parsed is None:
        raise RuntimeError(f"local Eliza VLM produced no JSON text line: {result.stdout[-1000:]}")
    text = parsed.get("text")
    return text if isinstance(text, str) else ""


@contextmanager
def _local_eliza_openai_server(tier: str):
    tmp = tempfile.TemporaryDirectory(prefix="vision-local-eliza-")
    tmpdir = Path(tmp.name)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, _fmt: str, *_args: object) -> None:
            return

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if self.path == "/v1/models":
                self._send_json({"object": "list", "data": [{"id": tier, "object": "model"}]})
                return
            self.send_error(404)

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            try:
                if self.path not in {"/v1/chat/completions", "/chat/completions"}:
                    self.send_error(404)
                    return
                length = int(self.headers.get("content-length") or "0")
                body = json.loads(self.rfile.read(length) or b"{}")
                question, image_url = _extract_text_and_image(body.get("messages"))
                if not question or not image_url:
                    raise ValueError("local Eliza VLM requires multimodal user content")
                image_path = _write_image_input(image_url, tmpdir)
                max_tokens = body.get("max_tokens")
                text = _run_local_eliza_vlm(
                    tier=tier,
                    image_path=image_path,
                    question=question,
                    max_tokens=max_tokens if isinstance(max_tokens, int) else None,
                )
                self._send_json(
                    {
                        "id": f"chatcmpl-local-eliza-{int(time.time() * 1000)}",
                        "object": "chat.completion",
                        "created": int(time.time()),
                        "model": tier,
                        "choices": [
                            {
                                "index": 0,
                                "message": {"role": "assistant", "content": text},
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {
                            "prompt_tokens": 0,
                            "completion_tokens": 0,
                            "total_tokens": 0,
                        },
                    }
                )
            except Exception as exc:  # pragma: no cover - exercised by caller failures
                self._send_json({"error": {"message": str(exc), "type": "local_eliza_error"}}, status=500)

        def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
            data = json.dumps(payload, ensure_ascii=True).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        tmp.cleanup()


def main() -> int:
    payload = json.loads(sys.stdin.read() or "{}")
    harness = str(payload.get("harness") or "").strip().lower()
    provider = str(payload.get("provider") or "").strip().lower() or "openai"
    model = str(payload.get("model") or "").strip()
    image_path = str(payload.get("imagePath") or "").strip()
    question = str(payload.get("question") or "").strip()
    max_tokens_raw = payload.get("maxTokens")
    max_tokens = int(max_tokens_raw) if isinstance(max_tokens_raw, int) else None
    timeout_s_raw = payload.get("timeoutSeconds")
    timeout_s = float(timeout_s_raw) if isinstance(timeout_s_raw, (int, float)) else 120.0
    if not model:
        raise ValueError("vision harness runtime requires a model")
    if not image_path or not question:
        raise ValueError("vision harness runtime requires imagePath and question")

    started = time.monotonic()
    if provider in LOCAL_ELIZA_PROVIDERS:
        with _local_eliza_openai_server(model) as base_url:
            client = _client(
                harness,
                "openai",
                model,
                timeout_s,
                api_key="local-eliza",
                base_url=base_url,
            )
            client.reset(task_id=str(payload.get("sampleId") or "sample"), benchmark="vision_language")
            response = client.send_message(question, context=_context(image_path, question, max_tokens))
    else:
        client = _client(harness, provider, model, timeout_s)
        client.reset(task_id=str(payload.get("sampleId") or "sample"), benchmark="vision_language")
        response = client.send_message(question, context=_context(image_path, question, max_tokens))
    result = {
        "text": response.text,
        "latencyMs": (time.monotonic() - started) * 1000.0,
        "params": response.params,
    }
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
