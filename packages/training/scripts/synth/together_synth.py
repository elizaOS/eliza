"""Together-API-direct synth: hit Together with eliza-shaped prompts and
capture (input, output) pairs as synthetic training records.

This is a lower-fidelity alternative to the full eliza-agent pipeline:
- Pro: works without a local LLM, no eliza server, no plugin config
- Con: no agent loop (no shouldRespond → context_routing → planner cascade);
  each scenario gets a single model call

Inputs:  scripts/synth/scenarios/*.jsonl
Outputs: data/synthesized/together-synth/{task_type}_trajectories.jsonl
         in nubilio shape (`{messages: [system, user, model]}`)

Usage:
    TOGETHER_API_KEY=tgp_... .venv/bin/python scripts/synth/together_synth.py \\
        --scenarios scripts/synth/scenarios/all.jsonl \\
        --max 5000 \\
        --concurrency 8 \\
        --model Qwen/Qwen3-235B-A22B-Instruct-2507-tput
"""
from __future__ import annotations

import argparse
import asyncio
import json
from typing import IO
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "data" / "synthesized" / "together-synth"


def system_prompt_for(scenario: dict) -> str:
    """Build a system prompt that mirrors what the eliza planner would see."""
    ctx = scenario.get("context", {})
    actions = ctx.get("available_actions") or ["REPLY", "IGNORE"]
    agent_id = ctx.get("agentId", "agent")
    parts = [
        f"You are {agent_id}, an autonomous elizaOS agent.",
        f"Available actions: {', '.join(actions)}",
        "",
        "Respond with exactly one native JSON document with these keys:",
        "  thought: <your reasoning>",
        "  tool_calls[] <ordered action names>",
        "  providers: <empty or comma-separated list>",
        "  text: <user-facing message>",
        "  simple: <true|false>",
    ]
    return "\n".join(parts)


def user_prompt_for(scenario: dict) -> str:
    ctx = scenario.get("context", {})
    parts = []
    memory = ctx.get("memory", [])
    if memory:
        parts.append("Recent messages:")
        for m in memory[-6:]:
            role = m.get("role", "?")
            content = (m.get("content") or "")[:300]
            parts.append(f"  [{role}] {content}")
        parts.append("")
    parts.append(f"User: {scenario.get('user_text', '')}")
    return "\n".join(parts)


async def call_together(
    client, model: str, scenario: dict, *, semaphore: asyncio.Semaphore,
) -> dict | None:
    async with semaphore:
        sys_p = system_prompt_for(scenario)
        usr_p = user_prompt_for(scenario)
        try:
            resp = await asyncio.to_thread(
                client.chat.completions.create,
                model=model,
                messages=[
                    {"role": "system", "content": sys_p},
                    {"role": "user", "content": usr_p},
                ],
                max_tokens=512,
                temperature=0.7,
            )
            output = resp.choices[0].message.content or ""
        except Exception as e:
            return {"error": str(e)[:200], "task_id": scenario.get("task_id")}
        return {
            "messages": [
                {"role": "system", "content": sys_p},
                {"role": "user", "content": usr_p},
                {"role": "model", "content": output},
            ],
            "task_id": scenario.get("task_id"),
            "task_type": scenario.get("benchmark", "synth").replace("synth-", ""),
        }


async def main_async(args) -> int:
    from together import Together
    client = Together(api_key=os.environ["TOGETHER_API_KEY"])

    scenarios = []
    with args.scenarios.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            scenarios.append(json.loads(line))
    if args.max:
        scenarios = scenarios[:args.max]
    print(f"loaded {len(scenarios):,} scenarios; firing through {args.model}")

    semaphore = asyncio.Semaphore(args.concurrency)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_files: dict[str, IO[str]] = {}

    def get_out_file(task_type: str):
        if task_type not in out_files:
            out_files[task_type] = (OUT_DIR / f"{task_type}_trajectories.jsonl").open("a")
        return out_files[task_type]

    n_ok = n_fail = 0
    t0 = time.time()
    tasks = [call_together(client, args.model, sc, semaphore=semaphore)
             for sc in scenarios]
    for i, task in enumerate(asyncio.as_completed(tasks), 1):
        result = await task
        if result and "error" not in result:
            tt = result.pop("task_type", "synth")
            f = get_out_file(tt)
            f.write(json.dumps(result, ensure_ascii=False) + "\n")
            n_ok += 1
        else:
            n_fail += 1
        if i % 50 == 0:
            elapsed = time.time() - t0
            rate = i / max(0.1, elapsed)
            eta = (len(scenarios) - i) / max(0.01, rate)
            print(f"  [{i}/{len(scenarios)}] ok={n_ok} fail={n_fail} "
                  f"{rate:.1f}/s, ETA {eta/60:.1f} min")

    for f in out_files.values():
        f.close()
    elapsed = time.time() - t0
    print(f"\nDONE — {n_ok} ok, {n_fail} fail in {elapsed/60:.1f} min")
    print(f"output → {OUT_DIR}/")
    return 0 if n_fail < len(scenarios) // 5 else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenarios", type=Path,
                    default=ROOT / "scripts/synth/scenarios/all.jsonl")
    ap.add_argument("--max", type=int, default=0)
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--model", type=str,
                    default="Qwen/Qwen3-235B-A22B-Instruct-2507-tput")
    args = ap.parse_args()

    if not os.environ.get("TOGETHER_API_KEY"):
        print("error: TOGETHER_API_KEY not set", file=sys.stderr)
        return 2
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
