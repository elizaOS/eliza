"""Vast.ai PyWorker for Qwen3.6-35B-A3B (AWQ INT4) on a single RTX 5090.

Vast.ai Serverless deploys this worker by setting `PYWORKER_REPO` on the
template; on cold start the host clones the repo and runs `python worker.py`.
The worker fronts a vLLM server (started by the template) and forwards
OpenAI-compatible `/v1/chat/completions` requests, while reporting per-request
workload back to the Vast Serverless Engine so its autoscaler can size the
endpoint.

This file is intentionally small. The control loop (queue, autoscale,
load balancer) lives on Vast's side; eliza/cloud routes requests by hitting
the endpoint URL via `VastProvider`.
"""

from vastai_sdk import (
    BenchmarkConfig,
    HandlerConfig,
    Worker,
    WorkerConfig,
)


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
        "model": "QuantTrio/Qwen3.6-35B-A3B-AWQ",
        "messages": [
            {"role": "user", "content": "Write one short sentence about the moon."}
        ],
        "max_tokens": 128,
    },
    runs=8,
    concurrency=4,
)


def main() -> None:
    """Start the PyWorker against the local vLLM server.

    The template is responsible for launching:
        vllm serve QuantTrio/Qwen3.6-35B-A3B-AWQ \\
            --host 127.0.0.1 --port 8000 \\
            --quantization awq --max-model-len 32768

    PyWorker connects to that local server, watches the log for readiness,
    and proxies traffic to it.
    """
    config = WorkerConfig(
        model_server_port=8000,
        model_log_file="/var/log/vllm.log",
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
