"""Own the native runtime lifecycle for code-agent workload launchers."""

import os
import sys
from pathlib import Path

from .client import MessageResponse
from .server_manager import ElizaServerManager


def run_code_agent_task(*, adapter: str, provider: str, model: str, timeout_seconds: int,
                        prompt: str, context: dict[str, object]) -> MessageResponse:
    for harness in ("hermes", "openclaw"):
        path = str(Path(__file__).resolve().parents[2] / harness)
        if path not in sys.path:
            sys.path.insert(0, path)
    settings = {
        "BENCHMARK_TASK_AGENT": adapter,
        "BENCHMARK_MODEL_PROVIDER": provider,
        "BENCHMARK_MODEL_NAME": model,
        "ELIZA_AGENT_ORCHESTRATOR": "1",
        "ELIZA_AGENT_SELECTION_STRATEGY": "fixed",
        "ELIZA_ACP_DEFAULT_AGENT": adapter,
        "ELIZA_DEFAULT_AGENT_TYPE": adapter,
        "ELIZA_BENCH_HTTP_TIMEOUT": str(timeout_seconds),
    }
    previous = {key: os.environ.get(key) for key in settings}
    manager = None
    try:
        # Delegated harnesses also read these settings when their client is constructed.
        os.environ.update(settings)
        manager = ElizaServerManager(timeout=300.0)
        manager.start()
        manager.client.reset(task_id=str(context["task_id"]), benchmark=str(context["benchmark"]))
        return manager.client.send_message(prompt, context=context)
    finally:
        try:
            if manager is not None:
                manager.stop()
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
