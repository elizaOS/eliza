#!/usr/bin/env python
"""One-shot vision-language bridge for external vision harness clients."""

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


def _eliza_state_dir() -> Path:
    explicit = os.environ.get("ELIZA_STATE_DIR") or os.environ.get("MILADY_STATE_DIR")
    if explicit:
        return Path(explicit).expanduser()
    ns = os.environ.get("ELIZA_NAMESPACE") or "eliza"
    return Path.home() / f".{ns}"


def _resolve_mtmd_binary() -> str:
    explicit = os.environ.get("LOCAL_ELIZA_VLM_BIN")
    if explicit:
        return explicit
    root = _eliza_state_dir() / "local-inference" / "bin"
    default = root / "dflash" / "darwin-arm64-metal-fused" / "llama-mtmd-cli"
    if default.is_file():
        return str(default)
    matches = sorted(root.glob("**/llama-mtmd-cli"))
    if matches:
        return str(matches[0])
    raise RuntimeError(f"llama-mtmd-cli not found under {root}")


def _resolve_vlm_models(tier: str) -> tuple[str, str]:
    """Return (text_gguf, mmproj_gguf) for an eliza-1 vision bundle.

    Honors LOCAL_ELIZA_VLM_MODEL / LOCAL_ELIZA_VLM_MMPROJ overrides; otherwise
    resolves from the bundle layout verified for eliza-1 (text/*.gguf +
    vision/mmproj-<slug>.gguf).
    """
    env_text = os.environ.get("LOCAL_ELIZA_VLM_MODEL")
    env_mmproj = os.environ.get("LOCAL_ELIZA_VLM_MMPROJ")
    if env_text and env_mmproj:
        return env_text, env_mmproj
    slug = tier.removeprefix("eliza-1-")
    bundle = _eliza_state_dir() / "local-inference" / "models" / f"{tier}.bundle"
    text_candidates = [
        bundle / "text" / f"eliza-1-{slug}-32k.gguf",
        bundle / "text" / f"eliza-1-{slug}-64k.gguf",
        bundle / "text" / f"eliza-1-{slug}-128k.gguf",
        bundle / "text" / f"eliza-1-{slug}-256k.gguf",
        bundle / "text" / f"eliza-1-{slug}.gguf",
    ]
    text_path = env_text or next((str(p) for p in text_candidates if p.is_file()), "")
    mmproj_path = env_mmproj or str(bundle / "vision" / f"mmproj-{slug}.gguf")
    if not text_path or not Path(text_path).is_file():
        raise RuntimeError(f"no text gguf found for tier {tier!r} under {bundle / 'text'}")
    if not Path(mmproj_path).is_file():
        raise RuntimeError(f"no vision projector found for tier {tier!r}: {mmproj_path}")
    return text_path, mmproj_path


def _parse_mtmd_output(stdout: str) -> str:
    """Strip llama-mtmd-cli's <think> reasoning block and trim whitespace."""
    text = stdout
    if "</think>" in text:
        text = text.rsplit("</think>", 1)[1]
    text = text.replace("<think>", "").strip()
    return text


def _build_mtmd_command(
    *, binary: str, text_model: str, mmproj: str, image_path: str, question: str, max_tokens: int | None
) -> list[str]:
    return [
        binary,
        "-m",
        text_model,
        "--mmproj",
        mmproj,
        "--image",
        image_path,
        "-p",
        question,
        "-n",
        str(max_tokens if max_tokens and max_tokens > 0 else 96),
        "--temp",
        "0.1",
        "--image-min-tokens",
        "1024",
    ]


def _run_local_eliza_vlm(*, tier: str, image_path: str, question: str, max_tokens: int | None) -> str:
    binary = _resolve_mtmd_binary()
    text_model, mmproj = _resolve_vlm_models(tier)
    command = _build_mtmd_command(
        binary=binary,
        text_model=text_model,
        mmproj=mmproj,
        image_path=image_path,
        question=question,
        max_tokens=max_tokens,
    )
    result = subprocess.run(
        command,
        text=True,
        capture_output=True,
        env=os.environ.copy(),
        timeout=900,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"llama-mtmd-cli exited {result.returncode}: {(result.stderr or result.stdout or '')[-1000:]}"
        )
    text = _parse_mtmd_output(result.stdout or "")
    if not text:
        raise RuntimeError(f"local Eliza VLM produced empty output: {(result.stdout or '')[-500:]}")
    return text


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
        # eliza harness drives the local VLM directly through llama-mtmd-cli.
        # Other harnesses (hermes/openclaw) speak OpenAI-compatible HTTP, so we
        # front the CLI with a tiny in-process /v1/chat/completions server.
        if harness in {"eliza", ""}:
            text = _run_local_eliza_vlm(
                tier=model,
                image_path=image_path,
                question=question,
                max_tokens=max_tokens,
            )
            print(
                json.dumps(
                    {"text": text, "latencyMs": (time.monotonic() - started) * 1000.0, "params": {}},
                    ensure_ascii=True,
                    sort_keys=True,
                )
            )
            return 0
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
