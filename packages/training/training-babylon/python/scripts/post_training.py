#!/usr/bin/env python3
"""
Post-Training Pipeline

Orchestrates post-training actions after GRPO training completes:
1. Push model to HuggingFace Hub (if configured)
2. Run benchmark suite on final model (if enabled)
3. Generate training summary

Usage:
    # Called automatically by run_training.py after training completes
    from scripts.post_training import run_post_training

    run_post_training(
        model_path="./trained_models/final_model",
        training_steps=1000,
        final_reward=0.75,
        wandb_run_id="abc123",
    )

    # Or run standalone
    python scripts/post_training.py \
        --model-path ./trained_models/final_model \
        --training-steps 1000 \
        --final-reward 0.75

Environment Variables:
    HF_PUSH_REPO: HuggingFace repo ID for model push (optional)
    HF_MODEL_CODENAME: Model codename for model card (default: ishtar)
    HF_MODEL_PRIVATE: Make repo private (default: false)
    HF_PUSH_CHECKPOINTS: Also push checkpoints (default: false)
    BENCHMARK_ENABLED: Run benchmark after training (default: false)
    BENCHMARK_MODE: quick or full (default: quick)
"""

import argparse
import json
import logging
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


# Babylon-inspired model codenames with meanings
CODENAMES = {
    "ishtar": "Goddess of love and war - aggressive trading models",
    "marduk": "Chief deity - flagship/best models",
    "gilgamesh": "Epic hero - long-horizon models",
    "enkidu": "Wild man, friend of Gilgamesh - baseline/simple models",
    "shamash": "Sun god, god of justice - balanced/fair models",
    "tiamat": "Primordial goddess of chaos - experimental/volatile models",
    "nabu": "God of wisdom and writing - analyst-focused models",
    "ziggurat": "Temple tower - multi-layer/ensemble models",
    "euphrates": "River of Babylon - flow/momentum models",
    "hammurabi": "Famous king/lawgiver - rule-based hybrid models",
}


@dataclass
class PostTrainingConfig:
    """Configuration for post-training actions."""

    model_path: str
    training_steps: int
    final_reward: float
    final_metrics: dict[str, Any] | None = None
    wandb_run_id: str | None = None
    base_model: str = "Qwen/Qwen3.5-4B"
    dataset_id: str | None = None
    report_path: str | None = None

    # HuggingFace push settings
    hf_push_repo: str | None = None
    hf_model_codename: str = "ishtar"
    hf_model_private: bool = False
    hf_push_checkpoints: bool = False

    # Benchmark settings
    benchmark_enabled: bool = False
    benchmark_mode: str = "quick"
    benchmark_scenarios: str | None = None
    benchmark_output_dir: str = "./benchmark-results"

    @classmethod
    def from_env(cls, model_path: str, training_steps: int, final_reward: float, **kwargs):
        """Create config from environment variables."""
        report_path = kwargs.get("report_path")
        if not report_path:
            report_path = str(Path(model_path).parent / "post_training_report.json")
        return cls(
            model_path=model_path,
            training_steps=training_steps,
            final_reward=final_reward,
            final_metrics=kwargs.get("final_metrics"),
            wandb_run_id=kwargs.get("wandb_run_id") or os.environ.get("WANDB_RUN_ID"),
            base_model=kwargs.get("base_model", "Qwen/Qwen3.5-4B"),
            dataset_id=kwargs.get("dataset_id") or os.environ.get("HF_TRAJECTORY_DATASET"),
            report_path=report_path,
            hf_push_repo=os.environ.get("HF_PUSH_REPO", ""),
            hf_model_codename=os.environ.get("HF_MODEL_CODENAME", "ishtar"),
            hf_model_private=os.environ.get("HF_MODEL_PRIVATE", "false").lower() == "true",
            hf_push_checkpoints=os.environ.get("HF_PUSH_CHECKPOINTS", "false").lower() == "true",
            benchmark_enabled=os.environ.get("BENCHMARK_ENABLED", "false").lower() == "true",
            benchmark_mode=os.environ.get("BENCHMARK_MODE", "quick"),
            benchmark_scenarios=os.environ.get("BENCHMARK_SCENARIOS"),
            benchmark_output_dir=os.environ.get("BENCHMARK_OUTPUT_DIR", "./benchmark-results"),
        )


def push_model_to_hub(config: PostTrainingConfig) -> bool:
    """
    Push trained model to HuggingFace Hub.

    Returns True if successful, False otherwise.
    """
    if not config.hf_push_repo:
        logger.info("HF_PUSH_REPO not set, skipping model push")
        return False

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        logger.warning("HF_TOKEN not set, skipping model push")
        return False

    model_path = Path(config.model_path)
    if not model_path.exists():
        logger.error(f"Model path does not exist: {model_path}")
        return False

    logger.info("=" * 60)
    logger.info("PUSHING MODEL TO HUGGINGFACE")
    logger.info("=" * 60)
    logger.info(f"  Repo: {config.hf_push_repo}")
    logger.info(f"  Model: {model_path}")
    logger.info(f"  Codename: {config.hf_model_codename}")

    # Use the push_model_to_hf.py script
    push_script = Path(__file__).parent / "hf" / "push_model_to_hf.py"

    cmd = [
        sys.executable,
        str(push_script),
        "--adapter-path",
        str(model_path),
        "--repo-id",
        config.hf_push_repo,
        "--base-model",
        config.base_model,
        "--training-method",
        "rl",
        "--training-steps",
        str(config.training_steps),
        "--final-reward",
        str(config.final_reward),
        "--codename",
        config.hf_model_codename,
    ]

    if config.wandb_run_id:
        cmd.extend(["--wandb-run-id", config.wandb_run_id])

    if config.dataset_id:
        cmd.extend(["--dataset-id", config.dataset_id])

    if config.hf_model_private:
        cmd.append("--private")

    logger.info(f"Running: {' '.join(cmd)}")

    try:
        # Use 1 hour timeout for model upload (large models can take a while)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    except subprocess.TimeoutExpired:
        logger.error("Model push timed out after 1 hour")
        return False

    if result.returncode != 0:
        logger.error(f"Model push failed: {result.stderr}")
        return False

    logger.info(result.stdout)
    logger.info(f"✓ Model pushed to https://huggingface.co/{config.hf_push_repo}")

    return True


def run_benchmark(config: PostTrainingConfig) -> bool:
    """
    Run benchmark suite on the trained model.

    Note: This runs on the host machine after training, not inside Docker,
    because the TypeScript benchmark requires the full monorepo.

    Returns True if successful, False otherwise.
    """
    if not config.benchmark_enabled:
        logger.info("BENCHMARK_ENABLED not set, skipping benchmark")
        return False

    model_path = Path(config.model_path)
    if not model_path.exists():
        logger.error(f"Model path does not exist: {model_path}")
        return False

    logger.info("=" * 60)
    logger.info("RUNNING BENCHMARK SUITE")
    logger.info("=" * 60)
    logger.info(f"  Model: {model_path}")
    logger.info(f"  Mode: {config.benchmark_mode}")

    # Check if bun is available (for TypeScript benchmark)
    import shutil

    if not shutil.which("bun"):
        logger.warning("Bun not found. Benchmark requires host-side execution.")
        logger.warning("Run benchmark manually after training:")
        logger.warning(f"  bun run scripts/run-benchmark-suite.ts --model {model_path}")
        return False

    # Build benchmark command
    # Find the benchmark script relative to this script
    script_dir = Path(__file__).parent.parent.parent / "scripts"
    benchmark_script = script_dir / "run-benchmark-suite.ts"

    if not benchmark_script.exists():
        logger.warning(f"Benchmark script not found: {benchmark_script}")
        return False

    cmd = [
        "bun",
        "run",
        str(benchmark_script),
        "--model",
        str(model_path),
        "--output",
        config.benchmark_output_dir,
    ]

    if config.benchmark_mode == "quick":
        cmd.append("--quick")

    if config.benchmark_scenarios:
        failed_scenarios = []
        for scenario in config.benchmark_scenarios.split(","):
            scenario = scenario.strip()
            if scenario:
                # Run each scenario separately
                scenario_cmd = [*cmd, "--scenario", scenario]
                logger.info(f"Running scenario: {scenario}")
                try:
                    result = subprocess.run(
                        scenario_cmd, capture_output=True, text=True, timeout=1800
                    )
                    if result.returncode != 0:
                        logger.error(f"Scenario {scenario} failed: {result.stderr}")
                        failed_scenarios.append(scenario)
                    else:
                        logger.info(result.stdout)
                except subprocess.TimeoutExpired:
                    logger.error(f"Scenario {scenario} timed out after 30 minutes")
                    failed_scenarios.append(scenario)

        if failed_scenarios:
            logger.error(f"Failed scenarios: {', '.join(failed_scenarios)}")
            return False
    else:
        # Run all scenarios
        logger.info(f"Running: {' '.join(cmd)}")
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        except subprocess.TimeoutExpired:
            logger.error("Benchmark timed out after 1 hour")
            return False

        if result.returncode != 0:
            logger.error(f"Benchmark failed: {result.stderr}")
            return False

        logger.info(result.stdout)

    logger.info(f"✓ Benchmark complete. Results in: {config.benchmark_output_dir}")
    return True


def generate_training_summary(config: PostTrainingConfig) -> str:
    """Generate a training summary for logs and model card."""
    codename_desc = CODENAMES.get(config.hf_model_codename, "Unknown codename")
    final_loss = (config.final_metrics or {}).get("train/loss", "N/A")

    summary = f"""
================================================================================
TRAINING COMPLETE
================================================================================

Model: {config.model_path}
Codename: {config.hf_model_codename} ({codename_desc})
Base Model: {config.base_model}

Training:
  Steps: {config.training_steps}
  Final Reward: {config.final_reward:.4f}
  Final Loss: {final_loss}
  W&B Run: {config.wandb_run_id or "N/A"}
  Dataset: {config.dataset_id or "N/A"}

Post-Training Actions:
  HuggingFace Push: {"✓ Enabled" if config.hf_push_repo else "✗ Disabled"}
  Benchmark: {"✓ Enabled" if config.benchmark_enabled else "✗ Disabled"}

Timestamp: {datetime.now().isoformat()}
================================================================================
"""
    return summary


def _load_served_evaluation(model_path: Path) -> dict[str, Any] | None:
    candidates = [
        model_path.parent / "served_eval.json",
        model_path / "served_eval.json",
    ]
    for candidate in candidates:
        if not candidate.exists():
            continue
        with candidate.open("r", encoding="utf-8") as handle:
            report = json.load(handle)
        return {
            "report_path": str(candidate),
            "base_summary": report.get("base_model", {}).get("summary"),
            "adapter_summary": report.get("adapter_model", {}).get("summary"),
            "comparison": report.get("comparison"),
        }
    return None


def write_post_training_report(
    config: PostTrainingConfig,
    *,
    push_success: bool | None,
    benchmark_success: bool | None,
) -> Path:
    """Persist a machine-readable post-training report."""
    if not config.report_path:
        raise ValueError("report_path must be set before writing post-training report")

    model_path = Path(config.model_path)
    report_path = Path(config.report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "timestamp": datetime.now().isoformat(),
        "model_path": config.model_path,
        "training_steps": config.training_steps,
        "final_reward": config.final_reward,
        "final_metrics": config.final_metrics or {},
        "wandb_run_id": config.wandb_run_id,
        "base_model": config.base_model,
        "dataset_id": config.dataset_id,
        "actions": {
            "huggingface_push": {
                "enabled": bool(config.hf_push_repo),
                "success": push_success,
            },
            "benchmark": {
                "enabled": config.benchmark_enabled,
                "success": benchmark_success,
                "mode": config.benchmark_mode,
                "output_dir": config.benchmark_output_dir,
            },
        },
        "served_evaluation": _load_served_evaluation(model_path),
        "summary": generate_training_summary(config),
    }
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report_path


def run_post_training(
    model_path: str,
    training_steps: int,
    final_reward: float,
    final_metrics: dict[str, Any] | None = None,
    wandb_run_id: str | None = None,
    base_model: str = "Qwen/Qwen3.5-4B",
    dataset_id: str | None = None,
) -> bool:
    """
    Run all post-training actions.

    This is the main entry point called by run_training.py after training completes.

    Args:
        model_path: Path to the trained model (LoRA adapter)
        training_steps: Number of training steps completed
        final_reward: Final average reward from training
        final_metrics: Final metrics row from the training log
        wandb_run_id: W&B run ID for linking
        base_model: Base model used for training
        dataset_id: HuggingFace dataset ID used for training

    Returns:
        True if all enabled actions completed successfully
    """
    config = PostTrainingConfig.from_env(
        model_path=model_path,
        training_steps=training_steps,
        final_reward=final_reward,
        final_metrics=final_metrics,
        wandb_run_id=wandb_run_id,
        base_model=base_model,
        dataset_id=dataset_id,
    )

    # Log summary
    summary = generate_training_summary(config)
    logger.info(summary)

    success = True
    push_success: bool | None = None
    benchmark_success: bool | None = None

    # Push to HuggingFace if configured
    if config.hf_push_repo:
        push_success = push_model_to_hub(config)
        if not push_success:
            logger.warning("Model push failed, continuing with other actions")
            success = False

    # Run benchmark if enabled
    if config.benchmark_enabled:
        benchmark_success = run_benchmark(config)
        if not benchmark_success:
            logger.warning("Benchmark failed or skipped")
            # Don't fail overall - benchmark is optional

    report_path = write_post_training_report(
        config,
        push_success=push_success,
        benchmark_success=benchmark_success,
    )
    logger.info("Post-training report written to: %s", report_path)

    return success


def main():
    """CLI entry point for standalone execution."""
    parser = argparse.ArgumentParser(description="Run post-training actions")
    parser.add_argument("--model-path", required=True, help="Path to trained model")
    parser.add_argument(
        "--training-steps", type=int, required=True, help="Number of training steps"
    )
    parser.add_argument("--final-reward", type=float, required=True, help="Final training reward")
    parser.add_argument("--wandb-run-id", help="W&B run ID")
    parser.add_argument("--base-model", default="Qwen/Qwen3.5-4B", help="Base model name")
    parser.add_argument("--dataset-id", help="HuggingFace dataset ID")

    args = parser.parse_args()

    success = run_post_training(
        model_path=args.model_path,
        training_steps=args.training_steps,
        final_reward=args.final_reward,
        wandb_run_id=args.wandb_run_id,
        base_model=args.base_model,
        dataset_id=args.dataset_id,
    )

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
