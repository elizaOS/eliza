#!/usr/bin/env python3
"""
ElizaOS Full Training Pipeline

Complete end-to-end workflow:
1. Run 10 agents with a 4B model (data generation)
2. Collect and score trajectories
3. Train a 4B model using GRPO from ranked results
4. Benchmark compare base vs trained model

Usage:
    # Full pipeline
    python scripts/run_full_pipeline.py --agents 10 --model Qwen/Qwen3-4B
    
    # Just data generation
    python scripts/run_full_pipeline.py --mode generate --agents 10
    
    # Just training (using existing data)
    python scripts/run_full_pipeline.py --mode train --window-id 2024-01-01T00:00
    
    # Just benchmark
    python scripts/run_full_pipeline.py --mode benchmark --model-a base --model-b trained
"""

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv

# Load environment
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s'
)
logger = logging.getLogger(__name__)


class FullPipeline:
    """
    Complete training pipeline orchestrator.
    
    Manages the full workflow from agent simulation to model training.
    """
    
    def __init__(
        self,
        model_name: str = "Qwen/Qwen3-4B",
        num_agents: int = 10,
        ticks_per_agent: int = 100,
        database_url: Optional[str] = None,
        output_dir: str = "./trained_models",
        use_wandb: bool = True,
    ):
        self.model_name = model_name
        self.num_agents = num_agents
        self.ticks_per_agent = ticks_per_agent
        self.database_url = database_url or os.getenv("DATABASE_URL", "")
        self.output_dir = Path(output_dir)
        self.use_wandb = use_wandb
        
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        # Track results
        self.generated_trajectories = []
        self.scores = []
        self.trained_model_path = None
        self.benchmark_results = {}
    
    async def run_full_pipeline(self):
        """Run the complete pipeline end-to-end"""
        logger.info("=" * 70)
        logger.info("ELIZAOS FULL TRAINING PIPELINE")
        logger.info("=" * 70)
        logger.info(f"Model: {self.model_name}")
        logger.info(f"Agents: {self.num_agents}")
        logger.info(f"Ticks per agent: {self.ticks_per_agent}")
        logger.info(f"Output: {self.output_dir}")
        logger.info("=" * 70)
        
        start_time = time.time()
        
        # Step 1: Generate data
        logger.info("\n" + "=" * 70)
        logger.info("STEP 1: DATA GENERATION")
        logger.info("=" * 70)
        await self.generate_data()
        
        # Step 2: Score trajectories
        logger.info("\n" + "=" * 70)
        logger.info("STEP 2: SCORING")
        logger.info("=" * 70)
        await self.score_trajectories()
        
        # Step 3: Train model
        logger.info("\n" + "=" * 70)
        logger.info("STEP 3: TRAINING")
        logger.info("=" * 70)
        await self.train_model()
        
        # Step 4: Benchmark
        logger.info("\n" + "=" * 70)
        logger.info("STEP 4: BENCHMARK")
        logger.info("=" * 70)
        await self.run_benchmark()
        
        total_time = time.time() - start_time
        
        # Summary
        logger.info("\n" + "=" * 70)
        logger.info("PIPELINE COMPLETE")
        logger.info("=" * 70)
        logger.info(f"Total time: {total_time:.1f}s")
        logger.info(f"Trajectories generated: {len(self.generated_trajectories)}")
        logger.info(f"Trained model: {self.trained_model_path}")
        logger.info("=" * 70)
        
        return {
            "trajectories": len(self.generated_trajectories),
            "trained_model": str(self.trained_model_path) if self.trained_model_path else None,
            "benchmark": self.benchmark_results,
            "total_time": total_time,
        }
    
    async def generate_data(self):
        """
        Generate training data by running agents.
        
        In a full implementation, this would:
        1. Start vLLM with the base model
        2. Run agent simulations
        3. Collect trajectories
        
        For now, this loads existing data from the database.
        """
        if not self.database_url:
            logger.error("No DATABASE_URL configured!")
            logger.error("Set DATABASE_URL environment variable to connect to the database.")
            logger.error("Cannot proceed without real trajectory data.")
            raise ValueError("DATABASE_URL required for training - no synthetic fallback")
        
        from src.data_bridge import PostgresTrajectoryReader
        
        logger.info("Loading trajectories from database...")
        
        try:
            async with PostgresTrajectoryReader(self.database_url) as reader:
                # Get all recent windows (with min_agents=1 to find all)
                windows = await reader.get_window_ids(
                    min_agents=1,
                    lookback_hours=72
                )
                
                if not windows:
                    logger.error("No trajectory windows found in database!")
                    logger.error("Generate real trajectories first:")
                    logger.error("  1. Start server: bun run dev")
                    logger.error("  2. Run your trajectory generation command to collect fresh data")
                    raise ValueError("No trajectory data in database - generate real data first")
                
                logger.info(f"Found {len(windows)} trajectory windows")
                
                # Load trajectories from multiple windows (up to 50)
                all_trajectories = []
                for window_id in windows[:50]:
                    trajectories = await reader.get_trajectories_by_window(
                        window_id,
                        min_actions=1  # Lowered to capture more data
                    )
                    all_trajectories.extend(trajectories)
                    
                    # Stop if we have enough
                    if len(all_trajectories) >= self.num_agents * 2:
                        break
                
                if not all_trajectories:
                    logger.error("No valid trajectories found in database!")
                    logger.error("The trajectories may be corrupted or missing required fields.")
                    logger.error("Generate new real trajectories with your host CLI trajectory command")
                    raise ValueError("No valid trajectory data - generate real data first")
                
                self.generated_trajectories = all_trajectories
                logger.info(f"Loaded {len(all_trajectories)} trajectories from database")
                
        except Exception as e:
            logger.error(f"Failed to load from database: {e}")
            import traceback
            traceback.print_exc()
            raise ValueError(f"Database connection failed: {e}")
    
    async def score_trajectories(self):
        """Score trajectories using heuristics and relative comparison"""
        from src.training import relative_scores, composite_reward
        
        if not self.generated_trajectories:
            logger.warning("No trajectories to score")
            return
        
        logger.info(f"Scoring {len(self.generated_trajectories)} trajectories...")
        
        # Convert trajectories to dict format for scoring
        traj_dicts = [
            {
                "final_pnl": t.final_pnl,
                "episode_length": t.episode_length,
                "trades_executed": t.trades_executed or 0,
                "steps": [
                    {"action": {"success": s.action.success if s.action else False}}
                    for s in t.steps
                ]
            }
            for t in self.generated_trajectories
        ]
        
        # Get relative scores
        self.scores = relative_scores(traj_dicts, reward_fn=composite_reward)
        
        # Log top/bottom performers
        scored = list(zip(self.generated_trajectories, self.scores))
        scored.sort(key=lambda x: x[1], reverse=True)
        
        logger.info("\nTop 3 performers:")
        for traj, score in scored[:3]:
            logger.info(f"  {traj.agent_id}: P&L=${traj.final_pnl:.2f}, Score={score:.3f}")
        
        logger.info("\nBottom 3 performers:")
        for traj, score in scored[-3:]:
            logger.info(f"  {traj.agent_id}: P&L=${traj.final_pnl:.2f}, Score={score:.3f}")
    
    async def train_model(self):
        """Train model using Tinker (cloud) or GRPO (local) from scored trajectories"""
        if not self.generated_trajectories or not self.scores:
            logger.warning("No scored trajectories for training")
            return
        
        logger.info("Preparing training data...")
        
        # Check if Tinker is available
        tinker_api_key = os.getenv("TINKER_API_KEY")
        
        if tinker_api_key:
            # Use Tinker for cloud-based training
            await self._train_with_tinker()
        else:
            # Fall back to local training data preparation
            await self._prepare_local_training_data()
    
    async def _train_with_tinker(self):
        """Train using Tinker cloud API"""
        from src.training.tinker_trainer import TinkerTrainer, TinkerTrainingConfig
        from src.training.tinker_client import TINKER_AVAILABLE
        
        if not TINKER_AVAILABLE:
            logger.warning("Tinker not installed. Install with: pip install tinker")
            logger.info("Falling back to local training data preparation")
            await self._prepare_local_training_data()
            return
        
        logger.info("Using Tinker for cloud-based training")
        
        config = TinkerTrainingConfig(
            base_model=self.model_name,
            training_steps=min(100, len(self.generated_trajectories) * 2),
            group_size=4,
            learning_rate=4e-5,
            lora_rank=32,
            database_url=self.database_url,
            log_file=str(self.output_dir / "tinker_training_metrics.jsonl"),
        )
        
        trainer = TinkerTrainer(config)
        
        try:
            result = await trainer.train()
            
            if result.get("success"):
                self.trained_model_path = self.output_dir / "tinker_trained"
                self.trained_model_path.mkdir(parents=True, exist_ok=True)
                
                # Save training result
                with open(self.trained_model_path / "training_result.json", "w") as f:
                    json.dump(result, f, indent=2, default=str)
                
                logger.info(f"Tinker training complete!")
                logger.info(f"  Run ID: {result.get('run_id')}")
                logger.info(f"  Steps: {result.get('steps')}")
                logger.info(f"  Final weights: {result.get('final_weights')}")
            else:
                logger.error("Tinker training failed")
                
        except Exception as e:
            logger.error(f"Tinker training error: {e}")
            logger.info("Falling back to local training data preparation")
            await self._prepare_local_training_data()
    
    async def _prepare_local_training_data(self):
        """Prepare training data for local training (Atropos/vLLM)"""
        from src.training import MultiPromptDatasetBuilder
        
        # Use multi-prompt dataset builder for comprehensive training
        builder = MultiPromptDatasetBuilder()
        
        for traj, score in zip(self.generated_trajectories, self.scores):
            # Normalize score to 0-1 range
            normalized_score = (score + 2) / 4  # Assuming scores in [-2, 2] range
            normalized_score = max(0, min(1, normalized_score))
            builder.add_trajectory(traj, trajectory_score=normalized_score)
        
        stats = builder.get_statistics()
        logger.info(f"Training data prepared:")
        logger.info(f"  - Trajectories: {stats['total_trajectories']}")
        logger.info(f"  - Total samples: {stats['total_samples']}")
        for purpose, purpose_stats in stats['by_purpose'].items():
            logger.info(f"  - {purpose}: {purpose_stats['count']} samples, avg_score={purpose_stats['avg_score']:.3f}")
        
        # Save training data
        training_data_path = self.output_dir / "training_data.json"
        builder.save_dataset(str(training_data_path))
        logger.info(f"Training data saved to: {training_data_path}")
        
        # Note about requirements
        logger.info("\nTo train locally, you need:")
        logger.info("  1. Atropos API server running (run-api)")
        logger.info("  2. vLLM server with base model")
        logger.info("  3. Or set TINKER_API_KEY for cloud training")
        
        # Save model path
        self.trained_model_path = self.output_dir / "training_data"
        self.trained_model_path.mkdir(parents=True, exist_ok=True)
        
        # Save training config for reference
        config = {
            "model_name": self.model_name,
            "num_trajectories": len(self.generated_trajectories),
            "num_samples": stats['total_samples'],
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "training_method": "prepared_data",
        }
        with open(self.trained_model_path / "training_config.json", "w") as f:
            json.dump(config, f, indent=2)
        
        logger.info(f"Training config saved to: {self.trained_model_path}")
    
    async def run_benchmark(self):
        """Compare base model vs trained model"""
        from src.training import FastSimulator, SimulatorConfig
        
        logger.info("Preparing benchmark comparison...")
        
        # Create benchmark snapshot from our data
        if not self.generated_trajectories:
            logger.warning("No trajectories for benchmark")
            return
        
        # Calculate stats for base model (from generated data)
        base_pnls = [t.final_pnl for t in self.generated_trajectories]
        base_avg_pnl = sum(base_pnls) / len(base_pnls)
        base_best_pnl = max(base_pnls)
        base_worst_pnl = min(base_pnls)
        
        self.benchmark_results = {
            "base_model": {
                "model": self.model_name,
                "agents": len(self.generated_trajectories),
                "avg_pnl": base_avg_pnl,
                "best_pnl": base_best_pnl,
                "worst_pnl": base_worst_pnl,
            },
            "trained_model": {
                "model": f"{self.model_name}-trained",
                "status": "pending_training",
                "note": "Run full training to get trained model results"
            }
        }
        
        logger.info("\nBenchmark Results:")
        logger.info("-" * 50)
        logger.info(f"Base Model: {self.model_name}")
        logger.info(f"  Agents evaluated: {len(self.generated_trajectories)}")
        logger.info(f"  Average P&L: ${base_avg_pnl:.2f}")
        logger.info(f"  Best P&L: ${base_best_pnl:.2f}")
        logger.info(f"  Worst P&L: ${base_worst_pnl:.2f}")
        logger.info("-" * 50)
        
        # Save benchmark results
        benchmark_path = self.output_dir / "benchmark_results.json"
        with open(benchmark_path, "w") as f:
            json.dump(self.benchmark_results, f, indent=2)
        logger.info(f"Benchmark results saved to: {benchmark_path}")


async def main():
    parser = argparse.ArgumentParser(
        description="ElizaOS Full Training Pipeline",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    
    parser.add_argument(
        "--mode",
        choices=["full", "generate", "train", "benchmark"],
        default="full",
        help="Pipeline mode"
    )
    parser.add_argument(
        "--model",
        default="Qwen/Qwen3-4B",
        help="Model to use (e.g., Qwen/Qwen3-4B, Qwen/Qwen2.5-3B-Instruct)"
    )
    parser.add_argument(
        "--agents",
        type=int,
        default=10,
        help="Number of agents to run"
    )
    parser.add_argument(
        "--ticks",
        type=int,
        default=100,
        help="Ticks per agent"
    )
    parser.add_argument(
        "--output",
        default="./trained_models",
        help="Output directory"
    )
    parser.add_argument(
        "--window-id",
        help="Window ID for training (mode=train)"
    )
    parser.add_argument(
        "--no-wandb",
        action="store_true",
        help="Disable W&B logging"
    )
    parser.add_argument(
        "--archetype",
        type=str,
        default=None,
        help="Single archetype to train (e.g., 'trader', 'scammer')"
    )
    parser.add_argument(
        "--archetypes",
        type=str,
        nargs="+",
        default=None,
        help="Multiple archetypes to train (e.g., --archetypes trader scammer)"
    )
    parser.add_argument(
        "--list-archetypes",
        action="store_true",
        help="List all available archetypes and exit"
    )
    
    args = parser.parse_args()
    
    # Handle --list-archetypes
    if args.list_archetypes:
        from src.training import get_available_archetypes
        print("Available archetypes:")
        for arch in get_available_archetypes():
            print(f"  - {arch}")
        return
    
    # Handle archetype training mode
    if args.archetype or args.archetypes:
        from src.training import ArchetypeTrainer, ArchetypeTrainingConfig, get_rubric
        
        config = ArchetypeTrainingConfig(
            base_model=args.model,
            training_steps=args.ticks,  # Use ticks as steps for archetype training
            output_dir=args.output,
        )
        trainer = ArchetypeTrainer(config)
        
        if args.archetypes:
            # Train multiple archetypes
            results = await trainer.train_archetypes(args.archetypes)
            result = {
                "mode": "archetype_training",
                "archetypes": [r.archetype for r in results],
                "results": [
                    {
                        "archetype": r.archetype,
                        "steps": r.training_steps,
                        "checkpoint": r.checkpoint_path,
                    }
                    for r in results
                ]
            }
        else:
            # Train single archetype
            r = await trainer.train_archetype(args.archetype)
            result = {
                "mode": "archetype_training",
                "archetype": r.archetype,
                "steps": r.training_steps,
                "checkpoint": r.checkpoint_path,
            }
        
        print(f"\nResult: {json.dumps(result, indent=2, default=str)}")
        return
    
    # Standard pipeline mode
    pipeline = FullPipeline(
        model_name=args.model,
        num_agents=args.agents,
        ticks_per_agent=args.ticks,
        output_dir=args.output,
        use_wandb=not args.no_wandb,
    )
    
    if args.mode == "full":
        result = await pipeline.run_full_pipeline()
    elif args.mode == "generate":
        await pipeline.generate_data()
        result = {"trajectories": len(pipeline.generated_trajectories)}
    elif args.mode == "train":
        await pipeline.generate_data()  # Load data first
        await pipeline.score_trajectories()
        await pipeline.train_model()
        result = {"trained_model": str(pipeline.trained_model_path)}
    elif args.mode == "benchmark":
        await pipeline.generate_data()
        await pipeline.run_benchmark()
        result = pipeline.benchmark_results
    
    print(f"\nResult: {json.dumps(result, indent=2, default=str)}")


if __name__ == "__main__":
    asyncio.run(main())

