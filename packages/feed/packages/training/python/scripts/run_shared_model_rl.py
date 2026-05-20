#!/usr/bin/env python3
"""
Run shared-model continuous RL training.

All agents (red/blue/gray) share a single model. Kondo gate at 3% selects
the most informative experiences for gradient updates. Intent-aware rewards
use counterparty ground-truth alignment for proper credit assignment.

Usage:
    # With mock bridge (local testing, no game server needed)
    python scripts/run_shared_model_rl.py --mock --ticks 20

    # With live game server
    python scripts/run_shared_model_rl.py --bridge-url http://localhost:3001 --ticks 100

    # Custom configuration
    python scripts/run_shared_model_rl.py --model Qwen/Qwen3-4B --agents-per-team 15 \\
        --kondo-rate 0.03 --ticks 200 --mock
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import random
import sys
from pathlib import Path

# Add parent paths — use the python package root, not src/
_script_dir = Path(__file__).resolve().parent
_pkg_root = _script_dir.parent
if str(_pkg_root) not in sys.path:
    sys.path.insert(0, str(_pkg_root))

from src.training.shared_model_rl import (
    BabylonCRLConfig,
    SharedModelConfig,
    run_babylon_crl,
    run_shared_model_training,
)
from src.training.simulation_bridge import (
    ActionOutcome,
    MarketState,
    PerpMarket,
    PredictionMarket,
    Scenario,
    SimulationBridge,
    SocialContext,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("shared_model_rl")


# ---- Mock Bridge for Testing -------------------------------------------------


class MockSharedBridge:
    """
    Mock simulation bridge for testing shared-model RL without a game server.

    Simulates cross-team interactions with intent-aware reward signals.
    Red agents get occasional big rewards from manipulation.
    Blue agents get rewards for skepticism and defense.
    Gray agents get standard trading returns.
    """

    def __init__(self, seed: int = 42):
        self._rng = random.Random(seed)
        self._npc_ids: list[str] = []
        self._archetypes: list[str] = []
        self._tick: int = 0
        self._initialized = False

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    @property
    def npc_ids(self) -> list[str]:
        return self._npc_ids

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def initialize(
        self,
        num_npcs: int,
        seed: int = 42,
        archetypes: list[str] | None = None,
    ) -> None:
        self._rng = random.Random(seed)
        self._npc_ids = [f"npc_{i}" for i in range(num_npcs)]
        self._archetypes = archetypes or ["gray"] * num_npcs
        self._initialized = True
        self._tick = 0

    async def get_scenario(self, npc_id: str) -> Scenario:
        idx = self._npc_ids.index(npc_id) if npc_id in self._npc_ids else 0
        team = self._archetypes[idx] if idx < len(self._archetypes) else "gray"
        balance = 10000 + self._rng.gauss(0, 500)

        perp_markets = [
            PerpMarket(
                ticker=t,
                current_price=100 + self._rng.gauss(0, 10),
                change_percent_24h=self._rng.gauss(0, 3),
                volume_24h=self._rng.uniform(1e5, 1e7),
            )
            for t in ["BTC", "ETH", "SOL"]
        ]
        pred_markets = [
            PredictionMarket(
                id=f"m{i}",
                question=f"Will event {i} happen?",
                yes_price=self._rng.uniform(0.2, 0.8),
                no_price=1 - self._rng.uniform(0.2, 0.8),
            )
            for i in range(3)
        ]

        # Simulate cross-team interactions in scenario context
        other_agents = [nid for nid in self._npc_ids if nid != npc_id]
        recent_msg_from = self._rng.choice(other_agents) if other_agents else None

        return Scenario(
            npc_id=npc_id,
            archetype=team,
            market_state=MarketState(
                perp_markets=perp_markets,
                prediction_markets=pred_markets,
            ),
            positions=[],
            balance=balance,
            recent_news=[],
            social_context=SocialContext(
                relationships=[],
                group_chats=[],
                recent_messages=[f"Message from {recent_msg_from}: interested in trading?"]
                if recent_msg_from
                else [],
            ),
        )

    async def execute_action(
        self,
        npc_id: str,
        action_type: str,
        ticker: str | None = None,
        market_id: str | None = None,
        amount: float | None = None,
        side: str | None = None,
        position_id: str | None = None,
        reasoning: str | None = None,
    ) -> ActionOutcome:
        idx = self._npc_ids.index(npc_id) if npc_id in self._npc_ids else 0
        team = self._archetypes[idx] if idx < len(self._archetypes) else "gray"

        if action_type == "wait":
            return ActionOutcome(
                success=True,
                pnl=0.0,
                new_balance=10000.0,
                new_positions=[],
                social_impact=None,
                events=[],
                error=None,
            )

        # Team-dependent reward distributions
        if team == "red":
            pnl = self._rng.gauss(20, 80)  # Higher variance, occasional big wins
            social_impact = {
                "likes_received": self._rng.randint(0, 3),
                "replies_received": self._rng.randint(0, 2),
                "reputation_delta": self._rng.gauss(0.5, 2.0),
            }
        elif team == "blue":
            pnl = self._rng.gauss(10, 30)  # Steady moderate gains
            social_impact = {
                "likes_received": self._rng.randint(0, 5),
                "replies_received": self._rng.randint(0, 3),
                "reputation_delta": self._rng.gauss(1.0, 1.0),
            }
        else:
            pnl = self._rng.gauss(5, 50)  # Standard trading
            social_impact = {
                "likes_received": self._rng.randint(0, 4),
                "replies_received": self._rng.randint(0, 2),
                "reputation_delta": self._rng.gauss(0.2, 1.5),
            }

        success = self._rng.random() > 0.1
        return ActionOutcome(
            success=success,
            pnl=pnl if success else 0.0,
            new_balance=10000.0 + pnl,
            new_positions=[],
            social_impact=social_impact if success else None,
            events=[],
            error="Action failed" if not success else None,
        )

    async def tick(self) -> None:
        self._tick += 1


# ---- Main --------------------------------------------------------------------


async def main_async(args: argparse.Namespace) -> None:
    # ── Babylon CRL mode: model serves via vLLM, Babylon drives agents ──
    if args.babylon:
        crl_config = BabylonCRLConfig(
            model_name=args.model,
            device=args.device,
            agents_per_team=args.agents_per_team,
            optimizer=args.optimizer,
            learning_rate=args.lr,
            apollo_rank=args.apollo_rank,
            use_kondo=True,
            kondo_gate_rate=args.kondo_rate,
            kondo_hard=True,
            kondo_deterministic=True,
            use_turboquant=not args.no_turboquant,
            ticks=args.ticks,
            log_every=args.log_every,
            checkpoint_dir=args.checkpoint_dir,
            checkpoint_every=args.checkpoint_every,
            game_seed=args.seed,
            babylon_url=args.babylon_url,
            poll_interval=args.poll_interval,
            min_batch_size=args.min_batch,
            vllm_port=args.vllm_port,
            vllm_gpu_utilization=args.vllm_gpu_util,
            reload_every_n_steps=args.reload_every,
        )
        logger.info("=" * 70)
        logger.info("BABYLON CRL MODE")
        logger.info(f"Model: {args.model} | vLLM port: {args.vllm_port}")
        logger.info(f"Babylon: {args.babylon_url} | Poll: {args.poll_interval}s")
        logger.info("=" * 70)
        results = await run_babylon_crl(crl_config)

        print("\n" + "=" * 70)
        print("BABYLON CRL RESULTS")
        print("=" * 70)
        print(f"Training steps: {results['train_steps']}")
        stats = results.get("final_stats", {})
        print(f"Total experiences: {stats.get('total_experiences', 0)}")
        print(f"Backward rate: {stats.get('backward_rate', 0):.1%}")

        output_path = args.output
        with open(output_path, "w") as f:
            json.dump(results, f, indent=2, default=str)
        print(f"\nResults: {output_path}")
        return

    # ── Standard mode: Python drives agents via SimulationBridge ──────
    # Parse training teams filter
    training_teams = None
    if hasattr(args, "training_teams") and args.training_teams:
        training_teams = [t.strip() for t in args.training_teams.split(",")]

    config = SharedModelConfig(
        model_name=args.model,
        device=args.device,
        agents_per_team=args.agents_per_team,
        optimizer=args.optimizer,
        learning_rate=args.lr,
        apollo_rank=args.apollo_rank,
        use_kondo=True,
        kondo_gate_rate=args.kondo_rate,
        kondo_hard=True,
        kondo_deterministic=True,
        use_turboquant=not args.no_turboquant,
        ticks=args.ticks,
        log_every=args.log_every,
        checkpoint_dir=args.checkpoint_dir,
        checkpoint_every=args.checkpoint_every,
        bridge_url=args.bridge_url,
        game_seed=args.seed,
        training_teams=training_teams,
    )

    if args.mock:
        bridge = MockSharedBridge(seed=args.seed)
        logger.info("Using mock bridge (no game server)")
    else:
        bridge = SimulationBridge(base_url=args.bridge_url)

    async with bridge:
        results = await run_shared_model_training(config, bridge)

    # Print summary
    print("\n" + "=" * 70)
    print("SHARED MODEL TRAINING RESULTS")
    print("=" * 70)

    stats = results["final_stats"]
    print(f"\nModel: {config.model_name}")
    print(f"Total agents: {config.total_agents} ({config.agents_per_team} per team)")
    print(f"Ticks: {config.ticks}")
    print(f"Kondo gate rate: {config.kondo_gate_rate}")
    print(f"Optimizer: {config.optimizer}")
    print("\nOverall:")
    print(f"  Experiences: {stats['total_experiences']}")
    print(f"  Backward passes: {stats['total_backward']}")
    print(f"  Backward rate: {stats['backward_rate']:.1%}")
    print(f"  Mean reward: {stats['mean_reward']:.4f}")
    print(f"  Cumulative delight: {stats['cumulative_delight']:.2f}")

    print("\nPer-team breakdown:")
    for team, ts in stats["teams"].items():
        print(
            f"  {team:5s}: exp={ts['experiences']:4d} "
            f"bk={ts['backward_rate']:.0%} "
            f"r={ts['mean_reward']:.4f}"
        )

    if "reward_distributions" in results:
        print("\nReward distributions:")
        for team, rd in results["reward_distributions"].items():
            print(
                f"  {team:5s}: mean={rd['mean']:.4f} "
                f"std={rd['stdev']:.4f} "
                f"[{rd['min']:.3f}, {rd['max']:.3f}]"
            )

    # Save results
    output_path = args.output
    with open(output_path, "w") as f:
        # Convert non-serializable values
        def serialize(obj):
            if isinstance(obj, (float,)) and (obj != obj):  # NaN
                return None
            return obj

        json.dump(results, f, indent=2, default=str)
    print(f"\nResults saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Shared-model continuous RL training",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--model", default="Qwen/Qwen3.5-9B", help="Model name (9B for Nebius H100)")
    parser.add_argument("--device", default="cuda", help="Device (cuda/cpu)")
    parser.add_argument("--agents-per-team", type=int, default=10, help="Agents per team")
    parser.add_argument("--optimizer", default="apollo", choices=["apollo", "adamw"])
    parser.add_argument("--lr", type=float, default=5e-6, help="Learning rate")
    parser.add_argument("--apollo-rank", type=int, default=128)
    parser.add_argument("--kondo-rate", type=float, default=0.03, help="Kondo gate rate (3%%)")
    parser.add_argument("--ticks", type=int, default=50, help="Training ticks")
    parser.add_argument("--log-every", type=int, default=5)
    parser.add_argument("--checkpoint-dir", default="./shared_model_checkpoints")
    parser.add_argument("--checkpoint-every", type=int, default=25)
    parser.add_argument("--bridge-url", default="http://localhost:3001")
    parser.add_argument("--mock", action="store_true", help="Use mock bridge")
    parser.add_argument("--no-turboquant", action="store_true", help="Disable TurboQuant")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", default="shared_model_results.json")
    parser.add_argument(
        "--training-teams",
        default="",
        help="Comma-separated teams that update weights (e.g. 'red' or 'blue' or 'red,blue'). "
        "Empty = all teams (shared model). Other teams still act as opponents.",
    )

    # Babylon CRL mode (Nebius deployment)
    parser.add_argument(
        "--babylon",
        action="store_true",
        help="Babylon CRL mode: serve via vLLM, train from Babylon trajectories",
    )
    parser.add_argument(
        "--babylon-url",
        default="http://localhost:3000",
        help="Babylon web app URL for trajectory export",
    )
    parser.add_argument(
        "--poll-interval", type=float, default=30.0, help="Seconds between trajectory polls"
    )
    parser.add_argument(
        "--min-batch", type=int, default=10, help="Min trajectories before training"
    )
    parser.add_argument("--vllm-port", type=int, default=8000, help="vLLM server port")
    parser.add_argument(
        "--vllm-gpu-util", type=float, default=0.35, help="vLLM GPU memory utilization (0-1)"
    )
    parser.add_argument(
        "--reload-every", type=int, default=5, help="Restart vLLM every N training steps"
    )

    args = parser.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
