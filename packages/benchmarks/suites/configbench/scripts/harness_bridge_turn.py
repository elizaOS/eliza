#!/usr/bin/env python3
"""Single-turn ConfigBench bridge into the canonical benchmark clients."""

from __future__ import annotations

import json
import sys

import os

from eliza_adapter.client import ElizaClient
from eliza_adapter.server_manager import ElizaServerManager


def main() -> int:
    payload = json.loads(sys.stdin.read() or "{}")
    if not isinstance(payload, dict):
        raise SystemExit("expected JSON object on stdin")
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
        client.reset(
            str(context.get("task_id") or "configbench"),
            "configbench",
        )
        response = client.send_message(prompt, context=context)
        sys.stdout.write(
            json.dumps(
                {
                    "text": response.text,
                    "thought": response.thought,
                    "actions": response.actions,
                    "params": response.params,
                },
                ensure_ascii=True,
                sort_keys=True,
            )
            + "\n"
        )
    finally:
        if manager is not None:
            manager.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
