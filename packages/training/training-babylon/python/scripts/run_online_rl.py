#!/usr/bin/env python3
"""
Run online continuous RL training with multiple agents in a shared Babylon game.

RECOMMENDED: Use --mode shared for single shared model training (replaces team_rl):
    python scripts/run_online_rl.py --mode shared --mock --ticks 50

Legacy single agent:
    python scripts/run_online_rl.py --mode single --bridge-url http://localhost:3001

Legacy multi-agent with population-based training:
    python scripts/run_online_rl.py --mode multi --num-agents 4 --pbt

Full setup (APOLLO + Kondo 3% + TurboQuant):
    python scripts/run_online_rl.py \\
        --mode shared --agents-per-team 10 \\
        --optimizer apollo --kondo --kondo-gate-rate 0.03 \\
        --turboquant --mock
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

# Ensure training package is importable
SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(PYTHON_ROOT))

from src.training.continuous_rl import (
    ContinuousRLAgent,
    ContinuousRLConfig,
    run_online_training,
)
from src.training.multi_agent_orchestrator import (
    MultiAgentOrchestrator,
    OrchestratorConfig,
)
from src.training.shared_model_rl import (
    SharedModelConfig,
    run_shared_model_training,
)
from src.training.simulation_bridge import SimulationBridge

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("online-rl")


async def run_single_agent(args: argparse.Namespace) -> None:
    """Run a single agent in online training mode."""
    config = ContinuousRLConfig(
        model_name=args.model,
        device=args.device,
        optimizer=args.optimizer,
        learning_rate=args.lr,
        apollo_rank=args.apollo_rank,
        apollo_scale=args.apollo_scale,
        apollo_update_proj_gap=args.apollo_update_proj_gap,
        use_kondo=args.kondo,
        kondo_gate_rate=args.kondo_gate_rate,
        kondo_price=args.kondo_price,
        kondo_temperature=args.kondo_temperature,
        kondo_hard=not args.kondo_soft,
        kondo_deterministic=not args.kondo_stochastic,
        use_turboquant=args.turboquant,
        turboquant_key_bits=args.turboquant_key_bits,
        turboquant_value_bits=args.turboquant_value_bits,
        turboquant_residual_length=args.turboquant_residual,
        checkpoint_dir=args.checkpoint_dir,
        checkpoint_every=args.checkpoint_every,
        bridge_url=args.bridge_url,
        agent_archetype=args.archetype,
    )

    agent = ContinuousRLAgent("agent_000", config)
    agent.setup()

    async with SimulationBridge(args.bridge_url) as bridge:
        await bridge.initialize(num_npcs=args.num_npcs, seed=args.seed)
        npc_id = bridge.npc_ids[0]

        stats = await run_online_training(
            agent=agent,
            bridge=bridge,
            npc_id=npc_id,
            max_ticks=args.max_ticks,
            log_every=args.log_every,
        )

    logger.info(f"Training complete: {json.dumps(stats, indent=2)}")


async def run_multi_agent(args: argparse.Namespace) -> None:
    """Run multiple agents with population-based training."""
    archetypes = (
        args.archetypes.split(",")
        if args.archetypes
        else [
            "trader",
            "analyst",
            "degen",
            "influencer",
        ]
    )

    config = OrchestratorConfig(
        num_agents=args.num_agents,
        model_name=args.model,
        agent_archetypes=archetypes,
        device_map=args.device_map.split(",") if args.device_map else "auto",
        optimizer=args.optimizer,
        learning_rate=args.lr,
        apollo_rank=args.apollo_rank,
        apollo_scale=args.apollo_scale,
        apollo_update_proj_gap=args.apollo_update_proj_gap,
        use_kondo=args.kondo,
        kondo_gate_rate=args.kondo_gate_rate,
        use_turboquant=args.turboquant,
        turboquant_key_bits=args.turboquant_key_bits,
        turboquant_value_bits=args.turboquant_value_bits,
        bridge_url=args.bridge_url,
        num_npcs=args.num_npcs,
        game_seed=args.seed,
        ticks_per_epoch=args.ticks_per_epoch,
        num_epochs=args.num_epochs,
        log_every=args.log_every,
        pbt_enabled=args.pbt,
        pbt_interval=args.pbt_interval,
        pbt_replace_fraction=args.pbt_replace_fraction,
        checkpoint_dir=args.checkpoint_dir,
        checkpoint_every=args.checkpoint_every,
        shared_checkpoint_dir=args.shared_checkpoint_dir,
    )

    orchestrator = MultiAgentOrchestrator(config)
    report = await orchestrator.run()

    # Write report
    output_path = Path(args.checkpoint_dir) / "orchestrator_report.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2, default=str))
    logger.info(f"Report saved to {output_path}")


async def run_shared_model(args: argparse.Namespace) -> None:
    """Run shared-model training: all teams share one model with intent-aware rewards."""
    config = SharedModelConfig(
        model_name=args.model,
        device=args.device,
        agents_per_team=args.agents_per_team,
        optimizer=args.optimizer,
        learning_rate=args.lr,
        apollo_rank=args.apollo_rank,
        use_kondo=args.kondo,
        kondo_gate_rate=args.kondo_gate_rate,
        kondo_hard=not args.kondo_soft,
        kondo_deterministic=not args.kondo_stochastic,
        use_turboquant=args.turboquant,
        turboquant_key_bits=args.turboquant_key_bits,
        turboquant_value_bits=args.turboquant_value_bits,
        turboquant_residual_length=args.turboquant_residual,
        ticks=args.max_ticks if args.max_ticks > 0 else 100,
        log_every=args.log_every,
        checkpoint_dir=args.checkpoint_dir,
        checkpoint_every=args.checkpoint_every,
        bridge_url=args.bridge_url,
        game_seed=args.seed,
    )

    if hasattr(args, "mock") and args.mock:
        from run_shared_model_rl import MockSharedBridge

        bridge = MockSharedBridge(seed=args.seed)
    else:
        bridge = SimulationBridge(args.bridge_url)

    async with bridge:
        results = await run_shared_model_training(config, bridge)

    stats = results["final_stats"]
    logger.info(
        f"Shared model training complete: "
        f"experiences={stats['total_experiences']} "
        f"backward_rate={stats['backward_rate']:.1%} "
        f"mean_reward={stats['mean_reward']:.4f}"
    )

    output_path = Path(args.checkpoint_dir) / "shared_model_results.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(results, indent=2, default=str))
    logger.info(f"Results saved to {output_path}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run online continuous RL training for Babylon agents",
    )

    parser.add_argument(
        "--mode",
        choices=["single", "multi", "shared"],
        default="shared",
        help="single agent, multi-agent with PBT, or shared model (recommended)",
    )

    # Model
    parser.add_argument("--model", default="Qwen/Qwen3.5-4B")
    parser.add_argument("--device", default="cuda")

    # Optimizer
    parser.add_argument(
        "--optimizer",
        choices=["adamw", "apollo"],
        default="apollo",
        help="APOLLO for full-param continuous RL (recommended)",
    )
    parser.add_argument("--lr", type=float, default=5e-6)
    parser.add_argument("--apollo-rank", type=int, default=128)
    parser.add_argument("--apollo-scale", type=float, default=32.0)
    parser.add_argument("--apollo-update-proj-gap", type=int, default=200)

    # Kondo gate
    parser.add_argument("--kondo", action="store_true", help="Enable Kondo gate")
    parser.add_argument("--kondo-gate-rate", type=float, default=0.03)
    parser.add_argument("--kondo-price", type=float, default=None)
    parser.add_argument("--kondo-temperature", type=float, default=0.1)
    parser.add_argument("--kondo-soft", action="store_true")
    parser.add_argument("--kondo-stochastic", action="store_true")

    # TurboQuant
    parser.add_argument("--turboquant", action="store_true", help="Enable TurboQuant KV cache")
    parser.add_argument("--turboquant-key-bits", type=float, default=3.5)
    parser.add_argument("--turboquant-value-bits", type=float, default=3.5)
    parser.add_argument("--turboquant-residual", type=int, default=128)

    # Game
    parser.add_argument("--bridge-url", default="http://localhost:3001")
    parser.add_argument("--num-npcs", type=int, default=20)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--archetype", default="trader", help="Agent archetype (single mode)")

    # Training
    parser.add_argument("--max-ticks", type=int, default=0, help="Max ticks (0=unlimited)")
    parser.add_argument("--log-every", type=int, default=10)

    # Multi-agent
    parser.add_argument("--num-agents", type=int, default=4)
    parser.add_argument("--archetypes", default="", help="Comma-separated archetypes")
    parser.add_argument("--device-map", default="", help="Comma-separated devices")
    parser.add_argument("--ticks-per-epoch", type=int, default=100)
    parser.add_argument("--num-epochs", type=int, default=0, help="0=unlimited")

    # PBT
    parser.add_argument("--pbt", action="store_true", help="Enable population-based training")
    parser.add_argument("--pbt-interval", type=int, default=50)
    parser.add_argument("--pbt-replace-fraction", type=float, default=0.25)

    # Checkpointing
    parser.add_argument("--checkpoint-dir", default="./online_rl_checkpoints")
    parser.add_argument("--checkpoint-every", type=int, default=100)
    parser.add_argument("--shared-checkpoint-dir", default="")

    # Shared model options
    parser.add_argument(
        "--agents-per-team", type=int, default=10, help="Agents per team (shared mode)"
    )
    parser.add_argument("--mock", action="store_true", help="Use mock bridge (shared mode)")

    args = parser.parse_args()

    if args.mode == "shared":
        asyncio.run(run_shared_model(args))
    elif args.mode == "single":
        asyncio.run(run_single_agent(args))
    else:
        asyncio.run(run_multi_agent(args))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
