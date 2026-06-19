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
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .local_models import default_local_model_for_backend

# Import rubrics from centralized loader (single source of truth)
from .rubric_loader import (
    get_available_archetypes,
    get_priority_metrics,
    get_rubric,
    normalize_archetype,
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
    base_model: str = "Qwen/Qwen3.5-4B"

    # Training hyperparameters
    training_steps: int = 100
    batch_size: int = 4
    learning_rate: float = 1e-5

    # Data settings
    min_trajectories_per_archetype: int = 10
    lookback_hours: int = 72
    min_actions: int = 1
    max_trajectories: int = 500
    database_url: str | None = None

    # Output settings
    output_dir: str = "./trained_models"
    save_per_archetype: bool = True

    # Judge settings
    judge_model: str = "gpt-4o-mini"

    # Logging
    log_to_file: bool = True
    log_dir: str = "./logs"

    # Local training settings
    local_backend: str | None = None
    local_model: str | None = None
    local_validate: bool = True


@dataclass
class ArchetypeTrainingResult:
    """Result of training for a specific archetype"""

    archetype: str
    trajectories_used: int
    training_steps: int
    final_loss: float
    checkpoint_path: str
    metrics: dict


# ============================================================================
# Main Archetype Trainer
# ============================================================================


class ArchetypeTrainer:
    """
    Multi-archetype training orchestrator.

    Makes it easy to train agents with different values/goals.
    """

    def __init__(self, config: ArchetypeTrainingConfig | None = None):
        self.config = config or ArchetypeTrainingConfig()
        self._ensure_dirs()

    def _ensure_dirs(self):
        """Create output directories if they don't exist"""
        Path(self.config.output_dir).mkdir(parents=True, exist_ok=True)
        Path(self.config.log_dir).mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _default_local_model_for_backend(backend: str) -> str:
        return default_local_model_for_backend(backend)  # type: ignore[arg-type]

    def _resolve_model_name(self, backend: str) -> str:
        if self.config.local_model:
            return self.config.local_model
        if self.config.base_model and (
            backend != "mlx" or self.config.base_model.startswith("mlx")
        ):
            return self.config.base_model
        return self._default_local_model_for_backend(backend)

    @staticmethod
    def extract_trajectory_archetype(trajectory) -> str:
        archetype = getattr(trajectory, "archetype", None)
        if archetype:
            return normalize_archetype(str(archetype))

        for step in getattr(trajectory, "steps", []):
            action = getattr(step, "action", None)
            if action is None:
                continue
            for candidate in (getattr(action, "parameters", None), getattr(action, "result", None)):
                if isinstance(candidate, dict) and candidate.get("archetype"):
                    return normalize_archetype(str(candidate["archetype"]))

        return "default"

    @classmethod
    def filter_trajectories_for_archetype(cls, trajectories: list, archetype: str) -> list:
        target = normalize_archetype(archetype)
        return [
            trajectory
            for trajectory in trajectories
            if cls.extract_trajectory_archetype(trajectory) == target
        ]

    async def _load_trajectories(self) -> list:
        from src.data_bridge import PostgresTrajectoryReader
        from src.models import FeedTrajectory

        database_url = self.config.database_url or os.getenv("DATABASE_URL", "")
        if not database_url:
            raise ValueError("DATABASE_URL is required for archetype training")

        trajectories = []
        async with PostgresTrajectoryReader(database_url) as reader:
            windows = await reader.get_window_ids(
                min_agents=1,
                lookback_hours=self.config.lookback_hours,
                only_scored=False,
            )
            for window_id in windows:
                rows = await reader.get_trajectories_by_window(
                    window_id,
                    min_actions=self.config.min_actions,
                )
                for row in rows:
                    if len(trajectories) >= self.config.max_trajectories:
                        break
                    try:
                        steps = json.loads(row.steps_json)
                        trajectories.append(
                            FeedTrajectory.model_validate(
                                {
                                    "id": row.trajectory_id,
                                    "trajectory_id": row.trajectory_id,
                                    "agent_id": row.agent_id,
                                    "window_id": row.window_id,
                                    "steps": steps,
                                    "total_reward": row.total_reward,
                                    "episode_length": row.episode_length,
                                    "final_status": row.final_status,
                                    "final_pnl": row.final_pnl
                                    if row.final_pnl is not None
                                    else 0.0,
                                    "trades_executed": row.trades_executed
                                    if row.trades_executed is not None
                                    else 0,
                                    "archetype": row.archetype,
                                }
                            )
                        )
                    except Exception as exc:
                        logger.warning(
                            "Skipping trajectory %s due to parsing error: %s",
                            row.trajectory_id,
                            exc,
                        )
                if len(trajectories) >= self.config.max_trajectories:
                    break

        return trajectories

    async def train_archetype(
        self,
        archetype: str,
        trajectories: list | None = None,
    ) -> ArchetypeTrainingResult:
        """
        Train a single archetype.

        Args:
            archetype: Name of the archetype to train (e.g., "trader", "scammer")
            trajectories: Optional pre-loaded trajectories. If None, loads from DB.

        Returns:
            ArchetypeTrainingResult with training metrics and checkpoint path
        """
        from scripts.train_local import (
            detect_backend,
            train_cpu,
            train_cuda,
            train_mlx,
            trajectories_to_training_samples,
            validate_trained_model,
        )

        normalized_archetype = normalize_archetype(archetype)
        logger.info(f"Starting training for archetype: {normalized_archetype}")

        # Get archetype-specific rubric
        rubric = get_rubric(normalized_archetype)
        priority_metrics = get_priority_metrics(normalized_archetype)

        source_trajectories = trajectories or await self._load_trajectories()
        filtered_trajectories = self.filter_trajectories_for_archetype(
            source_trajectories,
            normalized_archetype,
        )

        if len(filtered_trajectories) < self.config.min_trajectories_per_archetype:
            raise ValueError(
                f"Not enough trajectories for archetype '{normalized_archetype}': "
                f"{len(filtered_trajectories)} < {self.config.min_trajectories_per_archetype}"
            )

        samples = trajectories_to_training_samples(filtered_trajectories)
        if len(samples) < 10:
            raise ValueError(
                f"Not enough training samples for archetype '{normalized_archetype}': {len(samples)}"
            )

        backend = self.config.local_backend or detect_backend()
        model_name = self._resolve_model_name(backend)
        archetype_output_dir = (
            Path(self.config.output_dir) / normalized_archetype
            if self.config.save_per_archetype
            else Path(self.config.output_dir)
        )
        archetype_output_dir.mkdir(parents=True, exist_ok=True)

        if backend == "mlx":
            checkpoint_path = train_mlx(
                samples,
                model_name,
                str(archetype_output_dir),
                self.config.training_steps,
                self.config.batch_size,
                self.config.learning_rate,
            )
            base_model = model_name
        elif backend == "cuda":
            checkpoint_path = train_cuda(
                samples,
                model_name,
                str(archetype_output_dir),
                epochs=1,
                batch_size=self.config.batch_size,
                learning_rate=self.config.learning_rate,
                use_lora=True,
                quantization="none",
                lora_rank=16,
                lora_alpha=32,
                lora_dropout=0.1,
                lora_target_modules=None,
                max_steps=self.config.training_steps,
                max_seq_length=1024,
                gradient_accumulation_steps=1,
                seed=1337,
                validation_split_ratio=0.1,
            )
            base_model = None
        else:
            checkpoint_path = train_cpu(
                samples,
                model_name,
                str(archetype_output_dir),
                epochs=1,
                batch_size=self.config.batch_size,
                learning_rate=self.config.learning_rate,
                max_steps=self.config.training_steps,
                max_seq_length=1024,
                gradient_accumulation_steps=1,
                seed=1337,
                validation_split_ratio=0.1,
            )
            base_model = None

        validation_passed = None
        if self.config.local_validate:
            validation_passed = validate_trained_model(
                checkpoint_path,
                backend,  # type: ignore[arg-type]
                base_model,
            )

        metrics_path = archetype_output_dir / "training_metrics.json"
        training_metrics = {}
        final_loss = 0.0
        if metrics_path.exists():
            with metrics_path.open("r", encoding="utf-8") as handle:
                training_metrics = json.load(handle)
            final_loss = float(
                training_metrics.get("train_loss") or training_metrics.get("loss") or 0.0
            )

        manifest = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "training_method": "archetype_filtered_local_sft",
            "archetype": normalized_archetype,
            "rubric": rubric,
            "priority_metrics": priority_metrics,
            "backend": backend,
            "model_name": model_name,
            "trajectory_count": len(filtered_trajectories),
            "sample_count": len(samples),
            "output_path": checkpoint_path,
            "validation_passed": validation_passed,
        }
        manifest_path = archetype_output_dir / "training_manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        return ArchetypeTrainingResult(
            archetype=normalized_archetype,
            trajectories_used=len(filtered_trajectories),
            training_steps=self.config.training_steps,
            final_loss=final_loss,
            checkpoint_path=checkpoint_path,
            metrics={
                "training_metrics": training_metrics,
                "validation_passed": validation_passed,
                "manifest_path": str(manifest_path),
                "sample_count": len(samples),
            },
        )

    async def train_archetypes(
        self,
        archetypes: list[str],
        parallel: bool = False,
    ) -> list[ArchetypeTrainingResult]:
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
    ) -> list[ArchetypeTrainingResult]:
        """
        Train ALL available archetypes.

        Args:
            parallel: If True, train in parallel

        Returns:
            List of ArchetypeTrainingResult for all archetypes
        """
        all_archetypes = get_available_archetypes()
        return await self.train_archetypes(all_archetypes, parallel=parallel)

    def get_trained_model_path(self, archetype: str) -> str | None:
        """Get path to trained model for an archetype"""
        path = Path(self.config.output_dir) / normalize_archetype(archetype)
        manifest_path = path / "training_manifest.json"
        if not manifest_path.exists():
            return None
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        output_path = manifest.get("output_path")
        return str(output_path) if output_path else None

    def list_trained_archetypes(self) -> list[str]:
        """List all archetypes that have been trained"""
        output_dir = Path(self.config.output_dir)
        trained = []
        for arch in get_available_archetypes():
            if (output_dir / arch / "training_manifest.json").exists():
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
        help="Single archetype to train (e.g., 'trader', 'scammer')",
    )
    parser.add_argument(
        "--archetypes",
        type=str,
        nargs="+",
        default=None,
        help="Multiple archetypes to train (e.g., --archetypes trader scammer)",
    )
    parser.add_argument("--all", action="store_true", help="Train all available archetypes")
    parser.add_argument(
        "--parallel",
        action="store_true",
        help="Train archetypes in parallel (requires more resources)",
    )
    parser.add_argument("--list", action="store_true", help="List all available archetypes")
    parser.add_argument("--steps", type=int, default=100, help="Training steps per archetype")
    parser.add_argument(
        "--output-dir",
        type=str,
        default="./trained_models",
        help="Directory to save trained models",
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
