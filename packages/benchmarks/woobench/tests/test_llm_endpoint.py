"""Endpoint resolution for the WooBench judge/persona LLM client.

Covers the operator-override precedence (BENCHMARK_BASE_URL > OPENAI_BASE_URL >
CEREBRAS_BASE_URL > provider default) and drives `_call_llm` end-to-end against
a real localhost HTTP server to prove the resolved base URL and API key are the
ones actually used on the wire.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from packages.benchmarks.woobench.evaluator import (
    WooBenchEvaluator,
    resolve_llm_endpoint,
)

ENDPOINT_ENV_VARS = (
    "BENCHMARK_BASE_URL",
    "OPENAI_BASE_URL",
    "CEREBRAS_BASE_URL",
    "OPENAI_API_KEY",
    "CEREBRAS_API_KEY",
)


@pytest.fixture
def clean_env(monkeypatch):
    for var in ENDPOINT_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    return monkeypatch


def test_benchmark_base_url_wins_over_all(clean_env):
    clean_env.setenv("CEREBRAS_API_KEY", "ck")
    clean_env.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")
    clean_env.setenv("OPENAI_BASE_URL", "https://openai-proxy.example/v1")
    clean_env.setenv("CEREBRAS_BASE_URL", "https://cerebras-proxy.example/v1")
    base_url, api_key = resolve_llm_endpoint()
    assert base_url == "https://elizacloud.ai/api/v1"
    assert api_key == "ck"


def test_openai_base_url_wins_over_cerebras_base_url(clean_env):
    clean_env.setenv("OPENAI_API_KEY", "ok")
    clean_env.setenv("OPENAI_BASE_URL", "https://elizacloud.ai/api/v1")
    clean_env.setenv("CEREBRAS_BASE_URL", "https://cerebras-proxy.example/v1")
    base_url, api_key = resolve_llm_endpoint()
    assert base_url == "https://elizacloud.ai/api/v1"
    assert api_key == "ok"


def test_cerebras_base_url_honored_with_only_cerebras_key(clean_env):
    # The original bug: with only CEREBRAS_API_KEY set, CEREBRAS_BASE_URL was
    # ignored and traffic went straight to api.cerebras.ai.
    clean_env.setenv("CEREBRAS_API_KEY", "ck")
    clean_env.setenv("CEREBRAS_BASE_URL", "https://elizacloud.ai/api/v1")
    base_url, api_key = resolve_llm_endpoint()
    assert base_url == "https://elizacloud.ai/api/v1"
    assert api_key == "ck"


def test_cerebras_default_when_only_cerebras_key_and_no_override(clean_env):
    clean_env.setenv("CEREBRAS_API_KEY", "ck")
    base_url, api_key = resolve_llm_endpoint()
    assert base_url == "https://api.cerebras.ai/v1"
    assert api_key == "ck"


def test_openai_default_when_openai_key_and_no_override(clean_env):
    clean_env.setenv("OPENAI_API_KEY", "ok")
    base_url, api_key = resolve_llm_endpoint()
    assert base_url == "https://api.openai.com/v1"
    assert api_key == "ok"


def test_openai_key_preferred_when_both_keys_set(clean_env):
    clean_env.setenv("OPENAI_API_KEY", "ok")
    clean_env.setenv("CEREBRAS_API_KEY", "ck")
    base_url, api_key = resolve_llm_endpoint()
    assert base_url == "https://api.openai.com/v1"
    assert api_key == "ok"


def test_trailing_slash_stripped(clean_env):
    clean_env.setenv("CEREBRAS_API_KEY", "ck")
    clean_env.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1/")
    base_url, _ = resolve_llm_endpoint()
    assert base_url == "https://elizacloud.ai/api/v1"


def test_whitespace_only_override_treated_as_unset(clean_env):
    clean_env.setenv("CEREBRAS_API_KEY", "ck")
    clean_env.setenv("BENCHMARK_BASE_URL", "   ")
    clean_env.setenv("OPENAI_BASE_URL", "")
    base_url, _ = resolve_llm_endpoint()
    assert base_url == "https://api.cerebras.ai/v1"


def test_missing_keys_raise(clean_env):
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY or CEREBRAS_API_KEY"):
        resolve_llm_endpoint()


class _ChatCompletionsHandler(BaseHTTPRequestHandler):
    """Minimal OpenAI-compatible endpoint recording what actually arrived."""

    requests: list[dict] = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        type(self).requests.append(
            {
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "body": json.loads(body),
            }
        )
        payload = json.dumps(
            {"choices": [{"message": {"content": "POSITIVE"}}]}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        # Keep pytest output clean; request capture happens in do_POST.
        pass


@pytest.fixture
def chat_server():
    _ChatCompletionsHandler.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _ChatCompletionsHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/api/v1"
    finally:
        server.shutdown()
        thread.join()


@pytest.mark.asyncio
async def test_call_llm_hits_benchmark_base_url_on_the_wire(clean_env, chat_server):
    clean_env.setenv("CEREBRAS_API_KEY", "ck-proxy")
    clean_env.setenv("BENCHMARK_BASE_URL", chat_server)
    evaluator = WooBenchEvaluator(evaluator_model="gemma-4-31b")

    result = await evaluator._call_llm("judge this")

    assert result == "POSITIVE"
    assert len(_ChatCompletionsHandler.requests) == 1
    request = _ChatCompletionsHandler.requests[0]
    assert request["path"] == "/api/v1/chat/completions"
    assert request["authorization"] == "Bearer ck-proxy"
    assert request["body"]["model"] == "gemma-4-31b"
    assert request["body"]["messages"] == [{"role": "user", "content": "judge this"}]


@pytest.mark.asyncio
async def test_call_llm_honors_cerebras_base_url_with_only_cerebras_key(
    clean_env, chat_server
):
    clean_env.setenv("CEREBRAS_API_KEY", "ck-proxy")
    clean_env.setenv("CEREBRAS_BASE_URL", chat_server + "/")
    evaluator = WooBenchEvaluator(evaluator_model="gemma-4-31b")

    result = await evaluator._call_llm("judge this too")

    assert result == "POSITIVE"
    assert _ChatCompletionsHandler.requests[0]["path"] == "/api/v1/chat/completions"
    assert _ChatCompletionsHandler.requests[0]["authorization"] == "Bearer ck-proxy"
