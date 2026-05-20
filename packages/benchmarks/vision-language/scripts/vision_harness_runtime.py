#!/usr/bin/env python
"""One-shot vision-language bridge for external vision harness clients."""

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
    if harness in {"elizaos", "opencode"}:
        return _ElizaCodeAgentVisionClient(
            adapter=harness,
            provider=provider,
            model=model,
            timeout_s=timeout_s,
        )
    raise ValueError(f"unsupported vision harness: {harness!r}")


class _ElizaCodeAgentVisionClient:
    def __init__(self, *, adapter: str, provider: str, model: str, timeout_s: float):
        self.adapter = adapter
        self.provider = provider
        self.model = model
        self.timeout_s = timeout_s
        self._manager = None

    def reset(self, *, task_id: str, benchmark: str) -> None:
        self.task_id = task_id
        self.benchmark = benchmark

    def _start(self):
        if self._manager is not None:
            return self._manager
        root = _repo_root()
        for relative in (
            "packages/benchmarks/eliza-adapter",
            "packages/benchmarks/hermes-adapter",
            "packages/benchmarks/openclaw-adapter",
            "packages",
        ):
            path = str(root / relative)
            if path not in sys.path:
                sys.path.insert(0, path)
        import os

        os.environ["BENCHMARK_TASK_AGENT"] = self.adapter
        os.environ["BENCHMARK_MODEL_PROVIDER"] = self.provider
        os.environ["BENCHMARK_MODEL_NAME"] = self.model
        os.environ.setdefault("ELIZA_AGENT_ORCHESTRATOR", "1")
        os.environ.setdefault("ELIZA_AGENT_SELECTION_STRATEGY", "fixed")
        os.environ.setdefault("ELIZA_ACP_DEFAULT_AGENT", self.adapter)
        os.environ.setdefault("ELIZA_DEFAULT_AGENT_TYPE", self.adapter)
        os.environ.setdefault("ELIZA_BENCH_HTTP_TIMEOUT", str(int(self.timeout_s)))
        os.environ.setdefault("ELIZA_BENCH_START_TIMEOUT", "300")

        from eliza_adapter import ElizaServerManager  # type: ignore

        self._manager = ElizaServerManager(timeout=300.0, repo_root=root)
        self._manager.start()
        self._manager.client.reset(task_id=self.task_id, benchmark=self.benchmark)
        return self._manager

    def send_message(self, question: str, context: dict[str, Any]):
        manager = self._start()
        return manager.client.send_message(question, context=context)


def _repo_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "packages" / "benchmarks" / "eliza-adapter").exists():
            return parent
    raise FileNotFoundError("Could not locate repository root from vision harness runtime")


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
