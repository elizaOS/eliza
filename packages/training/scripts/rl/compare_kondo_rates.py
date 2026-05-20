#!/usr/bin/env python3
"""
A/B comparison of Kondo gate rates: 3% vs 10% vs 100% (no gate).

Per the paper "Does This Gradient Spark Joy?" (Osband 2026):
  - 3% gate rate matches full training quality with ~30x fewer backward passes
  - The gate selects experiences with high delight = advantage × surprisal
  - Lower gate rates should produce EQUAL or BETTER learning per backward pass

This script runs 3 experiments sequentially on the same model/data:
  1. kondo=0.03 (paper recommendation)
  2. kondo=0.10 (conservative)
  3. kondo=1.00 (no gating, full backward on everything)

Then compares: reward trajectory, delight distribution, compute savings.

Usage:
    python scripts/compare_kondo_rates.py --mock --ticks 30
    python scripts/compare_kondo_rates.py --mock --model Qwen/Qwen3-4B --ticks 50
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path

import torch

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(PYTHON_ROOT))

from src.training.team_rl import (
    AGENT_NAMES,
    TeamConfig,
    TeamModel,
    TeamRLConfig,
    compute_reward,
    parse_action,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("kondo-compare")

# Import the mock bridge from run_team_rl
sys.path.insert(0, str(SCRIPT_DIR))
from run_team_rl import MockTeamBridge


async def run_experiment(
    label: str,
    kondo_rate: float,
    model_name: str,
    device: str,
    ticks: int,
    agents_per_team: int,
    seed: int,
) -> dict:
    """Run one experiment with a given Kondo gate rate."""
    logger.info(f"\n{'=' * 60}")
    logger.info(f"EXPERIMENT: {label} (kondo_rate={kondo_rate})")
    logger.info(f"{'=' * 60}")

    config = TeamRLConfig(
        model_name=model_name,
        device=device,
        teams=[
            TeamConfig("red", num_agents=agents_per_team, learning_rate=5e-6),
            TeamConfig("blue", num_agents=agents_per_team, learning_rate=5e-6),
            TeamConfig("gray", num_agents=agents_per_team, learning_rate=5e-6),
        ],
        kondo_gate_rate=kondo_rate,
        kondo_hard=True,
        apollo_rank=128,
        ticks=ticks,
        log_every=max(1, ticks // 5),
    )

    # Build teams
    teams = {}
    for tc in config.teams:
        team = TeamModel(tc, config)
        team.setup()
        teams[tc.name] = team

    mem = torch.cuda.memory_allocated() / 1e9 if device == "cuda" else 0
    logger.info(f"GPU memory: {mem:.2f} GB")

    # Build mock bridge with SAME seed for fair comparison
    bridge = MockTeamBridge(seed=seed)
    total_agents = agents_per_team * 3
    archetypes = ["red"] * agents_per_team + ["blue"] * agents_per_team + ["gray"] * agents_per_team
    await bridge.initialize(num_npcs=total_agents, archetypes=archetypes)

    # Assign NPCs
    assignments = {}
    idx = 0
    for tc in config.teams:
        names = AGENT_NAMES[tc.name]
        for i in range(tc.num_agents):
            npc_id = bridge.npc_ids[idx]
            assignments[npc_id] = (tc.name, names[i % len(names)])
            idx += 1

    # Track per-tick metrics
    tick_history = []
    t0 = time.time()

    for tick in range(1, ticks + 1):
        tick_start = time.time()
        experiences = {tn: [] for tn in teams}

        for npc_id, (team_name, agent_name) in assignments.items():
            team = teams[team_name]
            try:
                scenario = await bridge.get_scenario(npc_id)
                resp, input_ids, output_ids = team.generate_action(agent_name, scenario)
                action = parse_action(resp) or {"action": "wait"}
                outcome = await bridge.execute_action(
                    npc_id=npc_id,
                    action_type=action.get("action", "wait"),
                    ticker=action.get("ticker"),
                    amount=action.get("amount"),
                    side=action.get("side") or action.get("direction"),
                )
                reward = compute_reward(action, outcome, scenario)
                experiences[team_name].append(
                    {
                        "input_ids": input_ids,
                        "output_ids": output_ids,
                        "reward": reward,
                        "agent_name": agent_name,
                    }
                )
            except Exception as e:
                logger.warning(f"[{team_name}/{agent_name}] error: {e}")

        # Train each team
        tick_data = {"tick": tick}
        for tn, team in teams.items():
            if experiences[tn]:
                metrics = team.train_on_batch(experiences[tn])
                tick_data[tn] = metrics

        await bridge.tick()
        tick_time = time.time() - tick_start
        tick_data["time"] = tick_time
        tick_history.append(tick_data)

        if tick % config.log_every == 0 or tick == 1:
            parts = [f"tick {tick}/{ticks} ({tick_time:.1f}s)"]
            for tn, tm in teams.items():
                s = tm.get_stats()
                bt = s["backward"] + s["skipped"]
                rate = s["backward"] / bt if bt > 0 else 0
                parts.append(
                    f"{tn}: bk={rate:.0%} r={s['mean_reward']:.3f} d={s['cumulative_delight']:.1f}"
                )
            logger.info("  " + " | ".join(parts))

    total_time = time.time() - t0

    # Aggregate stats
    result = {
        "label": label,
        "kondo_rate": kondo_rate,
        "ticks": ticks,
        "agents_per_team": agents_per_team,
        "total_time": round(total_time, 1),
        "time_per_tick": round(total_time / ticks, 1),
        "teams": {},
    }
    for tn, tm in teams.items():
        s = tm.get_stats()
        result["teams"][tn] = s

    # Clean up GPU memory
    for team in teams.values():
        del team.model
        del team.optimizer
    del teams
    if device == "cuda":
        torch.cuda.empty_cache()

    return result


async def main_async(args):
    experiments = [
        ("kondo_3pct", 0.03),
        ("kondo_10pct", 0.10),
        ("no_gate", 1.0),
    ]

    logger.info("=" * 70)
    logger.info("KONDO GATE RATE COMPARISON")
    logger.info(f"Model: {args.model} | Agents/team: {args.agents_per_team} | Ticks: {args.ticks}")
    logger.info(f"Experiments: {', '.join(f'{label}({rate})' for label, rate in experiments)}")
    logger.info("=" * 70)

    results = []
    for label, rate in experiments:
        result = await run_experiment(
            label=label,
            kondo_rate=rate,
            model_name=args.model,
            device=args.device,
            ticks=args.ticks,
            agents_per_team=args.agents_per_team,
            seed=args.seed,
        )
        results.append(result)

    # ── Comparison table ─────────────────────────────────────────────
    print("\n" + "=" * 90)
    print("KONDO GATE RATE COMPARISON RESULTS")
    print("=" * 90)
    print(
        f"{'Experiment':<15} {'Rate':>6} {'Time':>7} {'s/tick':>7} | {'Team':>5} {'Exp':>5} {'Bkwd':>5} {'Skip':>5} {'Bk%':>5} {'Reward':>8} {'Delight':>8}"
    )
    print("-" * 90)

    for r in results:
        first = True
        for tn, s in r["teams"].items():
            bt = s["backward"] + s["skipped"]
            rate = s["backward"] / bt if bt > 0 else 0
            if first:
                print(
                    f"{r['label']:<15} {r['kondo_rate']:>5.0%} {r['total_time']:>6.0f}s {r['time_per_tick']:>6.1f}s | "
                    f"{tn:>5} {s['experiences']:>5} {s['backward']:>5} {s['skipped']:>5} {rate:>4.0%} "
                    f"{s['mean_reward']:>8.4f} {s['cumulative_delight']:>8.1f}"
                )
                first = False
            else:
                print(
                    f"{'':>15} {'':>6} {'':>7} {'':>7} | "
                    f"{tn:>5} {s['experiences']:>5} {s['backward']:>5} {s['skipped']:>5} {rate:>4.0%} "
                    f"{s['mean_reward']:>8.4f} {s['cumulative_delight']:>8.1f}"
                )
        print()

    # ── Summary ──────────────────────────────────────────────────────
    print("=" * 90)
    print("SUMMARY")
    print("-" * 90)
    for r in results:
        total_exp = sum(s["experiences"] for s in r["teams"].values())
        total_bk = sum(s["backward"] for s in r["teams"].values())
        total_skip = sum(s["skipped"] for s in r["teams"].values())
        avg_reward = sum(s["mean_reward"] for s in r["teams"].values()) / len(r["teams"])
        total_delight = sum(s["cumulative_delight"] for s in r["teams"].values())
        bt = total_bk + total_skip
        bk_rate = total_bk / bt if bt > 0 else 0
        compute_saved = 1.0 - bk_rate

        print(
            f"  {r['label']:<15}: backward={bk_rate:>4.0%} | "
            f"compute_saved={compute_saved:>4.0%} | "
            f"reward={avg_reward:>7.4f} | "
            f"delight={total_delight:>7.1f} | "
            f"time={r['total_time']:.0f}s"
        )
    print("=" * 90)

    # Save
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2, default=str))
    logger.info(f"Results: {out}")


def main():
    parser = argparse.ArgumentParser(description="Compare Kondo gate rates")
    parser.add_argument("--model", default="Qwen/Qwen3-4B")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--agents-per-team", type=int, default=5)
    parser.add_argument("--ticks", type=int, default=30)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--mock", action="store_true", default=True)
    parser.add_argument("--output", default="kondo_comparison.json")
    args = parser.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
