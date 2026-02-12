"""
Archetype-Aware Training Pipeline

Train agents with different "values" using archetype-specific rubrics.
Supports training single archetypes, multiple archetypes, or all archetypes at once.

Usage:
    # Train a single archetype
    trainer = ArchetypeTrainer()
    await trainer.train_archetype("trader")
    
    # Train multiple archetypes
    await trainer.train_archetypes(["trader", "scammer", "social-butterfly"])
    
    # Train all archetypes
    await trainer.train_all_archetypes()
"""

import asyncio
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

# Import rubrics from centralized loader (single source of truth)
from .rubric_loader import (
    get_rubric,
    get_priority_metrics,
    get_available_archetypes,
    reload_rubrics,
    DEFAULT_RUBRIC,
)

logger = logging.getLogger(__name__)

# ============================================================================
# Archetype Rubrics - Loaded from config/rubrics.json via rubric_loader
# ============================================================================
# 
# All rubrics are now defined in packages/training/config/rubrics.json
# This is the single source of truth shared between TypeScript and Python.
#
# Use these functions (imported from rubric_loader):
#   get_rubric(archetype)          - Get the rubric text for an archetype
#   get_priority_metrics(archetype) - Get priority metrics for scoring
#   get_available_archetypes()     - Get list of all archetypes
#   reload_rubrics()               - Reload rubrics from JSON file
#   DEFAULT_RUBRIC                 - Fallback rubric for unknown archetypes
# ============================================================================


# ============================================================================
# Archetype Training Configuration
# ============================================================================

@dataclass
class ArchetypeTrainingConfig:
    """Configuration for archetype-specific training"""
    
    # Model settings
    base_model: str = "Qwen/Qwen3-4B"
    
    # Training hyperparameters
    training_steps: int = 100
    batch_size: int = 4
    learning_rate: float = 1e-5
    
    # Data settings
    min_trajectories_per_archetype: int = 10
    lookback_hours: int = 72
    
    # Output settings
    output_dir: str = "./trained_models"
    save_per_archetype: bool = True
    
    # Judge settings
    judge_model: str = "gpt-4o-mini"
    
    # Logging
    log_to_file: bool = True
    log_dir: str = "./logs"


@dataclass 
class ArchetypeTrainingResult:
    """Result of training for a specific archetype"""
    archetype: str
    trajectories_used: int
    training_steps: int
    final_loss: float
    checkpoint_path: str
    metrics: Dict
    

# ============================================================================
# Main Archetype Trainer
# ============================================================================

class ArchetypeTrainer:
    """
    Multi-archetype training orchestrator.
    
    Makes it easy to train agents with different values/goals.
    """
    
    def __init__(self, config: Optional[ArchetypeTrainingConfig] = None):
        self.config = config or ArchetypeTrainingConfig()
        self._ensure_dirs()
        
    def _ensure_dirs(self):
        """Create output directories if they don't exist"""
        Path(self.config.output_dir).mkdir(parents=True, exist_ok=True)
        Path(self.config.log_dir).mkdir(parents=True, exist_ok=True)
        
    async def train_archetype(
        self,
        archetype: str,
        trajectories: Optional[List] = None,
    ) -> ArchetypeTrainingResult:
        """
        Train a single archetype.
        
        Args:
            archetype: Name of the archetype to train (e.g., "trader", "scammer")
            trajectories: Optional pre-loaded trajectories. If None, loads from DB.
            
        Returns:
            ArchetypeTrainingResult with training metrics and checkpoint path
        """
        from .babylon_env import BabylonEnvConfig
        from .atropos_trainer import BabylonAtroposTrainer, AtroposTrainingConfig
        
        logger.info(f"Starting training for archetype: {archetype}")
        
        # Get archetype-specific rubric
        rubric = get_rubric(archetype)
        
        # Configure environment with archetype rubric
        # Note: env_config is prepared for when the BabylonRLAIFEnv is started
        # In the full pipeline, this would be passed to the environment server
        _ = BabylonEnvConfig(
            scoring_rubric=rubric,
            judge_model=self.config.judge_model,
            lookback_hours=self.config.lookback_hours,
        )
        
        # Configure trainer
        trainer_config = AtroposTrainingConfig(
            model_name=self.config.base_model,
            training_steps=self.config.training_steps,
            batch_size=self.config.batch_size,
            learning_rate=self.config.learning_rate,
            log_to_file=self.config.log_to_file,
            log_file=f"{self.config.log_dir}/training_{archetype}.jsonl",
        )
        
        # Initialize trainer
        trainer = BabylonAtroposTrainer(trainer_config)
        
        # Run training
        result = await trainer.train()
        
        # Build output
        checkpoint_path = result.get("final_checkpoint", "")
        
        # Rename checkpoint to include archetype
        if checkpoint_path and self.config.save_per_archetype:
            archetype_path = f"{self.config.output_dir}/{archetype}_model"
            import shutil
            if os.path.exists(checkpoint_path):
                shutil.copytree(checkpoint_path, archetype_path, dirs_exist_ok=True)
                checkpoint_path = archetype_path
        
        return ArchetypeTrainingResult(
            archetype=archetype,
            trajectories_used=result.get("steps", 0) * self.config.batch_size,
            training_steps=result.get("steps", 0),
            final_loss=result.get("metrics", [{}])[-1].get("loss", 0) if result.get("metrics") else 0,
            checkpoint_path=checkpoint_path,
            metrics={"training_metrics": result.get("metrics", [])},
        )
        
    async def train_archetypes(
        self,
        archetypes: List[str],
        parallel: bool = False,
    ) -> List[ArchetypeTrainingResult]:
        """
        Train multiple archetypes.
        
        Args:
            archetypes: List of archetype names to train
            parallel: If True, train archetypes in parallel (requires more resources)
            
        Returns:
            List of ArchetypeTrainingResult for each archetype
        """
        logger.info(f"Training {len(archetypes)} archetypes: {archetypes}")
        
        if parallel:
            # Train in parallel (requires significant resources)
            tasks = [self.train_archetype(arch) for arch in archetypes]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            # Filter out exceptions
            valid_results = []
            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    logger.error(f"Failed to train {archetypes[i]}: {result}")
                else:
                    valid_results.append(result)
            return valid_results
        else:
            # Train sequentially (safer, less resource-intensive)
            results = []
            for archetype in archetypes:
                try:
                    result = await self.train_archetype(archetype)
                    results.append(result)
                except Exception as e:
                    logger.error(f"Failed to train {archetype}: {e}")
            return results
            
    async def train_all_archetypes(
        self,
        parallel: bool = False,
    ) -> List[ArchetypeTrainingResult]:
        """
        Train ALL available archetypes.
        
        Args:
            parallel: If True, train in parallel
            
        Returns:
            List of ArchetypeTrainingResult for all archetypes
        """
        all_archetypes = get_available_archetypes()
        return await self.train_archetypes(all_archetypes, parallel=parallel)
        
    def get_trained_model_path(self, archetype: str) -> Optional[str]:
        """Get path to trained model for an archetype"""
        path = f"{self.config.output_dir}/{archetype}_model"
        return path if os.path.exists(path) else None
        
    def list_trained_archetypes(self) -> List[str]:
        """List all archetypes that have been trained"""
        output_dir = Path(self.config.output_dir)
        trained = []
        for arch in get_available_archetypes():
            if (output_dir / f"{arch}_model").exists():
                trained.append(arch)
        return trained


# ============================================================================
# CLI Entry Point
# ============================================================================

def main():
    """CLI entry point for archetype training"""
    import argparse
    
    parser = argparse.ArgumentParser(description="Train agents with archetype-specific values")
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
        "--all",
        action="store_true",
        help="Train all available archetypes"
    )
    parser.add_argument(
        "--parallel",
        action="store_true",
        help="Train archetypes in parallel (requires more resources)"
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List all available archetypes"
    )
    parser.add_argument(
        "--steps",
        type=int,
        default=100,
        help="Training steps per archetype"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="./trained_models",
        help="Directory to save trained models"
    )
    
    args = parser.parse_args()
    
    if args.list:
        print("Available archetypes:")
        for arch in get_available_archetypes():
            print(f"  - {arch}")
        return
        
    config = ArchetypeTrainingConfig(
        training_steps=args.steps,
        output_dir=args.output_dir,
    )
    
    trainer = ArchetypeTrainer(config)
    
    async def run():
        if args.all:
            results = await trainer.train_all_archetypes(parallel=args.parallel)
        elif args.archetypes:
            results = await trainer.train_archetypes(args.archetypes, parallel=args.parallel)
        elif args.archetype:
            result = await trainer.train_archetype(args.archetype)
            results = [result]
        else:
            print("Please specify --archetype, --archetypes, or --all")
            print("Use --list to see available archetypes")
            return
            
        print("\n" + "=" * 60)
        print("TRAINING COMPLETE")
        print("=" * 60)
        for r in results:
            print(f"\n{r.archetype}:")
            print(f"  Steps: {r.training_steps}")
            print(f"  Final Loss: {r.final_loss:.4f}")
            print(f"  Checkpoint: {r.checkpoint_path}")
            
    asyncio.run(run())


if __name__ == "__main__":
    main()
