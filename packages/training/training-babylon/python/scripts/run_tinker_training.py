#!/usr/bin/env python3
"""
Babylon Tinker Training Script

Run GRPO training using Tinker API (cloud-based, no local GPU required).

Prerequisites:
1. Set TINKER_API_KEY environment variable
2. Set DATABASE_URL environment variable
3. Set OPENAI_API_KEY for RLAIF judge

Usage:
    python scripts/run_tinker_training.py --steps 100 --model Qwen/Qwen3.5-4B

For help:
    python scripts/run_tinker_training.py --help
"""

import asyncio
import logging
import os
import sys
from pathlib import Path

# Add python root to path for local development
python_root = Path(__file__).parent.parent
sys.path.insert(0, str(python_root))

from src.training.tinker_client import (
    DEFAULT_TINKER_BASE_MODEL,
    TINKER_API_KEY_ENV_VARS,
    ensure_tinker_api_key_env,
)


def check_environment() -> bool:
    """Check required environment variables"""
    missing = []

    if not ensure_tinker_api_key_env():
        missing.append("/".join(TINKER_API_KEY_ENV_VARS))

    if not os.environ.get("DATABASE_URL"):
        missing.append("DATABASE_URL")

    if not os.environ.get("OPENAI_API_KEY"):
        missing.append("OPENAI_API_KEY")

    if missing:
        print("=" * 60)
        print("  MISSING ENVIRONMENT VARIABLES")
        print("=" * 60)
        for var in missing:
            print(f"  - {var}")
        print()
        print("Please set these before running:")
        print("  export TINKER_API_KEY=your_key_here")
        print("  # or export TM_API_KEY=your_key_here")
        print("  # or export THINKINGMACHINES_API_KEY=your_key_here")
        print("  export DATABASE_URL=postgresql://...")
        print("  export OPENAI_API_KEY=sk-...")
        print("=" * 60)
        return False

    return True


async def main() -> int:
    """Main entry point"""
    import argparse

    # Setup logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Babylon Tinker Training",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic training run
  python scripts/run_tinker_training.py --steps 100

  # Use a larger Qwen model
  python scripts/run_tinker_training.py --model Qwen/Qwen3.5-27B

  # Adjust hyperparameters
  python scripts/run_tinker_training.py --lr 1e-5 --group-size 8 --lora-rank 64
        """,
    )

    parser.add_argument(
        "--model",
        default=DEFAULT_TINKER_BASE_MODEL,
        help=f"Base model to train (default: {DEFAULT_TINKER_BASE_MODEL})",
    )
    parser.add_argument(
        "--steps",
        type=int,
        default=100,
        help="Number of training steps (default: 100)",
    )
    parser.add_argument(
        "--group-size",
        type=int,
        default=4,
        help="GRPO group size - trajectories compared per step (default: 4)",
    )
    parser.add_argument(
        "--lr",
        type=float,
        default=4e-5,
        help="Learning rate (default: 4e-5)",
    )
    parser.add_argument(
        "--lora-rank",
        type=int,
        default=32,
        help="LoRA rank (default: 32)",
    )
    parser.add_argument(
        "--weight-sync-interval",
        type=int,
        default=5,
        help="Steps between weight syncs (default: 5)",
    )
    parser.add_argument(
        "--log-file",
        default="./logs/tinker_training_metrics.jsonl",
        help="Metrics log file path",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Check environment without running training",
    )

    args = parser.parse_args()

    # Check environment
    if not check_environment():
        return 1

    if args.dry_run:
        print("\n✓ Environment check passed. Ready to train.")
        return 0

    # Import trainer (after environment check)
    from src.training.tinker_trainer import (
        BabylonTinkerTrainer,
        TinkerTrainingConfig,
    )

    # Create config
    config = TinkerTrainingConfig(
        base_model=args.model,
        training_steps=args.steps,
        group_size=args.group_size,
        learning_rate=args.lr,
        lora_rank=args.lora_rank,
        weight_sync_interval=args.weight_sync_interval,
        database_url=os.environ["DATABASE_URL"],
        log_file=args.log_file,
    )

    # Run training
    print("\n" + "=" * 60)
    print("  BABYLON TINKER TRAINING")
    print("=" * 60)
    print(f"  Model: {config.base_model}")
    print(f"  Steps: {config.training_steps}")
    print(f"  Group size: {config.group_size}")
    print(f"  Learning rate: {config.learning_rate}")
    print(f"  LoRA rank: {config.lora_rank}")
    print("=" * 60 + "\n")

    trainer = BabylonTinkerTrainer(config)
    result = await trainer.train()

    if result.get("success"):
        print("\n" + "=" * 60)
        print("  ✓ TRAINING COMPLETE")
        print("=" * 60)
        print(f"  Run ID: {result['run_id']}")
        print(f"  Steps completed: {result['steps']}")
        print(f"  Windows processed: {result['windows_processed']}")
        print(f"  Final weights: {result['final_weights']}")
        if result.get("metrics_file"):
            print(f"  Metrics: {result['metrics_file']}")
        print("=" * 60)
        return 0
    else:
        print("\n✗ Training failed")
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
