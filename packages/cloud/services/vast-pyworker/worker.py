"""Vast.ai PyWorker for Eliza-1-27B NEO-CODE GGUF on a single RTX 5090.

Vast.ai Serverless deploys this worker by setting `PYWORKER_REPO` on the
template; on cold start the host clones the repo, runs `onstart.sh` to fetch
the GGUF and launch `llama-server`, then runs `python worker.py`. The worker
fronts the local llama.cpp server and forwards OpenAI-compatible
`/v1/chat/completions` requests, while reporting per-request workload back to
the Vast Serverless Engine so its autoscaler can size the endpoint.

This file is intentionally small. The control loop (queue, autoscale,
load balancer) lives on Vast's side; Eliza Cloud routes requests by hitting
the endpoint URL via `VastProvider`.

Why llama.cpp instead of vLLM:
- The default served model is a Q4_K_M GGUF from
  `elizaos/eliza-1` (subpath `bundles/27b/text/`).
- vLLM's GGUF support is experimental and slow; llama.cpp's server is the
  native, well-tuned path for k-quants on consumer Blackwell.
- `llama-server` exposes OpenAI-compatible `/v1/chat/completions`,
  `/v1/completions`, and `/v1/models` so the PyWorker just proxies through.
"""

import math
import os
from typing import Any

from vastai_sdk import (
    BenchmarkConfig,
    HandlerConfig,
    LogActionConfig,
    Worker,
    WorkerConfig,
)

# Catalog id (set by onstart.sh via --alias on llama-server). The cloud
# `VastProvider` forwards this exact id; llama-server echoes it back in
# the response `model` field.
MODEL_ALIAS = os.environ.get("MODEL_ALIAS", "vast/eliza-1-27b")

# llama-server defaults to port 8080; onstart.sh keeps that.
LLAMA_SERVER_PORT = int(os.environ.get("LLAMA_SERVER_PORT", "8080"))

# Log file the worker tails for the readiness signal. llama-server prints
# `main: server is listening on http://...` once /v1 is live.
LLAMA_SERVER_LOG = os.environ.get("LLAMA_SERVER_LOG", "/var/log/llama-server.log")
MAX_QUEUE_TIME_SECONDS = float(os.environ.get("VAST_WORKER_MAX_QUEUE_TIME", "60"))


def _text_token_estimate(value: Any) -> float:
    """Walk the whole input without copying/serializing or truncating it.

    Token-ID arrays already have a known token count. Other structured input
    includes its keys: schema property names and tool-call arguments are part
    of the model-facing context too. An explicit stack avoids a recursion cap.
    """
    tokens = 0.0
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, str):
            tokens += max(1.0, len(item) / 4.0)
        elif isinstance(item, list):
            if all(
                isinstance(token, int) and not isinstance(token, bool) for token in item
            ):
                tokens += len(item)
            else:
                pending.extend(item)
        elif isinstance(item, dict):
            pending.extend(item.keys())
            pending.extend(item.values())
        elif isinstance(item, (int, float)) and not isinstance(item, bool):
            tokens += max(1.0, len(str(item)) / 4.0)
    return tokens


def _requested_output_tokens(payload: dict) -> float:
    for field in ("max_completion_tokens", "max_tokens"):
        requested = payload.get(field)
        if (
            isinstance(requested, (int, float))
            and not isinstance(requested, bool)
            and math.isfinite(requested)
            and requested >= 0
        ):
            return float(requested)
    return float(os.environ.get("VAST_WORKER_DEFAULT_MAX_TOKENS", "512"))


def _positive_count(value: Any) -> int:
    return (
        value
        if isinstance(value, int) and not isinstance(value, bool) and value > 0
        else 1
    )


MODEL_CONTROL_FIELDS = frozenset(
    {
        "model",
        "stream",
        "stream_options",
        "max_tokens",
        "max_completion_tokens",
        "n",
        "best_of",
        "temperature",
        "top_p",
        "top_k",
        "min_p",
        "seed",
        "presence_penalty",
        "frequency_penalty",
        "repetition_penalty",
        "logprobs",
        "top_logprobs",
        "echo",
        "user",
    }
)


def workload_for_chat_request(payload: dict) -> float:
    """Approximate per-request work in tokens.

    The Vast autoscaler uses these values to compare per-worker capacity
    against incoming load. Estimate both prompt and output work so long-context
    requests and tool-heavy prompts scale differently from short chats.
    """
    # Exclude transport/sampling controls, then count every remaining field.
    # This includes full messages (tool_calls/function_call), tool schemas,
    # structured-output constraints and Eliza model-facing extension fields.
    prompt_tokens = sum(
        _text_token_estimate(value)
        for key, value in payload.items()
        if key not in MODEL_CONTROL_FIELDS
    )
    prompt = payload.get("prompt")
    # A flat token-ID list is one prompt; strings/token lists form a batch.
    batch_size = 1
    if (
        isinstance(prompt, list)
        and prompt
        and not all(
            isinstance(token, int) and not isinstance(token, bool) for token in prompt
        )
    ):
        batch_size = len(prompt)
    candidates = max(
        _positive_count(payload.get("n")), _positive_count(payload.get("best_of"))
    )
    return max(
        128.0,
        prompt_tokens + _requested_output_tokens(payload) * batch_size * candidates,
    )


CHAT_BENCHMARK = BenchmarkConfig(
    generator=lambda: {
        "model": MODEL_ALIAS,
        "messages": [
            {"role": "user", "content": "Write one short sentence about the moon."}
        ],
        "max_tokens": 128,
    },
    runs=8,
    concurrency=4,
)


def worker_config() -> WorkerConfig:
    """Configure the local engine and its log-triggered readiness benchmark."""
    return WorkerConfig(
        model_server_url="http://127.0.0.1",
        model_server_port=LLAMA_SERVER_PORT,
        model_log_file=LLAMA_SERVER_LOG,
        model_healthcheck_url=f"http://127.0.0.1:{LLAMA_SERVER_PORT}/health",
        log_action_config=LogActionConfig(
            on_load=["server is listening on", "Application startup complete."],
            on_error=["failed to load model", "Application startup failed."],
        ),
        handlers=[
            HandlerConfig(
                route="/v1/chat/completions",
                allow_parallel_requests=True,
                workload_calculator=workload_for_chat_request,
                max_queue_time=MAX_QUEUE_TIME_SECONDS,
                benchmark_config=CHAT_BENCHMARK,
            ),
            HandlerConfig(
                route="/v1/completions",
                allow_parallel_requests=True,
                workload_calculator=workload_for_chat_request,
                max_queue_time=MAX_QUEUE_TIME_SECONDS,
            ),
        ],
    )


def main() -> None:
    """Start the PyWorker against the local model server.

    `onstart.sh` is responsible for:
      - downloading the GGUF (HuggingFace `MODEL_REPO` + `MODEL_FILE`)
      - launching `llama-server --alias "$MODEL_ALIAS" -ngl 99 -c 32768
        --port 8080 --host 127.0.0.1 --parallel "$LLAMA_PARALLEL"`
      - tee'ing stdout/stderr to /var/log/llama-server.log

    PyWorker connects to that local server, watches the log for readiness,
    and proxies traffic to it.
    """
    Worker(worker_config()).run()


if __name__ == "__main__":
    main()
