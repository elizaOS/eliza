#!/usr/bin/env python3
"""
Babylon local SFT pipeline stage.

This script now serves as the internal local-SFT/data-prep stage used by the
canonical `run_pipeline.py` orchestrator. It still supports direct invocation
for local iteration, but it is no longer the user-facing end-to-end project
pipeline.

Usage:
    # Internal local SFT stage
    python scripts/run_full_pipeline.py --agents 10 --model Qwen/Qwen3.5-4B

    # Data prep only
    python scripts/run_full_pipeline.py --prepare-only

    # Internal benchmark-only reuse
    python scripts/run_full_pipeline.py --mode benchmark
"""

import argparse
import asyncio
import hashlib
import json
import logging
import os
import sys
import tarfile
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
from local_training_recipe import (
    LocalTrainingRecipe,
    add_local_training_arguments,
    local_training_recipe_from_args,
)
from train_local import (
    detect_backend,
    load_json_training_data,
    train_cpu,
    train_cuda,
    train_mlx,
    trajectories_to_training_samples,
    validate_trained_model,
)

from src.training.local_models import default_local_model_for_backend
from src.training.tinker_client import ensure_tinker_api_key_env

# Load environment
load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)


class FullPipeline:
    """
    Complete training pipeline orchestrator.

    Manages the full workflow from agent simulation to model training.
    """

    def __init__(
        self,
        model_name: str = "Qwen/Qwen3.5-4B",
        num_agents: int = 10,
        ticks_per_agent: int = 100,
        database_url: str | None = None,
        output_dir: str = "./trained_models",
        use_wandb: bool = True,
        skip_benchmark: bool = False,
        local_training_enabled: bool = True,
        local_training_backend: Literal["mlx", "cuda", "cpu"] | None = None,
        local_training_model: str | None = None,
        local_training_sample_profile: str = "canonical",
        local_training_steps: int = 5,
        local_training_batch_size: int = 1,
        local_training_learning_rate: float = 1e-5,
        local_training_optimizer: Literal["adamw", "apollo"] = "adamw",
        local_training_quantization: Literal["none", "nf4"] = "none",
        local_training_use_lora: bool = True,
        local_training_lora_rank: int = 16,
        local_training_lora_alpha: int = 32,
        local_training_lora_dropout: float = 0.1,
        local_training_lora_target_modules: list[str] | None = None,
        local_training_max_seq_length: int = 1024,
        local_training_gradient_accumulation_steps: int = 1,
        local_training_seed: int = 1337,
        local_training_eval_split_ratio: float = 0.1,
        local_validate: bool = True,
        lookback_hours: int = 72,
        min_agents: int = 1,
        min_actions: int = 1,
        max_trajectories: int | None = None,
        window_selection_limit: int = 50,
        training_backend_preference: Literal["auto", "local", "tinker"] = "auto",
        trajectory_source: Literal["db", "huggingface", "local_export"] | None = None,
        source_dir: str | None = None,
        hf_dataset: str | None = None,
        hf_split: str = "raw",
        tinker_training_steps: int = 100,
        tinker_group_size: int = 4,
        tinker_learning_rate: float = 4e-5,
        tinker_lora_rank: int = 32,
        tinker_weight_sync_interval: int = 5,
        format_recovery_dir: str | None = None,
        format_recovery_ratio: float = 0.05,
    ):
        self.model_name = model_name
        self.num_agents = num_agents
        self.ticks_per_agent = ticks_per_agent
        self.database_url = database_url or os.getenv("DATABASE_URL", "")
        self.output_dir = Path(output_dir).resolve()
        self.use_wandb = use_wandb
        self.skip_benchmark = skip_benchmark
        self.local_training_enabled = local_training_enabled
        self.local_training_recipe = LocalTrainingRecipe.from_values(
            backend=local_training_backend,
            model=local_training_model,
            sample_profile=local_training_sample_profile,
            steps=local_training_steps,
            batch_size=local_training_batch_size,
            learning_rate=local_training_learning_rate,
            optimizer=local_training_optimizer,
            quantization=local_training_quantization,
            use_lora=local_training_use_lora,
            lora_rank=local_training_lora_rank,
            lora_alpha=local_training_lora_alpha,
            lora_dropout=local_training_lora_dropout,
            lora_target_modules=local_training_lora_target_modules,
            max_seq_length=local_training_max_seq_length,
            gradient_accumulation_steps=local_training_gradient_accumulation_steps,
            seed=local_training_seed,
            eval_split_ratio=local_training_eval_split_ratio,
        )
        for attribute, value in self.local_training_recipe.to_prefixed_dict(
            "local_training"
        ).items():
            setattr(self, attribute, value)
        self.local_validate = local_validate
        self.lookback_hours = max(1, lookback_hours)
        self.min_agents = max(1, min_agents)
        self.min_actions = max(1, min_actions)
        self.max_trajectories = (
            max_trajectories if max_trajectories and max_trajectories > 0 else None
        )
        self.window_selection_limit = max(1, window_selection_limit)
        self.training_backend_preference = training_backend_preference
        self.trajectory_source = trajectory_source or ("huggingface" if hf_dataset else None)
        self.source_dir = source_dir
        self.hf_dataset = hf_dataset.strip() if hf_dataset else None
        self.hf_split = hf_split.strip() or "raw"
        self.tinker_training_steps = max(1, tinker_training_steps)
        self.tinker_group_size = max(2, tinker_group_size)
        self.tinker_learning_rate = tinker_learning_rate
        self.tinker_lora_rank = max(1, tinker_lora_rank)
        self.tinker_weight_sync_interval = max(1, tinker_weight_sync_interval)
        self.format_recovery_dir = format_recovery_dir
        self.format_recovery_ratio = max(0.0, min(1.0, format_recovery_ratio))

        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Track results
        self.generated_trajectories = []
        self.scores = []
        self.trained_model_path = None
        self.training_artifact_path = None
        self.training_status = "not_started"
        self.benchmark_results = {}
        self.training_backend: str | None = None
        self.training_base_model: str | None = None
        self.training_remote_ref: str | None = None
        self.training_remote_base_ref: str | None = None
        self.training_remote_state_ref: str | None = None
        self.training_export_archive_path: Path | None = None
        self.training_export_dir: Path | None = None
        self.training_metrics_path: Path | None = None
        self.training_capacity_report_path: Path | None = None
        self.training_export_error: str | None = None
        self.validation_passed: bool | None = None
        self.effective_local_training_recipe: LocalTrainingRecipe | None = None
        self.served_eval_path: Path | None = None
        self.served_eval_summary: dict[str, object] | None = None
        self.selected_window_ids: list[str] = []
        self.selection_seed = 17
        self.window_selection_policy: dict[str, object] = {
            "strategy": "stable_hash_window_then_trajectory",
            "limit": self.window_selection_limit,
            "seed": self.selection_seed,
        }
        self.data_provenance: dict[str, object] = {}
        self.source_window_count: int | None = None
        self.selected_trajectory_count: int = 0
        self.training_sample_count: int | None = None

    @staticmethod
    def _trajectory_from_reader_row(traj_row, trajectory_model):
        """Convert a reader row into a validated BabylonTrajectory."""
        steps = json.loads(traj_row.steps_json)
        traj_data = {
            "id": traj_row.trajectory_id,
            "trajectory_id": traj_row.trajectory_id,
            "agent_id": traj_row.agent_id,
            "window_id": traj_row.window_id,
            "steps": steps,
            "total_reward": traj_row.total_reward,
            "episode_length": traj_row.episode_length,
            "final_status": traj_row.final_status,
            "final_pnl": traj_row.final_pnl if traj_row.final_pnl is not None else 0.0,
            "trades_executed": traj_row.trades_executed
            if traj_row.trades_executed is not None
            else 0,
            "archetype": traj_row.archetype,
        }
        return trajectory_model.model_validate(traj_data)

    async def run_full_pipeline(self):
        """Run the complete pipeline end-to-end"""
        logger.info("=" * 70)
        logger.info("BABYLON FULL TRAINING PIPELINE")
        logger.info("=" * 70)
        logger.info(f"Model: {self.model_name}")
        logger.info(f"Agents: {self.num_agents}")
        logger.info(f"Ticks per agent: {self.ticks_per_agent}")
        logger.info(f"Output: {self.output_dir}")
        logger.info("=" * 70)

        start_time = time.time()

        # Step 1: Load trajectory data
        logger.info("\n" + "=" * 70)
        logger.info("STEP 1: DATA LOADING")
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

        if self.skip_benchmark:
            logger.info("\n" + "=" * 70)
            logger.info("STEP 4: BENCHMARK")
            logger.info("=" * 70)
            logger.info("Skipping benchmark (--skip-benchmark)")
        else:
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
        if self.training_status == "trained":
            logger.info(f"Trained model: {self.trained_model_path}")
        elif self.training_status == "prepared_data":
            logger.info(f"Training artifact: {self.training_artifact_path}")
            logger.info("Model weights were not produced in this run")
        logger.info("=" * 70)

        return {
            "trajectories": len(self.generated_trajectories),
            "training_status": self.training_status,
            "trained_model": str(self.trained_model_path) if self.trained_model_path else None,
            "training_artifact": str(self.training_artifact_path)
            if self.training_artifact_path
            else None,
            "training_export_error": self.training_export_error,
            "benchmark": self.benchmark_results,
            "total_time": total_time,
        }

    async def generate_data(self):
        """
        Load curated trajectories for the local SFT stage.

        This stage does not generate fresh rollouts. It selects existing
        trajectories from the configured source, applies provenance-aware
        filtering, and prepares them for scoring/training.
        """
        from src.models import BabylonTrajectory

        trajectory_source = (
            self.trajectory_source or os.getenv("TRAJECTORY_SOURCE", "db").strip().lower()
        )
        self.trajectory_source = trajectory_source
        self.selected_window_ids = []
        self.window_selection_policy = {
            "strategy": "stable_hash_window_then_trajectory",
            "limit": self.window_selection_limit,
            "seed": self.selection_seed,
        }
        self.data_provenance = {}
        self.source_window_count = None
        self.selected_trajectory_count = 0
        self.training_sample_count = None

        if trajectory_source == "local_export":
            if not self.source_dir:
                raise ValueError("source_dir is required when trajectory_source=local_export")
            source_dir = Path(self.source_dir).expanduser().resolve()
            if not source_dir.is_dir():
                raise FileNotFoundError(f"Local export directory not found: {source_dir}")

            logger.info("Loading trajectories from local export %s...", source_dir)
            candidate_load_cap = max(
                self.max_trajectories or 0,
                self.window_selection_limit * 1000,
                50000,
            )
            trajectories = load_json_training_data(
                str(source_dir),
                candidate_load_cap,
            )
            filtered_trajectories = [
                trajectory
                for trajectory in trajectories
                if self._count_usable_action_steps(trajectory) >= self.min_actions
            ]
            if len(filtered_trajectories) != len(trajectories):
                logger.info(
                    "Filtered %s local-export trajectories below min_actions=%s",
                    len(trajectories) - len(filtered_trajectories),
                    self.min_actions,
                )
            self.generated_trajectories = self._select_trajectories(filtered_trajectories)
            self.selected_window_ids = sorted(
                {
                    str(getattr(trajectory, "window_id", "") or "").strip()
                    for trajectory in self.generated_trajectories
                    if str(getattr(trajectory, "window_id", "") or "").strip()
                },
                reverse=True,
            )
            self.window_selection_policy = {
                "strategy": "all_loaded_stable_hash_trajectory",
                "limit": self.max_trajectories,
                "seed": self.selection_seed,
                "candidate_load_cap": candidate_load_cap,
            }
            self.source_window_count = len(self.selected_window_ids)
            self.selected_trajectory_count = len(self.generated_trajectories)
            self.data_provenance = self._build_data_provenance("local_export")
            logger.info(
                "Loaded %s trajectories from local export",
                len(self.generated_trajectories),
            )
            return

        if trajectory_source == "huggingface":
            hf_dataset = self.hf_dataset or os.getenv("HF_TRAJECTORY_DATASET", "").strip()
            hf_split = self.hf_split or os.getenv("HF_TRAJECTORY_SPLIT", "raw").strip() or "raw"
            if not hf_dataset:
                raise ValueError(
                    "HF_TRAJECTORY_DATASET required when TRAJECTORY_SOURCE=huggingface"
                )

            from src.data_bridge.hf_reader import HFReaderConfig, HuggingFaceTrajectoryReader

            reader_ctx = HuggingFaceTrajectoryReader(
                HFReaderConfig(
                    dataset_id=hf_dataset,
                    split=hf_split,
                    max_trajectories=self.max_trajectories or 50000,
                    min_actions=self.min_actions,
                )
            )
            source_label = f"HuggingFace dataset {hf_dataset} [{hf_split}]"
        else:
            if not self.database_url:
                raise ValueError("DATABASE_URL required for training - no synthetic fallback")

            from src.data_bridge import PostgresTrajectoryReader

            reader_ctx = PostgresTrajectoryReader(self.database_url)
            source_label = "database"

        logger.info("Loading trajectories from %s...", source_label)

        try:
            async with reader_ctx as reader:
                windows = await reader.get_window_ids(
                    limit=0,
                    min_agents=self.min_agents,
                    lookback_hours=self.lookback_hours,
                    only_scored=False,
                )

                if not windows:
                    if trajectory_source == "huggingface":
                        raise ValueError(
                            "No trajectory data in HuggingFace dataset - export or select a dataset with real trajectories"
                        )

                    raise ValueError("No trajectory data in database - generate real data first")

                logger.info("Found %s trajectory windows", len(windows))
                selected_window_ids = self._select_window_ids(windows)
                self.selected_window_ids = selected_window_ids
                self.source_window_count = len(windows)
                self.window_selection_policy = {
                    "strategy": "stable_hash_window_then_trajectory",
                    "limit": self.window_selection_limit,
                    "seed": self.selection_seed,
                }

                all_trajectories = []
                for window_id in selected_window_ids:
                    trajectories = await reader.get_trajectories_by_window(
                        window_id,
                        min_actions=self.min_actions,
                    )
                    for traj_row in trajectories:
                        try:
                            all_trajectories.append(
                                self._trajectory_from_reader_row(
                                    traj_row,
                                    BabylonTrajectory,
                                )
                            )
                        except Exception as e:
                            logger.warning(
                                "Skipping %s trajectory %s due to parsing error: %s",
                                trajectory_source,
                                getattr(traj_row, "trajectory_id", "unknown"),
                                e,
                            )

                if not all_trajectories:
                    logger.error("No valid trajectories found in %s!", source_label)
                    raise ValueError(
                        "No valid trajectory data - export or generate more real trajectories"
                    )

                self.generated_trajectories = self._select_trajectories(all_trajectories)
                self.selected_trajectory_count = len(self.generated_trajectories)
                self.data_provenance = self._build_data_provenance(trajectory_source)
                logger.info(
                    "Loaded %s trajectories from %s", len(self.generated_trajectories), source_label
                )

        except ValueError:
            raise
        except Exception as e:
            logger.exception("Failed to load from %s", source_label)
            source_name = (
                "HuggingFace dataset" if trajectory_source == "huggingface" else "database"
            )
            raise ValueError(f"{source_name} connection failed: {e}")

    def _get_training_manifest_path(self) -> Path:
        return self.output_dir / "training_manifest.json"

    @staticmethod
    def _step_to_dict(step: object) -> dict[str, Any]:
        if isinstance(step, dict):
            return step
        if hasattr(step, "model_dump"):
            return step.model_dump(by_alias=True)  # type: ignore[no-any-return]
        return {}

    @classmethod
    def _step_has_valid_llm_call(cls, step: object) -> bool:
        step_dict = cls._step_to_dict(step)
        llm_calls = step_dict.get("llmCalls") or step_dict.get("llm_calls") or []
        for call in llm_calls:
            if not isinstance(call, dict):
                continue
            system_prompt = call.get("systemPrompt") or call.get("system_prompt") or ""
            user_prompt = call.get("userPrompt") or call.get("user_prompt") or ""
            response = call.get("response") or ""
            if len(system_prompt) >= 20 and len(user_prompt) >= 20 and len(response) >= 20:
                return True
        return False

    @classmethod
    def _step_has_usable_action(cls, step: object) -> bool:
        step_dict = cls._step_to_dict(step)
        action = step_dict.get("action")
        if isinstance(action, dict) and action:
            action_type = (
                action.get("actionType")
                or action.get("action_type")
                or action.get("type")
                or action.get("action")
                or ""
            )
            if str(action_type).strip():
                return True

            if bool(action.get("parameters") or action.get("result")):
                return True

        llm_calls = step_dict.get("llmCalls") or step_dict.get("llm_calls") or []
        for call in llm_calls:
            if not isinstance(call, dict):
                continue
            llm_action_type = call.get("actionType") or call.get("action_type") or ""
            llm_purpose = call.get("purpose") or ""
            if str(llm_action_type).strip():
                return True
            if str(llm_purpose).strip().lower() == "action":
                return True

        return False

    @classmethod
    def _count_usable_action_steps(cls, trajectory: object) -> int:
        steps = []
        if hasattr(trajectory, "steps"):
            steps = list(trajectory.steps or [])
        elif isinstance(trajectory, dict):
            steps = list(trajectory.get("steps") or [])

        usable_steps = 0
        for step in steps:
            if cls._step_has_valid_llm_call(step) and cls._step_has_usable_action(step):
                usable_steps += 1
        return usable_steps

    def _stable_selection_key(self, scope: str, value: str) -> tuple[str, str]:
        digest = hashlib.sha256(f"{self.selection_seed}:{scope}:{value}".encode()).hexdigest()
        return digest, value

    def _select_window_ids(self, window_ids: list[str]) -> list[str]:
        cleaned = sorted(
            {str(window_id).strip() for window_id in window_ids if str(window_id).strip()}
        )
        if len(cleaned) <= self.window_selection_limit:
            return cleaned
        return sorted(
            cleaned,
            key=lambda window_id: self._stable_selection_key("window", window_id),
        )[: self.window_selection_limit]

    def _select_trajectories(self, trajectories: list[Any]) -> list[Any]:
        if self.max_trajectories is None or len(trajectories) <= self.max_trajectories:
            return trajectories

        def selection_key(trajectory: Any) -> tuple[str, str]:
            window_id = str(getattr(trajectory, "window_id", "") or "").strip()
            trajectory_id = str(getattr(trajectory, "trajectory_id", "") or "").strip()
            return self._stable_selection_key(
                "trajectory",
                f"{window_id}:{trajectory_id}",
            )

        return sorted(trajectories, key=selection_key)[: self.max_trajectories]

    def _build_data_provenance(self, trajectory_source: str) -> dict[str, object]:
        source_split = None
        if trajectory_source == "huggingface":
            source_split = self.hf_split
        elif trajectory_source == "local_export":
            source_split = "local_export"
        elif trajectory_source == "db":
            source_split = "db"

        return {
            "trajectory_source": trajectory_source,
            "source_split": source_split,
            "source_dir": self.source_dir,
            "hf_dataset": self.hf_dataset,
            "hf_split": self.hf_split if trajectory_source == "huggingface" else None,
            "lookback_hours": self.lookback_hours,
            "min_agents": self.min_agents,
            "min_actions": self.min_actions,
            "max_trajectories": self.max_trajectories,
            "window_selection_limit": self.window_selection_limit,
            "window_selection_policy": self.window_selection_policy,
            "candidate_window_count": self.source_window_count,
            "selected_window_ids": self.selected_window_ids,
            "selected_window_count": len(self.selected_window_ids),
            "selected_trajectory_count": self.selected_trajectory_count,
        }

    def _get_training_sample_count(self) -> int:
        if self.training_sample_count is not None:
            return self.training_sample_count
        if not self.generated_trajectories:
            self.training_sample_count = 0
            return 0
        self.training_sample_count = len(
            trajectories_to_training_samples(
                self.generated_trajectories,
                sample_profile=self.local_training_sample_profile,  # type: ignore[arg-type]
            )
        )
        return self.training_sample_count

    def _default_local_model_for_backend(self, backend: Literal["mlx", "cuda", "cpu"]) -> str:
        return default_local_model_for_backend(backend)

    def _persist_training_manifest(self) -> None:
        requested_recipe = self.local_training_recipe
        effective_recipe = self.effective_local_training_recipe or requested_recipe
        manifest = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "training_status": self.training_status,
            "backend": self.training_backend,
            "model_name": self.training_base_model,
            **effective_recipe.to_recipe_dict(),
            "remote_model_ref": self.training_remote_ref,
            "remote_base_model_ref": self.training_remote_base_ref,
            "remote_state_ref": self.training_remote_state_ref,
            "trajectory_count": len(self.generated_trajectories),
            "training_sample_count": self._get_training_sample_count(),
            "trajectory_source": self.trajectory_source,
            "source_dir": self.source_dir,
            "requested_recipe": requested_recipe.to_recipe_dict(),
            "effective_recipe": effective_recipe.to_recipe_dict(),
            "output_path": str(self.trained_model_path) if self.trained_model_path else None,
            "training_artifact": str(self.training_artifact_path)
            if self.training_artifact_path
            else None,
            "downloaded_checkpoint_archive": str(self.training_export_archive_path)
            if self.training_export_archive_path
            else None,
            "downloaded_adapter_path": str(self.training_export_dir)
            if self.training_export_dir
            else None,
            "training_metrics_path": str(self.training_metrics_path)
            if self.training_metrics_path
            else None,
            "capacity_report_path": str(self.training_capacity_report_path)
            if self.training_capacity_report_path
            else None,
            "training_export_error": self.training_export_error,
            "validation_passed": self.validation_passed,
            "data_provenance": self.data_provenance
            or self._build_data_provenance(self.trajectory_source or "db"),
            "window_selection_policy": self.window_selection_policy,
            "selected_window_ids": self.selected_window_ids,
            "selected_window_count": len(self.selected_window_ids),
            "selected_trajectory_count": self.selected_trajectory_count,
            "served_evaluation": {
                "report_path": str(self.served_eval_path),
                "summary": self.served_eval_summary,
            }
            if self.served_eval_path and self.served_eval_summary
            else None,
        }
        with open(self._get_training_manifest_path(), "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, indent=2)

    def _get_training_metrics_path(self) -> Path:
        return self.output_dir / "training_metrics.json"

    def _persist_tinker_metrics_summary(self, result: dict[str, object]) -> None:
        metrics_file = result.get("metrics_file")
        summary: dict[str, object] = {
            "backend": "tinker",
            "run_id": result.get("run_id"),
            "steps": result.get("steps"),
            "windows_processed": result.get("windows_processed"),
            "initial_sampler_path": result.get("initial_sampler_path"),
            "final_weights": result.get("final_weights"),
            "final_state_path": result.get("final_state_path"),
            "metrics_file": metrics_file,
        }

        metrics_rows: list[dict[str, object]] = []
        if isinstance(metrics_file, str) and metrics_file:
            metrics_path = Path(metrics_file)
            if metrics_path.exists():
                with metrics_path.open("r", encoding="utf-8") as handle:
                    for line in handle:
                        stripped = line.strip()
                        if not stripped:
                            continue
                        metrics_rows.append(json.loads(stripped))

        if metrics_rows:
            losses = [float(row.get("loss", 0.0)) for row in metrics_rows]
            avg_scores = [float(row.get("avg_score", 0.0)) for row in metrics_rows]
            summary.update(
                {
                    "step_count": len(metrics_rows),
                    "loss_last": losses[-1],
                    "loss_mean": round(sum(losses) / len(losses), 6),
                    "avg_score_last": avg_scores[-1],
                    "avg_score_mean": round(sum(avg_scores) / len(avg_scores), 6),
                    "num_samples_last": metrics_rows[-1].get("num_samples"),
                    "logprobs_mean_last": metrics_rows[-1].get("logprobs_mean"),
                    "pos_advantage_mean_last": metrics_rows[-1].get("pos_advantage_mean"),
                    "neg_advantage_mean_last": metrics_rows[-1].get("neg_advantage_mean"),
                }
            )

        with open(self._get_training_metrics_path(), "w", encoding="utf-8") as handle:
            json.dump(summary, handle, indent=2)

    def _load_existing_training_artifact(self) -> None:
        manifest_path = self._get_training_manifest_path()
        if manifest_path.exists():
            with open(manifest_path, encoding="utf-8") as handle:
                manifest = json.load(handle)

            output_path = manifest.get("output_path")
            training_artifact = manifest.get("training_artifact")
            if output_path and Path(output_path).exists():
                self.trained_model_path = Path(output_path)
                self.training_artifact_path = Path(training_artifact or output_path)
                training_metrics_path = manifest.get("training_metrics_path")
                capacity_report_path = manifest.get("capacity_report_path")
                if isinstance(training_metrics_path, str) and training_metrics_path:
                    self.training_metrics_path = Path(training_metrics_path)
                if isinstance(capacity_report_path, str) and capacity_report_path:
                    self.training_capacity_report_path = Path(capacity_report_path)
                self.training_status = str(manifest.get("training_status") or "trained")
                self.training_backend = manifest.get("backend")
                self.training_base_model = manifest.get("model_name")
                self.training_remote_ref = manifest.get("remote_model_ref")
                self.training_remote_base_ref = manifest.get("remote_base_model_ref")
                self.training_remote_state_ref = manifest.get("remote_state_ref")
                training_export_error = manifest.get("training_export_error")
                if isinstance(training_export_error, str) and training_export_error:
                    self.training_export_error = training_export_error
                self.data_provenance = manifest.get("data_provenance") or self.data_provenance
                self.window_selection_policy = (
                    manifest.get("window_selection_policy") or self.window_selection_policy
                )
                self.selected_window_ids = (
                    manifest.get("selected_window_ids") or self.selected_window_ids
                )
                self.selected_trajectory_count = int(
                    manifest.get("selected_trajectory_count") or self.selected_trajectory_count
                )
                sample_count = manifest.get("training_sample_count")
                if sample_count is not None:
                    self.training_sample_count = int(sample_count)
                archive_path = manifest.get("downloaded_checkpoint_archive")
                if archive_path and Path(archive_path).exists():
                    self.training_export_archive_path = Path(archive_path)
                export_dir = manifest.get("downloaded_adapter_path")
                if export_dir and Path(export_dir).exists():
                    self.training_export_dir = Path(export_dir)
                self.validation_passed = manifest.get("validation_passed")
                served_eval = manifest.get("served_evaluation") or {}
                report_path = served_eval.get("report_path")
                if report_path and Path(report_path).exists():
                    self.served_eval_path = Path(report_path)
                    self.served_eval_summary = served_eval.get("summary")
                return

            if training_artifact and Path(training_artifact).exists():
                self.training_artifact_path = Path(training_artifact)
                self.training_status = "prepared_data"
                self.training_backend = manifest.get("backend")
                self.training_base_model = manifest.get("model_name")
                self.training_remote_ref = manifest.get("remote_model_ref")
                self.training_remote_base_ref = manifest.get("remote_base_model_ref")
                self.training_remote_state_ref = manifest.get("remote_state_ref")
                training_export_error = manifest.get("training_export_error")
                if isinstance(training_export_error, str) and training_export_error:
                    self.training_export_error = training_export_error
                self.data_provenance = manifest.get("data_provenance") or self.data_provenance
                self.window_selection_policy = (
                    manifest.get("window_selection_policy") or self.window_selection_policy
                )
                self.selected_window_ids = (
                    manifest.get("selected_window_ids") or self.selected_window_ids
                )
                self.selected_trajectory_count = int(
                    manifest.get("selected_trajectory_count") or self.selected_trajectory_count
                )
                sample_count = manifest.get("training_sample_count")
                if sample_count is not None:
                    self.training_sample_count = int(sample_count)
                archive_path = manifest.get("downloaded_checkpoint_archive")
                if archive_path and Path(archive_path).exists():
                    self.training_export_archive_path = Path(archive_path)
                export_dir = manifest.get("downloaded_adapter_path")
                if export_dir and Path(export_dir).exists():
                    self.training_export_dir = Path(export_dir)
                self.validation_passed = manifest.get("validation_passed")
                served_eval = manifest.get("served_evaluation") or {}
                report_path = served_eval.get("report_path")
                if report_path and Path(report_path).exists():
                    self.served_eval_path = Path(report_path)
                    self.served_eval_summary = served_eval.get("summary")
                return

        config_path = self.output_dir / "training_data" / "training_config.json"
        if config_path.exists():
            with open(config_path, encoding="utf-8") as handle:
                config = json.load(handle)
            training_data_path = self.output_dir / "training_data.json"
            if training_data_path.exists():
                self.training_status = "prepared_data"
                self.training_artifact_path = training_data_path
                self.training_base_model = config.get("model_name")
                self.training_backend = config.get("backend")

    async def _run_served_comparison(
        self,
        *,
        timeout_seconds: int = 120,
    ) -> dict[str, object]:
        if (
            self.training_status != "trained"
            or not self.trained_model_path
            or not self.training_base_model
        ):
            return {
                "status": "skipped",
                "reason": "model comparison requires a trained artifact with a known base model",
            }

        if self.training_backend == "tinker":
            if not self.training_remote_ref or not self.training_remote_base_ref:
                return {
                    "status": "skipped",
                    "reason": "Tinker served comparison requires baseline and trained sampler checkpoint refs",
                    "remote_model_ref": self.training_remote_ref,
                }
            tinker_api_key = ensure_tinker_api_key_env()
            if not tinker_api_key:
                return {
                    "status": "skipped",
                    "reason": "Tinker served evaluation requires TINKER_API_KEY, TM_API_KEY, or THINKINGMACHINES_API_KEY",
                    "remote_model_ref": self.training_remote_ref,
                }

            from compare_served_models import generate_tinker_proxy_comparison_report

            output_path = self.output_dir / "served_eval_tinker.json"
            manifest_path = self._get_training_manifest_path()
            report = await asyncio.to_thread(
                generate_tinker_proxy_comparison_report,
                base_model_ref=self.training_remote_base_ref,
                trained_model_ref=self.training_remote_ref,
                timeout=timeout_seconds,
                output_path=output_path,
                manifest_path=manifest_path if manifest_path.exists() else None,
            )
            summary = {
                "base_summary": report["base_model"]["summary"],
                "trained_summary": report["adapter_model"]["summary"],
                "comparison": report["comparison"],
                "evaluation_kind": "served_tinker_proxy",
                "remote_model_ref": self.training_remote_ref,
                "remote_base_model_ref": self.training_remote_base_ref,
            }
            self.served_eval_path = output_path
            self.served_eval_summary = summary
            self._persist_training_manifest()
            return {
                "status": "completed",
                "report_path": str(output_path),
                "summary": summary,
            }

        manifest_path = self._get_training_manifest_path()
        evaluation_kind = "local_direct"
        if self.training_backend == "mlx":
            from compare_served_models import generate_comparison_report

            output_path = self.output_dir / "served_eval.json"
            report = await asyncio.to_thread(
                generate_comparison_report,
                model_name=self.training_base_model,
                adapter_path=str(self.trained_model_path),
                timeout=timeout_seconds,
                output_path=output_path,
                manifest_path=manifest_path if manifest_path.exists() else None,
            )
            summary = {
                "base_summary": report["base_model"]["summary"],
                "trained_summary": report["adapter_model"]["summary"],
                "comparison": report["comparison"],
                "evaluation_kind": "served_mlx",
            }
        else:
            from compare_local_models import generate_comparison_report

            output_path = self.output_dir / "local_model_comparison.json"
            report = await asyncio.to_thread(
                generate_comparison_report,
                model_name=self.training_base_model,
                trained_model_path=str(self.trained_model_path),
                backend=self.training_backend or "cpu",
                timeout=timeout_seconds,
                output_path=output_path,
                manifest_path=manifest_path if manifest_path.exists() else None,
            )
            summary = {
                "base_summary": report["base_model"]["summary"],
                "trained_summary": report["trained_model"]["summary"],
                "comparison": report["comparison"],
                "evaluation_kind": evaluation_kind,
            }

        self.served_eval_path = output_path
        self.served_eval_summary = summary
        self._persist_training_manifest()
        return {
            "status": "completed",
            "report_path": str(output_path),
            "summary": summary,
        }

    def _extract_tinker_archive(self, archive_path: Path, output_dir: Path) -> Path:
        output_dir.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive_path, "r:*") as handle:
            handle.extractall(output_dir)

        if (output_dir / "adapter_config.json").exists():
            return output_dir

        for candidate in output_dir.rglob("adapter_config.json"):
            return candidate.parent

        return output_dir

    async def _download_tinker_artifacts(self, trainer: object) -> None:
        if not self.training_remote_ref:
            return

        artifact_root = self.output_dir / "tinker_trained"
        archive_path = artifact_root / "checkpoint.tar"
        export_dir = artifact_root / "exported_adapter"
        self.training_export_error = None

        try:
            downloaded = await trainer.tinker_client.download_checkpoint_archive_async(  # type: ignore[attr-defined]
                tinker_path=self.training_remote_ref,
                output_path=archive_path,
            )
            self.training_export_archive_path = downloaded
            self.training_export_dir = self._extract_tinker_archive(
                downloaded,
                export_dir,
            )
            if self.training_export_dir.exists():
                self.trained_model_path = self.training_export_dir
                self.training_artifact_path = artifact_root
        except Exception as exc:
            self.training_export_error = str(exc)
            logger.warning(
                "Failed to download Tinker checkpoint archive for %s: %s",
                self.training_remote_ref,
                exc,
            )

    async def score_trajectories(self):
        """Score trajectories using heuristics and relative comparison"""
        from src.training import composite_reward, relative_scores
        from src.training.rewards import TrajectoryRewardInputs

        if not self.generated_trajectories:
            logger.warning("No trajectories to score")
            return

        logger.info(f"Scoring {len(self.generated_trajectories)} trajectories...")

        absolute_rewards = []
        for trajectory in self.generated_trajectories:
            total_actions = len(trajectory.steps)
            successful_actions = sum(
                1 for step in trajectory.steps if step.action is not None and step.action.success
            )
            absolute_rewards.append(
                composite_reward(
                    TrajectoryRewardInputs(
                        final_pnl=trajectory.final_pnl,
                        starting_balance=10000.0,
                        end_balance=10000.0 + trajectory.final_pnl,
                        num_steps=trajectory.episode_length or total_actions,
                        trades_executed=trajectory.trades_executed or 0,
                        total_actions=total_actions,
                        successful_actions=successful_actions,
                    )
                )
            )

        self.scores = relative_scores(absolute_rewards)

        # Log top/bottom performers
        scored = list(zip(self.generated_trajectories, self.scores, strict=False))
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
            raise ValueError("No scored trajectories available for training")

        logger.info("Preparing training data...")

        tinker_api_key = ensure_tinker_api_key_env()
        prefer_tinker = self.training_backend_preference == "tinker"
        prefer_local = self.training_backend_preference == "local"

        if prefer_tinker and not tinker_api_key:
            raise ValueError(
                "training backend 'tinker' requires TINKER_API_KEY, TM_API_KEY, or THINKINGMACHINES_API_KEY"
            )

        if prefer_tinker or (self.training_backend_preference == "auto" and tinker_api_key):
            await self._train_with_tinker()
        elif self.local_training_enabled or prefer_local:
            logger.info("Using local training backend")
            await self._train_locally()
        else:
            logger.warning(
                "No Tinker API key env set - preparing local training data only; no trained model weights will be produced"
            )
            # Fall back to local training data preparation
            await self._prepare_local_training_data()

    async def _fallback_after_tinker_failure(self, reason: str) -> None:
        if self.local_training_enabled:
            logger.warning(
                "Tinker training failed: %s. Falling back to local training.",
                reason,
            )
            try:
                await self._train_locally()
                return
            except Exception as local_exc:
                raise RuntimeError(
                    f"Tinker training failed ({reason}) and local fallback failed ({local_exc})"
                ) from local_exc

        logger.warning(
            "Tinker training failed: %s. Preparing local training data only because local training is disabled.",
            reason,
        )
        await self._prepare_local_training_data()

    async def _train_with_tinker(self):
        """Train using the Tinker-backed Atropos/GRPO path."""
        from src.training.tinker_client import TINKER_AVAILABLE
        from src.training.tinker_trainer import BabylonTinkerTrainer, TinkerTrainingConfig

        strict_tinker = self.training_backend_preference == "tinker"

        if not TINKER_AVAILABLE:
            if strict_tinker:
                raise RuntimeError("Tinker not installed. Install with: pip install tinker")
            await self._fallback_after_tinker_failure(
                "Tinker not installed. Install with: pip install tinker"
            )
            return

        logger.info("Using Tinker + Atropos for cloud GRPO training")

        config = TinkerTrainingConfig(
            base_model=self.model_name,
            training_steps=self.tinker_training_steps,
            group_size=self.tinker_group_size,
            learning_rate=self.tinker_learning_rate,
            lora_rank=self.tinker_lora_rank,
            weight_sync_interval=self.tinker_weight_sync_interval,
            database_url=self.database_url,
            log_file=str(self.output_dir / "tinker_training_metrics.jsonl"),
            max_trade_examples_per_trajectory=3,
            alignment_passes=max(2, min(6, self.tinker_training_steps // 6)),
            alignment_score=0.35,
            decision_alignment_passes=max(3, min(8, self.tinker_training_steps // 6)),
            decision_alignment_score=0.4,
        )

        trainer = BabylonTinkerTrainer(config)

        try:
            result = await trainer.train_from_scored_groups(self._build_tinker_scored_groups())

            if result.get("success"):
                artifact_root = self.output_dir / "tinker_trained"
                artifact_root.mkdir(parents=True, exist_ok=True)
                self.trained_model_path = artifact_root
                self.training_artifact_path = artifact_root
                self.training_status = "trained"
                self.training_remote_ref = result.get("final_weights")
                self.training_remote_base_ref = result.get("initial_sampler_path")
                self.training_remote_state_ref = result.get("final_state_path")

                # Save training result
                with open(artifact_root / "training_result.json", "w") as f:
                    json.dump(result, f, indent=2, default=str)

                await self._download_tinker_artifacts(trainer)

                logger.info("Tinker + Atropos training complete!")
                logger.info(f"  Run ID: {result.get('run_id')}")
                logger.info(f"  Steps: {result.get('steps')}")
                logger.info(f"  Final weights: {result.get('final_weights')}")
                self.training_backend = "tinker"
                self.training_base_model = self.model_name
                self.validation_passed = None
                self._persist_tinker_metrics_summary(result)
                self._persist_training_manifest()
            else:
                reason = str(
                    result.get("error")
                    or result.get("message")
                    or "Tinker returned an unsuccessful result"
                )
                logger.error("Tinker + Atropos training failed: %s", reason)
                if strict_tinker:
                    raise RuntimeError(f"Tinker training failed: {reason}")
                await self._fallback_after_tinker_failure(reason)
        except Exception as e:
            if strict_tinker:
                raise
            await self._fallback_after_tinker_failure(str(e))

    async def _train_locally(self):
        """Train locally using the same helpers as train_local.py."""
        backend = self.local_training_backend or detect_backend()
        model_name = self.local_training_model or self._default_local_model_for_backend(backend)
        effective_recipe = self.local_training_recipe.with_overrides(
            backend=backend,
            model=model_name,
        )
        if effective_recipe.optimizer == "apollo" and effective_recipe.use_lora:
            logger.info(
                "APOLLO selected for FullPipeline local training; disabling LoRA for full-parameter fine-tuning."
            )
            effective_recipe = effective_recipe.with_overrides(use_lora=False)
        if backend != "cuda" and effective_recipe.quantization != "none":
            raise ValueError("NF4 quantization is only supported on the CUDA backend.")
        if backend != "cuda" and effective_recipe.optimizer == "apollo":
            raise ValueError("APOLLO is only supported on the CUDA backend.")

        self.effective_local_training_recipe = effective_recipe
        samples = trajectories_to_training_samples(
            self.generated_trajectories,
            sample_profile=effective_recipe.sample_profile,  # type: ignore[arg-type]
        )
        # Mix format recovery examples for output-shape stability (Stage 3 of paper)
        if self.format_recovery_dir and self.format_recovery_ratio > 0.0:
            try:
                recovery_trajectories = load_json_training_data(
                    self.format_recovery_dir,
                    500,
                )
                if recovery_trajectories:
                    recovery_samples = trajectories_to_training_samples(
                        recovery_trajectories,
                        sample_profile=effective_recipe.sample_profile,
                    )
                    target_count = max(1, int(len(samples) * self.format_recovery_ratio))
                    import random

                    rng = random.Random(42)
                    if len(recovery_samples) > target_count:
                        recovery_samples = rng.sample(recovery_samples, target_count)
                    samples.extend(recovery_samples)
                    rng.shuffle(samples)
                    logger.info(
                        "Mixed %d format recovery samples into training (%.0f%% ratio)",
                        len(recovery_samples),
                        self.format_recovery_ratio * 100,
                    )
            except Exception as exc:
                logger.warning("Could not load format recovery data: %s", exc)

        self.training_sample_count = len(samples)
        if len(samples) < 10:
            raise ValueError(
                f"Not enough local training samples after preprocessing: {len(samples)}"
            )

        logger.info(
            "Using local training backend",
            extra={
                "backend": backend,
                "model": model_name,
                "steps": effective_recipe.steps,
                "batch_size": effective_recipe.batch_size,
            },
        )
        logger.info(
            "Local training config: backend=%s, model=%s, steps=%s, batch_size=%s",
            backend,
            model_name,
            effective_recipe.steps,
            effective_recipe.batch_size,
        )

        if backend == "mlx":
            model_path = train_mlx(
                samples,
                model_name,
                str(self.output_dir),
                effective_recipe.steps,
                effective_recipe.batch_size,
                effective_recipe.learning_rate,
            )
            base_model = model_name
        elif backend == "cuda":
            model_path = train_cuda(
                samples,
                model_name,
                str(self.output_dir),
                epochs=1,
                **effective_recipe.to_cuda_training_kwargs(),
            )
            base_model = None
        else:
            model_path = train_cpu(
                samples,
                model_name,
                str(self.output_dir),
                epochs=1,
                **effective_recipe.to_cpu_training_kwargs(),
            )
            base_model = None

        validation_passed: bool | None = None
        if self.local_validate:
            validation_passed = validate_trained_model(
                model_path,
                backend,
                base_model,
            )

        self.trained_model_path = Path(model_path)
        self.training_artifact_path = self._get_training_manifest_path()
        self.training_status = "trained"
        self.training_backend = backend
        self.training_base_model = model_name
        self.training_remote_ref = None
        self.training_remote_base_ref = None
        self.training_remote_state_ref = None
        self.training_export_archive_path = None
        self.training_export_dir = None
        metrics_path = self._get_training_metrics_path()
        capacity_report_path = self.output_dir / "training_capacity_report.json"
        self.training_metrics_path = metrics_path if metrics_path.exists() else None
        self.training_capacity_report_path = (
            capacity_report_path if capacity_report_path.exists() else None
        )
        self.validation_passed = validation_passed
        self._persist_training_manifest()

        logger.info("Local training complete")
        logger.info(f"  Backend: {backend}")
        logger.info(f"  Model: {model_name}")
        logger.info(f"  Output: {model_path}")
        if validation_passed is not None:
            logger.info(f"  Validation passed: {validation_passed}")

    async def _prepare_local_training_data(self):
        """Prepare training data for local training (Atropos/vLLM)"""
        from src.training import MultiPromptDatasetBuilder

        # Use multi-prompt dataset builder for comprehensive training
        builder = MultiPromptDatasetBuilder()
        if not self.selected_window_ids:
            self.selected_window_ids = sorted(
                {
                    str(getattr(trajectory, "window_id", "") or "").strip()
                    for trajectory in self.generated_trajectories
                    if str(getattr(trajectory, "window_id", "") or "").strip()
                },
                reverse=True,
            )
        self.selected_trajectory_count = len(self.generated_trajectories)
        if not self.data_provenance:
            self.data_provenance = self._build_data_provenance(self.trajectory_source or "db")

        for traj, score in zip(self.generated_trajectories, self.scores, strict=False):
            # Normalize score to 0-1 range
            normalized_score = (score + 2) / 4  # Assuming scores in [-2, 2] range
            normalized_score = max(0, min(1, normalized_score))
            builder.add_trajectory(traj, trajectory_score=normalized_score)

        stats = builder.get_statistics()
        self.training_sample_count = int(stats["total_samples"])
        logger.info("Training data prepared:")
        logger.info(f"  - Trajectories: {stats['total_trajectories']}")
        logger.info(f"  - Total samples: {stats['total_samples']}")
        for purpose, purpose_stats in stats["by_purpose"].items():
            logger.info(
                f"  - {purpose}: {purpose_stats['count']} samples, avg_score={purpose_stats['avg_score']:.3f}"
            )

        # Save training data
        training_data_path = self.output_dir / "training_data.json"
        builder.save_dataset(str(training_data_path))
        logger.info(f"Training data saved to: {training_data_path}")

        # Note about requirements
        logger.info("\nTo train locally, you need:")
        logger.info("  1. Atropos API server running (run-api)")
        logger.info("  2. vLLM server with base model")
        logger.info(
            "  3. Or set TINKER_API_KEY (or TM_API_KEY / THINKINGMACHINES_API_KEY) for cloud training"
        )

        # Save training metadata separately so prepared data is not mistaken for trained weights
        training_metadata_dir = self.output_dir / "training_data"
        training_metadata_dir.mkdir(parents=True, exist_ok=True)
        self.trained_model_path = None
        self.training_artifact_path = training_data_path
        self.training_status = "prepared_data"
        self.training_backend = None
        self.training_base_model = self.model_name
        self.training_remote_ref = None
        self.training_remote_base_ref = None
        self.training_remote_state_ref = None
        self.training_export_archive_path = None
        self.training_export_dir = None
        self.validation_passed = None

        # Save training config for reference
        config = {
            "model_name": self.model_name,
            "num_trajectories": len(self.generated_trajectories),
            "num_samples": stats["total_samples"],
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "training_method": "prepared_data",
            "data_provenance": self.data_provenance
            or self._build_data_provenance(self.trajectory_source or "db"),
            "window_selection_policy": self.window_selection_policy,
            "selected_window_ids": self.selected_window_ids,
            "selected_window_count": len(self.selected_window_ids),
            "selected_trajectory_count": self.selected_trajectory_count,
        }
        with open(training_metadata_dir / "training_config.json", "w") as f:
            json.dump(config, f, indent=2)

        logger.info(f"Training config saved to: {training_metadata_dir}")
        self._persist_training_manifest()

    async def run_benchmark(self):
        """Compare base model vs trained model"""
        if self.training_status == "not_started":
            self._load_existing_training_artifact()

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

        trained_model_result: dict[str, object]
        if self.training_status == "trained" and self.trained_model_path:
            if self.training_backend == "tinker":
                trained_model_result = {
                    "model": str(self.trained_model_path),
                    "status": "remote_checkpoint",
                    "backend": self.training_backend,
                    "base_model": self.training_base_model,
                    "remote_model_ref": self.training_remote_ref,
                    "remote_base_model_ref": self.training_remote_base_ref,
                    "downloaded_checkpoint_archive": str(self.training_export_archive_path)
                    if self.training_export_archive_path
                    else None,
                    "downloaded_adapter_path": str(self.training_export_dir)
                    if self.training_export_dir
                    else None,
                    "validation_passed": None,
                }
            else:
                validation_passed = self.validation_passed
                if validation_passed is None and self.training_backend:
                    validation_passed = validate_trained_model(
                        str(self.trained_model_path),
                        self.training_backend,  # type: ignore[arg-type]
                        self.training_base_model if self.training_backend == "mlx" else None,
                    )
                    self.validation_passed = validation_passed
                    self._persist_training_manifest()

                trained_model_result = {
                    "model": str(self.trained_model_path),
                    "status": "validated" if validation_passed else "validation_failed",
                    "backend": self.training_backend,
                    "base_model": self.training_base_model,
                    "validation_passed": validation_passed,
                }
        elif self.training_status == "prepared_data":
            trained_model_result = {
                "model": str(self.training_artifact_path) if self.training_artifact_path else None,
                "status": "prepared_data",
                "note": "Training data is available, but model weights were not produced in this run",
            }
        else:
            trained_model_result = {
                "model": None,
                "status": "not_found",
                "note": "No trained model metadata was found in the benchmark output directory",
            }

        served_eval_result: dict[str, object]
        try:
            if not self.served_eval_path:
                served_eval_result = await self._run_served_comparison()
            else:
                served_eval_result = {
                    "status": "completed",
                    "report_path": str(self.served_eval_path),
                    "summary": self.served_eval_summary,
                }
        except Exception as exc:
            logger.warning("Served comparison failed: %s", exc)
            served_eval_result = {
                "status": "error",
                "error": str(exc),
            }

        self.benchmark_results = {
            "base_model": {
                "model": self.model_name,
                "agents": len(self.generated_trajectories),
                "avg_pnl": base_avg_pnl,
                "best_pnl": base_best_pnl,
                "worst_pnl": base_worst_pnl,
            },
            "trained_model": trained_model_result,
            "served_evaluation": served_eval_result,
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

    def _step_to_tinker_payload(self, step: object) -> dict:
        if hasattr(step, "model_dump"):
            return step.model_dump(by_alias=True)  # type: ignore[no-any-return]
        if isinstance(step, dict):
            return step
        raise TypeError(f"Unsupported trajectory step type: {type(step)!r}")

    def _trajectory_to_tinker_payload(self, trajectory: object) -> dict:
        if hasattr(trajectory, "model_dump"):
            payload = trajectory.model_dump(by_alias=True)  # type: ignore[assignment]
        elif isinstance(trajectory, dict):
            payload = dict(trajectory)
        else:
            raise TypeError(f"Unsupported trajectory type: {type(trajectory)!r}")

        payload["steps"] = [self._step_to_tinker_payload(step) for step in payload.get("steps", [])]
        payload["window_id"] = payload.get("windowId") or payload.get("window_id") or "default"
        payload["scenario_id"] = payload.get("scenarioId") or payload.get("scenario_id")
        payload["trajectory_id"] = payload.get("trajectoryId") or payload.get("trajectory_id")
        payload["agent_id"] = payload.get("agentId") or payload.get("agent_id")
        return payload

    @staticmethod
    def _extract_market_candidates_from_step(step: dict) -> list[str]:
        action = step.get("action", {})
        if not isinstance(action, dict):
            action = {}
        parameters = action.get("parameters", {})
        if not isinstance(parameters, dict):
            parameters = {}
        candidates = [
            parameters.get("marketId"),
            parameters.get("market"),
            parameters.get("questionId"),
            parameters.get("token"),
            parameters.get("asset"),
            parameters.get("ticker"),
            parameters.get("symbol"),
        ]
        observation = step.get("observation", {})
        if isinstance(observation, dict):
            market = observation.get("market", {})
            if isinstance(market, dict):
                candidates.extend(
                    [
                        market.get("marketId"),
                        market.get("id"),
                        market.get("symbol"),
                        market.get("ticker"),
                        market.get("question"),
                    ]
                )
        return [str(candidate).strip() for candidate in candidates if str(candidate or "").strip()]

    @classmethod
    def _infer_dominant_market_key(cls, payload: dict) -> str | None:
        counts: Counter[str] = Counter()
        for step in payload.get("steps", []):
            if not isinstance(step, dict):
                continue
            candidates = cls._extract_market_candidates_from_step(step)
            if candidates:
                counts[candidates[0]] += 1
        if not counts:
            return None
        return counts.most_common(1)[0][0]

    def _build_global_tinker_group(
        self,
        payloads: list[tuple[dict, float]],
        *,
        group_key: str = "global_fallback",
    ) -> list[dict]:
        if len(payloads) < 2:
            return []
        return [
            {
                "group_key": group_key,
                "trajectories": [payload for payload, _score in payloads],
                "scores": [score for _payload, score in payloads],
            }
        ]

    def _build_score_stratified_tinker_groups(
        self,
        payloads: list[tuple[dict, float]],
    ) -> list[dict]:
        if len(payloads) < 2:
            return []

        min_stratified_trajectories = self.tinker_group_size * 2
        if len(payloads) < min_stratified_trajectories:
            logger.info(
                "Falling back to a single global Tinker scored group because only %s comparable trajectories are available",
                len(payloads),
            )
            return self._build_global_tinker_group(payloads)

        ordered_payloads = sorted(
            payloads,
            key=lambda item: (
                -float(item[1]),
                self._stable_selection_key(
                    "tinker_group_fallback",
                    ":".join(
                        [
                            str(item[0].get("window_id") or "").strip(),
                            str(item[0].get("scenario_id") or "").strip(),
                            str(
                                item[0].get("trajectory_id") or item[0].get("agent_id") or ""
                            ).strip(),
                        ]
                    ),
                ),
            ),
        )
        target_group_count = max(2, len(ordered_payloads) // self.tinker_group_size)
        candidate_groups = [
            {
                "group_key": f"score_stratified_fallback_{index:03d}",
                "trajectories": [],
                "scores": [],
            }
            for index in range(target_group_count)
        ]

        for index, (payload, score) in enumerate(ordered_payloads):
            group = candidate_groups[index % target_group_count]
            group["trajectories"].append(payload)
            group["scores"].append(score)

        groups = [group for group in candidate_groups if len(group.get("trajectories", [])) >= 2]
        if groups:
            logger.info(
                "Falling back to %s score-stratified Tinker groups because strict grouping produced only singleton groups",
                len(groups),
            )
            return groups

        logger.info(
            "Falling back to a single global Tinker scored group because score-stratified grouping produced no comparable pairs"
        )
        return self._build_global_tinker_group(payloads)

    def _build_tinker_scored_groups(self) -> list[dict]:
        payloads = [
            (self._trajectory_to_tinker_payload(trajectory), float(score))
            for trajectory, score in zip(self.generated_trajectories, self.scores, strict=False)
        ]

        def partition_groups(key_builder) -> tuple[list[dict], list[tuple[dict, float]]]:
            groups: dict[str, dict[str, object]] = {}
            for payload, score in payloads:
                group_key = key_builder(payload)
                group = groups.setdefault(
                    group_key,
                    {
                        "group_key": group_key,
                        "trajectories": [],
                        "scores": [],
                    },
                )
                group["trajectories"].append(payload)
                group["scores"].append(score)
            comparable_groups: list[dict] = []
            singleton_payloads: list[tuple[dict, float]] = []
            for group in groups.values():
                trajectories = group.get("trajectories", [])
                scores = group.get("scores", [])
                if len(trajectories) >= 2:
                    comparable_groups.append(group)
                    continue
                singleton_payloads.extend(zip(trajectories, scores, strict=False))
            return comparable_groups, singleton_payloads

        strict_groups, strict_singletons = partition_groups(
            lambda payload: (
                f"{payload.get('window_id') or 'default'!s}_"
                f"{payload.get('scenario_id') or 'default'}"
                + (
                    f"__dominant_market_{dominant_market}"
                    if (dominant_market := self._infer_dominant_market_key(payload))
                    else ""
                )
            )
        )
        if strict_groups:
            fallback_groups = self._build_score_stratified_tinker_groups(strict_singletons)
            if fallback_groups:
                logger.info(
                    "Keeping %s strict Tinker groups and adding %s fallback groups for singleton trajectories",
                    len(strict_groups),
                    len(fallback_groups),
                )
            return strict_groups + fallback_groups

        scenario_groups, scenario_singletons = partition_groups(
            lambda payload: str(payload.get("scenario_id") or "default")
        )
        if scenario_groups:
            fallback_groups = self._build_score_stratified_tinker_groups(scenario_singletons)
            logger.info(
                "Falling back to scenario-level Tinker groups because strict grouping produced no comparable pairs"
            )
            if fallback_groups:
                logger.info(
                    "Keeping %s scenario-level Tinker groups and adding %s fallback groups for singleton trajectories",
                    len(scenario_groups),
                    len(fallback_groups),
                )
            return scenario_groups + fallback_groups

        return self._build_score_stratified_tinker_groups(payloads)


async def main():
    parser = argparse.ArgumentParser(
        description="Babylon local SFT stage (internal helper for the canonical pipeline)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--mode",
        choices=["full", "generate", "train", "benchmark"],
        default="full",
        help="Pipeline mode",
    )
    parser.add_argument(
        "--model",
        default="Qwen/Qwen3.5-4B",
        help="Model to use (e.g., Qwen/Qwen3.5-4B, Qwen/Qwen3.5-9B)",
    )
    parser.add_argument("--agents", type=int, default=10, help="Number of agents to run")
    parser.add_argument("--ticks", type=int, default=100, help="Ticks per agent")
    parser.add_argument("--output", default="./trained_models", help="Output directory")
    parser.add_argument("--no-wandb", action="store_true", help="Disable W&B logging")
    parser.add_argument(
        "--skip-benchmark",
        action="store_true",
        help="Skip the benchmark phase when running the full pipeline",
    )
    parser.add_argument(
        "--prepare-only",
        action="store_true",
        help="Prepare ranked training data only; skip local training fallback when Tinker is unavailable",
    )
    parser.add_argument(
        "--training-backend",
        choices=["auto", "local", "tinker"],
        default="auto",
        help="Preferred training backend for this stage",
    )
    parser.add_argument(
        "--trajectory-source",
        choices=["db", "huggingface", "local_export"],
        default=None,
        help="Where to load trajectories from",
    )
    parser.add_argument(
        "--source-dir",
        default=None,
        help="Local Babylon export directory when --trajectory-source=local_export",
    )
    parser.add_argument(
        "--hf-dataset",
        default=None,
        help="Hugging Face dataset id to use when --trajectory-source=huggingface",
    )
    parser.add_argument(
        "--hf-split",
        default="raw",
        help="Hugging Face dataset split to use when --trajectory-source=huggingface",
    )
    add_local_training_arguments(parser)
    parser.add_argument(
        "--tinker-steps",
        type=int,
        default=100,
        help="Tinker training steps",
    )
    parser.add_argument(
        "--tinker-group-size",
        type=int,
        default=4,
        help="Tinker GRPO group size",
    )
    parser.add_argument(
        "--tinker-lr",
        type=float,
        default=4e-5,
        help="Tinker learning rate",
    )
    parser.add_argument(
        "--tinker-lora-rank",
        type=int,
        default=32,
        help="Tinker LoRA rank",
    )
    parser.add_argument(
        "--tinker-weight-sync-interval",
        type=int,
        default=5,
        help="Tinker weight sync interval in steps",
    )
    parser.add_argument(
        "--no-local-validate",
        action="store_true",
        help="Skip the post-training local validation prompt",
    )
    parser.add_argument(
        "--lookback-hours",
        type=int,
        default=72,
        help="Hours of trajectory history to consider during data loading",
    )
    parser.add_argument(
        "--min-agents",
        type=int,
        default=1,
        help="Minimum distinct agents required per selected window",
    )
    parser.add_argument(
        "--min-actions",
        type=int,
        default=1,
        help="Minimum usable action-bearing steps required per trajectory during data loading",
    )
    parser.add_argument(
        "--window-selection-limit",
        type=int,
        default=50,
        help="Maximum windows selected by the deterministic curation policy",
    )
    parser.add_argument(
        "--max-trajectories",
        type=int,
        default=0,
        help="Optional cap on loaded trajectories (0 keeps all available trajectories)",
    )
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
    parser.add_argument(
        "--list-archetypes", action="store_true", help="List all available archetypes and exit"
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
        from src.training import ArchetypeTrainer, ArchetypeTrainingConfig

        config = ArchetypeTrainingConfig(
            base_model=args.model,
            training_steps=args.local_steps,
            batch_size=args.local_batch_size,
            learning_rate=args.local_lr,
            lookback_hours=args.lookback_hours,
            min_actions=args.min_actions,
            max_trajectories=args.max_trajectories or 500,
            database_url=os.getenv("DATABASE_URL"),
            output_dir=args.output,
            local_backend=args.local_backend,
            local_model=args.local_model,
            local_validate=not args.no_local_validate,
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
                ],
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
    local_training_recipe = local_training_recipe_from_args(args)
    pipeline = FullPipeline(
        model_name=args.model,
        num_agents=args.agents,
        ticks_per_agent=args.ticks,
        output_dir=args.output,
        use_wandb=not args.no_wandb,
        skip_benchmark=args.skip_benchmark,
        local_training_enabled=not args.prepare_only,
        training_backend_preference=args.training_backend,
        trajectory_source=args.trajectory_source,
        source_dir=args.source_dir,
        hf_dataset=args.hf_dataset,
        hf_split=args.hf_split,
        tinker_training_steps=args.tinker_steps,
        tinker_group_size=args.tinker_group_size,
        tinker_learning_rate=args.tinker_lr,
        tinker_lora_rank=args.tinker_lora_rank,
        tinker_weight_sync_interval=args.tinker_weight_sync_interval,
        local_validate=not args.no_local_validate,
        lookback_hours=args.lookback_hours,
        min_agents=args.min_agents,
        min_actions=args.min_actions,
        max_trajectories=args.max_trajectories,
        window_selection_limit=args.window_selection_limit,
        **local_training_recipe.to_prefixed_dict("local_training"),
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
        result = {
            "training_status": pipeline.training_status,
            "trained_model": str(pipeline.trained_model_path)
            if pipeline.trained_model_path
            else None,
            "training_artifact": str(pipeline.training_artifact_path)
            if pipeline.training_artifact_path
            else None,
            "training_export_error": pipeline.training_export_error,
        }
    elif args.mode == "benchmark":
        await pipeline.generate_data()
        await pipeline.run_benchmark()
        result = pipeline.benchmark_results

    print(f"\nResult: {json.dumps(result, indent=2, default=str)}")


if __name__ == "__main__":
    asyncio.run(main())
