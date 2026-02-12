#!/usr/bin/env python3
"""
ElizaOS Tinker Training Script

Run GRPO training using Tinker API (cloud-based, no local GPU required).

Prerequisites:
1. Set TINKER_API_KEY environment variable
2. Set DATABASE_URL environment variable
3. Set OPENAI_API_KEY for RLAIF judge

Usage:
    python scripts/run_tinker_training.py --steps 100 --model Qwen/Qwen3-30B-A3B-Instruct

For help:
    python scripts/run_tinker_training.py --help
"""

import asyncio
import logging
import os
import sys
from pathlib import Path

# Add src to path for local development
src_path = Path(__file__).parent.parent / "src"
sys.path.insert(0, str(src_path))


def check_environment() -> bool:
    """Check required environment variables"""
    missing = []
    
    if not os.environ.get("TINKER_API_KEY"):
        missing.append("TINKER_API_KEY")
    
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
        description="ElizaOS Tinker Training",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic training run
  python scripts/run_tinker_training.py --steps 100
  
  # Use larger model
  python scripts/run_tinker_training.py --model Qwen/Qwen3-235B-A22B-Instruct
  
  # Adjust hyperparameters
  python scripts/run_tinker_training.py --lr 1e-5 --group-size 8 --lora-rank 64
        """,
    )
    
    parser.add_argument(
        "--model",
        default="Qwen/Qwen3-30B-A3B-Instruct",
        help="Base model to train (default: Qwen/Qwen3-30B-A3B-Instruct)",
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
    from training.tinker_trainer import (
        TinkerTrainer,
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
    print("  ELIZAOS TINKER TRAINING")
    print("=" * 60)
    print(f"  Model: {config.base_model}")
    print(f"  Steps: {config.training_steps}")
    print(f"  Group size: {config.group_size}")
    print(f"  Learning rate: {config.learning_rate}")
    print(f"  LoRA rank: {config.lora_rank}")
    print("=" * 60 + "\n")
    
    trainer = TinkerTrainer(config)
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
