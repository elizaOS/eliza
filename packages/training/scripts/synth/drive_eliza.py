"""Drive a running milady/eliza agent through scenarios to capture trajectories.

Architecture:
    drive_eliza.py
        ↓ HTTP POST /api/benchmark/message
    eliza benchmark server (started by `startBenchmarkServer()` in
        eliza/packages/app-core/src/benchmark/server.ts)
        ↓ runs the FULL agent pipeline:
            shouldRespond → context_routing → action_planner → response
        ↓ each model call writes to the trajectory_collector service
        ↓ trajectory-export-cron flushes to JSONL per-task
    ~/.milady/training-datasets/<date>/{
        should_respond_trajectories.jsonl,
        context_routing_trajectories.jsonl,
        action_planner_trajectories.jsonl,
        response_trajectories.jsonl,
        media_description_trajectories.jsonl,
    }

The output JSONL has the canonical nubilio `{messages: [system, user, model]}`
shape — the same format the gold-standard nubilio-trajectories use.

Usage:
    # 1. Start the eliza benchmark server (separate process):
    cd /home/shaw/milady && bun run --cwd packages/app-core src/benchmark/server.ts

    # 2. Run this driver:
    .venv/bin/python scripts/synth/drive_eliza.py \\
        --scenarios scripts/synth/scenarios/all.jsonl \\
        --base-url http://localhost:7777 \\
        --token "$ELIZA_BENCH_TOKEN" \\
        --concurrency 4 \\
        --max-scenarios 200000

    # 3. After the run, the trajectory-export-cron will flush JSONL.
    #    Or trigger immediately:
    curl -X POST localhost:7777/api/benchmark/diagnostics \\
        -H "Authorization: Bearer $ELIZA_BENCH_TOKEN"
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random
import sys
import time
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("drive_eliza")


def load_scenarios(path: Path) -> list[dict[str, Any]]:
    """Read JSONL of scenarios. Each line:
        {
          "task_id": "lifeops.brush-teeth-basic.direct",  // unique id
          "benchmark": "synth-eliza",                     // groups sessions
          "user_text": "did you brush your teeth this morning?",
          "context": {                                    // optional
            "channel": "dm" | "group",
            "available_actions": ["REPLY", "IGNORE", "TASK_CALL"],
            "memory": [{"role":"user","content":"..."}, ...],
          }
        }
    """
    out = []
    with path.open() as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError as e:
                log.warning("scenario %d: %s", i, e)
    log.info("loaded %d scenarios from %s", len(out), path)
    return out


async def post_message(
    session, base_url: str, token: str, scenario: dict[str, Any],
    timeout_s: float = 60.0,
) -> dict[str, Any]:
    """POST one scenario. Returns the eliza response payload (or raises)."""
    payload = {
        "text": scenario["user_text"],
        "context": {
            "benchmark": scenario.get("benchmark", "synth-eliza"),
            "taskId": scenario.get("task_id", str(uuid.uuid4())),
            **(scenario.get("context") or {}),
        },
    }
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    async with session.post(
        f"{base_url.rstrip('/')}/api/benchmark/message",
        json=payload, headers=headers, timeout=timeout_s,
    ) as resp:
        if resp.status >= 400:
            body = await resp.text()
            raise RuntimeError(f"HTTP {resp.status}: {body[:300]}")
        return await resp.json()


async def worker(
    worker_id: int, queue: asyncio.Queue, base_url: str, token: str,
    stats: dict[str, int],
):
    import aiohttp
    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        while True:
            scenario = await queue.get()
            if scenario is None:
                break
            t0 = time.time()
            try:
                _ = await post_message(session, base_url, token, scenario)
                stats["ok"] += 1
                if stats["ok"] % 50 == 0:
                    log.info(
                        "[w%d] %d ok, %d fail, last=%.1fs",
                        worker_id, stats["ok"], stats["fail"], time.time() - t0,
                    )
            except Exception as e:
                stats["fail"] += 1
                if stats["fail"] <= 5 or stats["fail"] % 50 == 0:
                    log.warning("[w%d] %s", worker_id, str(e)[:200])
            finally:
                queue.task_done()


async def run(
    scenarios: list[dict[str, Any]],
    *, base_url: str, token: str, concurrency: int,
) -> dict[str, int]:
    queue: asyncio.Queue = asyncio.Queue(maxsize=concurrency * 8)
    stats = {"ok": 0, "fail": 0}

    # Reset the bench server state once at start so we get a clean session.
    import aiohttp
    async with aiohttp.ClientSession() as session:
        try:
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            async with session.post(
                f"{base_url.rstrip('/')}/api/benchmark/reset", headers=headers,
            ) as r:
                log.info("reset bench server: %s", r.status)
        except Exception as e:
            log.warning("reset failed (continuing): %s", e)

    workers = [
        asyncio.create_task(worker(i, queue, base_url, token, stats))
        for i in range(concurrency)
    ]

    t0 = time.time()
    for sc in scenarios:
        await queue.put(sc)
    for _ in range(concurrency):
        await queue.put(None)
    await queue.join()
    for w in workers:
        await w
    elapsed = time.time() - t0

    log.info(
        "done in %.1fs — %d ok, %d fail, %.2f scenarios/s",
        elapsed, stats["ok"], stats["fail"],
        stats["ok"] / max(1.0, elapsed),
    )
    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenarios", type=Path, required=True,
                    help="JSONL of scenarios to drive through the agent")
    ap.add_argument("--base-url", type=str,
                    default=os.environ.get("ELIZA_BENCH_URL", "http://localhost:7777"))
    ap.add_argument("--token", type=str,
                    default=os.environ.get("ELIZA_BENCH_TOKEN", ""))
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--max-scenarios", type=int, default=0,
                    help="cap input scenarios (0 = all)")
    ap.add_argument("--shuffle", action="store_true",
                    help="shuffle scenarios before dispatch")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    scenarios = load_scenarios(args.scenarios)
    if args.shuffle:
        rng = random.Random(args.seed)
        rng.shuffle(scenarios)
    if args.max_scenarios:
        scenarios = scenarios[:args.max_scenarios]

    if not scenarios:
        log.error("no scenarios loaded — check %s", args.scenarios)
        return 1

    log.info(
        "driving %d scenarios @ concurrency=%d → %s",
        len(scenarios), args.concurrency, args.base_url,
    )

    try:
        stats = asyncio.run(run(
            scenarios,
            base_url=args.base_url, token=args.token,
            concurrency=args.concurrency,
        ))
    except KeyboardInterrupt:
        log.warning("interrupted")
        return 130
    return 0 if stats["fail"] < len(scenarios) // 10 else 1


if __name__ == "__main__":
    sys.exit(main())
