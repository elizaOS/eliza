#!/usr/bin/env python
"""One-shot vision-language bridge for Hermes/OpenClaw harness clients."""

from __future__ import annotations

import base64
import json
import mimetypes
import sys
import time
from pathlib import Path
from typing import Any


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


def _client(harness: str, provider: str, model: str, timeout_s: float):
    if harness == "hermes":
        from hermes_adapter.client import HermesClient

        return HermesClient(
            provider=provider,
            model=model,
            mode="in_process",
            timeout_s=timeout_s,
        )
    if harness == "openclaw":
        from openclaw_adapter.client import OpenClawClient

        return OpenClawClient(
            provider=provider,
            model=model,
            direct_openai_compatible=True,
            timeout_s=timeout_s,
        )
    raise ValueError(f"unsupported vision harness: {harness!r}")


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
