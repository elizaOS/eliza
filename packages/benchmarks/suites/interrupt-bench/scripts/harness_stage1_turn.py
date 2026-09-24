#!/usr/bin/env python3
"""Single Stage-1 InterruptBench turn through the benchmark harness clients."""

from __future__ import annotations

import json
import os
import sys
import time

from eliza_adapter.client import ElizaClient
from eliza_adapter.server_manager import ElizaServerManager


def _parse_payload() -> dict:
    data = json.loads(sys.stdin.read() or "{}")
    if not isinstance(data, dict):
        raise SystemExit("expected JSON object on stdin")
    return data


def main() -> int:
    payload = _parse_payload()
    prompt = str(payload.get("prompt") or "")
    context = payload.get("context")
    if not isinstance(context, dict):
        context = {}
    manager: ElizaServerManager | None = None
    harness = (
        os.environ.get("BENCHMARK_HARNESS")
        or os.environ.get("ELIZA_BENCH_HARNESS")
        or ""
    ).strip().lower()
    try:
        if harness == "eliza" and (
            not os.environ.get("ELIZA_BENCH_URL")
            or not os.environ.get("ELIZA_BENCH_TOKEN")
        ):
            manager = ElizaServerManager()
            manager.start()
            client = manager.client
        else:
            client = ElizaClient()
        client.reset(str(context.get("task_id") or "interrupt-bench"), "interrupt_bench")
        started = time.monotonic()
        response = client.send_message(prompt, context=context)
        latency_ms = int((time.monotonic() - started) * 1000)
        print(
            json.dumps(
                {
                    "text": response.text,
                    "thought": response.thought,
                    "actions": response.actions,
                    "params": response.params,
                    "latency_ms": latency_ms,
                },
                ensure_ascii=True,
                sort_keys=True,
            )
        )
    finally:
        if manager is not None:
            manager.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
