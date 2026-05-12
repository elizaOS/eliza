"""Vast.ai PyWorker for Eliza-1-27B NEO-CODE GGUF on a single RTX 5090.

Vast.ai Serverless deploys this worker by setting `PYWORKER_REPO` on the
template; on cold start the host clones the repo, runs `onstart.sh` to fetch
the GGUF and launch `llama-server`, then runs `python worker.py`. The worker
fronts the local llama.cpp server and forwards OpenAI-compatible
`/v1/chat/completions` requests, while reporting per-request workload back to
the Vast Serverless Engine so its autoscaler can size the endpoint.

This file is intentionally small. The control loop (queue, autoscale,
load balancer) lives on Vast's side; eliza/cloud routes requests by hitting
the endpoint URL via `VastProvider`.

Why llama.cpp instead of vLLM:
- The default served model is a Q6_K GGUF from
  `elizaos/eliza-1-27b-fp8`.
- vLLM's GGUF support is experimental and slow; llama.cpp's server is the
  native, well-tuned path for k-quants on consumer Blackwell.
- `llama-server` exposes OpenAI-compatible `/v1/chat/completions`,
  `/v1/completions`, and `/v1/models` so the PyWorker just proxies through.
"""

import os

from vastai_sdk import (
    BenchmarkConfig,
    HandlerConfig,
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


def workload_for_chat_request(payload: dict) -> float:
    """Approximate per-request work in tokens.

    The Vast autoscaler uses these values to compare per-worker capacity
    against incoming load. We charge `max_tokens` (default 512) so caps
    smoothly bound the upper estimate; real per-request cost is
    re-measured by the benchmark step on cold start.
    """
    requested = payload.get("max_tokens")
    if isinstance(requested, (int, float)) and requested > 0:
        return float(requested)
    return 512.0


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


def main() -> None:
    """Start the PyWorker against the local llama-server.

    `onstart.sh` is responsible for:
      - downloading the GGUF (HuggingFace `MODEL_REPO` + `MODEL_FILE`)
      - launching `llama-server --alias "$MODEL_ALIAS" -ngl 99 -c 32768
        --port 8080 --host 127.0.0.1 --parallel "$LLAMA_PARALLEL"`
      - tee'ing stdout/stderr to /var/log/llama-server.log

    PyWorker connects to that local server, watches the log for readiness,
    and proxies traffic to it.
    """
    config = WorkerConfig(
        model_server_port=LLAMA_SERVER_PORT,
        model_log_file=LLAMA_SERVER_LOG,
        handlers=[
            HandlerConfig(
                route="/v1/chat/completions",
                allow_parallel_requests=True,
                workload_calculator=workload_for_chat_request,
                max_queue_time=60.0,
                benchmark_config=CHAT_BENCHMARK,
            ),
            HandlerConfig(
                route="/v1/completions",
                allow_parallel_requests=True,
                workload_calculator=workload_for_chat_request,
                max_queue_time=60.0,
            ),
        ],
    )

    Worker(config).run()


if __name__ == "__main__":
    main()
