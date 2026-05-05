#!/usr/bin/env python3
"""
Run Red/Blue/Gray team continuous RL training.

3 team models (Qwen3.5-4B each), 10 agents per team = 30 agents total.
Each team's agents share one model. All experiences per tick train the shared model.
Kondo gate filters to the most informative experiences.

With mock bridge (no external services):
    python scripts/run_team_rl.py --mock --ticks 20

With live Babylon bridge:
    python scripts/run_team_rl.py --bridge-url http://localhost:3001 --ticks 100

On Nebius H100 (recommended):
    python scripts/run_team_rl.py --model Qwen/Qwen3.5-4B --agents-per-team 10 --ticks 100
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import random
import sys
from pathlib import Path

import torch

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(PYTHON_ROOT))

from src.training.simulation_bridge import (
    ActionOutcome,
    MarketState,
    NewsItem,
    PerpMarket,
    PredictionMarket,
    Scenario,
    SimulationBridge,
    SocialContext,
    TickResult,
)
from src.training.team_rl import (
    TeamConfig,
    TeamRLConfig,
    run_team_training,
)
from src.training.verifiable_game import VerifiableGameBridge

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("team-rl")


# ─── Mock Bridge (for testing without game server) ──────────────────────────


class MockTeamBridge:
    """Mock bridge with adversarial dynamics between red/blue/gray teams."""

    def __init__(self, seed: int = 42):
        self.rng = random.Random(seed)
        self.tick_number = 0
        self.npc_ids = []
        self.archetypes = {}
        self.balances = {}
        self.markets = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def initialize(self, num_npcs=30, seed=42, archetypes=None):
        self.npc_ids = [f"npc_{i:03d}" for i in range(num_npcs)]
        arch = archetypes or ["gray"] * num_npcs
        for i, npc_id in enumerate(self.npc_ids):
            self.archetypes[npc_id] = arch[i % len(arch)]
            self.balances[npc_id] = 10000.0
        self.markets = self._gen_markets()
        return {"status": "initialized", "npcIds": self.npc_ids}

    def _gen_markets(self):
        return [
            {
                "id": f"m{i}",
                "question": q,
                "yes_price": round(self.rng.uniform(0.2, 0.8), 2),
                "no_price": 0.0,
            }
            for i, q in enumerate(
                [
                    "Will BTC exceed $100K?",
                    "Will ETH 2.0 yield > 5%?",
                    "Will Fed cut rates?",
                    "Will AI regulation pass?",
                    "Will gold hit ATH?",
                    "Will DeFi TVL double?",
                ]
            )
        ]

    async def get_scenario(self, npc_id):
        return Scenario(
            npc_id=npc_id,
            archetype=self.archetypes.get(npc_id, "gray"),
            market_state=MarketState(
                perp_markets=[
                    PerpMarket(
                        "BTC",
                        round(60000 + self.rng.gauss(0, 2000), 2),
                        round(self.rng.gauss(0, 3), 2),
                        1e7,
                    ),
                    PerpMarket(
                        "ETH",
                        round(3000 + self.rng.gauss(0, 200), 2),
                        round(self.rng.gauss(0, 4), 2),
                        5e6,
                    ),
                ],
                prediction_markets=[
                    PredictionMarket(
                        m["id"], m["question"], m["yes_price"], round(1 - m["yes_price"], 2)
                    )
                    for m in self.markets[:3]
                ],
            ),
            positions=[],
            balance=self.balances.get(npc_id, 10000),
            recent_news=[
                NewsItem(
                    self.rng.choice(
                        [
                            "Bitcoin ETF inflows hit record",
                            "Fed signals caution",
                            "Major DeFi hack reported",
                            "Institutional crypto adoption up",
                            "Suspicious whale activity detected",
                            "New scam targeting traders",
                        ]
                    ),
                    self.rng.choice(["CoinDesk", "Bloomberg", "Reuters"]),
                    "2026-04-02T12:00:00Z",
                )
            ],
            social_context=SocialContext(),
        )

    async def execute_action(
        self,
        npc_id,
        action_type,
        ticker=None,
        market_id=None,
        amount=None,
        side=None,
        position_id=None,
        reasoning=None,
    ):
        if action_type == "wait":
            return ActionOutcome(False, 0.0, self.balances.get(npc_id, 10000), [], {}, [])

        team = self.archetypes.get(npc_id, "gray")
        roll = self.rng.random()

        # Team-specific reward distributions
        if team == "red":
            # Red team: occasional big wins from manipulation, frequent small losses
            if roll < 0.15:
                pnl = round(self.rng.uniform(100, 400), 2)
            elif roll < 0.4:
                pnl = round(self.rng.uniform(-50, 50), 2)
            else:
                pnl = round(self.rng.uniform(-200, -20), 2)
        elif team == "blue":
            # Blue team: steady moderate gains, rare losses from missed opportunities
            if roll < 0.3:
                pnl = round(self.rng.uniform(30, 150), 2)
            elif roll < 0.7:
                pnl = round(self.rng.uniform(-10, 30), 2)
            else:
                pnl = round(self.rng.uniform(-100, -10), 2)
        else:
            # Gray team: standard trading distribution
            if roll < 0.1:
                pnl = round(self.rng.uniform(150, 350), 2)
            elif roll < 0.4:
                pnl = round(self.rng.uniform(10, 80), 2)
            elif roll < 0.7:
                pnl = round(self.rng.gauss(0, 15), 2)
            else:
                pnl = round(self.rng.uniform(-150, -10), 2)

        self.balances[npc_id] = self.balances.get(npc_id, 10000) + pnl
        social = {}
        if roll < 0.2:
            social = {"reputation_delta": 1 + (1 if team == "blue" else 0)}

        return ActionOutcome(True, pnl, self.balances[npc_id], [], social, [])

    async def tick(self):
        self.tick_number += 1
        for m in self.markets:
            m["yes_price"] = max(0.05, min(0.95, m["yes_price"] + self.rng.gauss(0, 0.05)))
        return TickResult(self.tick_number, [{"type": "update"}], [])


# ─── Main ────────────────────────────────────────────────────────────────────


async def main_async(args):
    device = args.device
    logger.info("=" * 70)
    logger.info("TEAM-BASED CONTINUOUS RL TRAINING")
    logger.info("=" * 70)
    logger.info(f"Model: {args.model} | Teams: red/blue/gray x {args.agents_per_team}")
    logger.info(f"Total agents: {args.agents_per_team * 3} | Ticks: {args.ticks}")
    logger.info(f"Kondo gate rate: {args.kondo_rate} | Device: {device}")
    logger.info("=" * 70)

    config = TeamRLConfig(
        model_name=args.model,
        device=device,
        teams=[
            TeamConfig("red", num_agents=args.agents_per_team, learning_rate=args.lr),
            TeamConfig("blue", num_agents=args.agents_per_team, learning_rate=args.lr),
            TeamConfig("gray", num_agents=args.agents_per_team, learning_rate=args.lr),
        ],
        apollo_rank=args.apollo_rank,
        kondo_gate_rate=args.kondo_rate,
        ticks=args.ticks,
        log_every=args.log_every,
        checkpoint_dir=args.checkpoint_dir,
        checkpoint_every=args.checkpoint_every,
        bridge_url=args.bridge_url,
        game_seed=args.seed,
    )

    if args.mock:
        # Use VerifiableGameBridge: deterministic rewards correlated with action quality
        bridge = VerifiableGameBridge(
            num_npcs=args.agents_per_team * 3,
            seed=args.seed,
        )
        await bridge.initialize(
            num_npcs=args.agents_per_team * 3,
            archetypes=["red"] * args.agents_per_team
            + ["blue"] * args.agents_per_team
            + ["gray"] * args.agents_per_team,
        )
    else:
        bridge = SimulationBridge(args.bridge_url)
        await bridge.__aenter__()

    try:
        result = await run_team_training(config, bridge)
    finally:
        if not args.mock:
            await bridge.__aexit__(None, None, None)

    # Print results
    print("\n" + "=" * 70)
    print("FINAL RESULTS")
    print("=" * 70)
    print(
        f"{'Team':<8} {'Exp':>6} {'Backward':>10} {'Skipped':>8} {'Rate':>8} {'Reward':>10} {'Delight':>10}"
    )
    print("-" * 70)
    for tn, stats in result["team_stats"].items():
        bt = stats["backward"] + stats["skipped"]
        rate = stats["backward"] / bt if bt > 0 else 0
        print(
            f"{tn:<8} {stats['experiences']:>6} {stats['backward']:>10} "
            f"{stats['skipped']:>8} {rate:>7.0%} {stats['mean_reward']:>10.4f} "
            f"{stats['cumulative_delight']:>10.2f}"
        )
    print("=" * 70)

    if device == "cuda":
        print(f"GPU memory: {torch.cuda.memory_allocated() / 1e9:.2f} GB")

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, default=str))
    logger.info(f"Results: {out}")


def main():
    parser = argparse.ArgumentParser(description="Team-based continuous RL")
    parser.add_argument("--model", default="Qwen/Qwen3-4B")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--agents-per-team", type=int, default=10)
    parser.add_argument("--ticks", type=int, default=50)
    parser.add_argument("--lr", type=float, default=5e-6)
    parser.add_argument("--apollo-rank", type=int, default=128)
    parser.add_argument("--kondo-rate", type=float, default=0.1)
    parser.add_argument("--log-every", type=int, default=5)
    parser.add_argument("--checkpoint-dir", default="./team_rl_checkpoints")
    parser.add_argument("--checkpoint-every", type=int, default=25)
    parser.add_argument("--bridge-url", default="http://localhost:3001")
    parser.add_argument("--mock", action="store_true", help="Use mock bridge (no game server)")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", default="team_rl_results.json")
    args = parser.parse_args()

    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
