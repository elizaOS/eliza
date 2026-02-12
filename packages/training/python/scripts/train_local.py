#!/usr/bin/env python3
"""
Babylon Local Training Script - Unified Mac (MLX) + GTX (CUDA) Support

This script provides training using REAL data from the database OR local JSON files.
Only trajectories with actual LLM calls are used.

Supports:
- Apple Silicon (MLX) - LoRA fine-tuning
- NVIDIA GPU (PyTorch/CUDA) - Full or LoRA fine-tuning
- CPU fallback (slow but works)

Usage:
    # Mac with MLX from Postgres Database
    python scripts/train_local.py --backend mlx --model mlx-community/Qwen2.5-1.5B-Instruct-4bit
    
    # Mac with MLX from local JSON files
    python scripts/train_local.py --backend mlx --model mlx-community/Qwen2.5-1.5B-Instruct-4bit --source-dir ../engine/training-data-output/trajectories
    
    # GTX/CUDA machine from Postgres Database
    python scripts/train_local.py --backend cuda --model Qwen/Qwen2.5-1.5B-Instruct
    
    # GTX/CUDA machine from local JSON files
    python scripts/train_local.py --backend cuda --model Qwen/Qwen2.5-1.5B-Instruct --source-dir ../engine/training-data-output/trajectories

Small model recommendations for consumer hardware:
    Mac M1/M2 (8GB):   mlx-community/Qwen2.5-0.5B-Instruct-4bit
    Mac M1/M2 (16GB):  mlx-community/Qwen2.5-1.5B-Instruct-4bit
    GTX 3060 (12GB):   Qwen/Qwen2.5-1.5B-Instruct
    GTX 3080 (10GB):   Qwen/Qwen2.5-1.5B-Instruct
    GTX 4090 (24GB):   Qwen/Qwen2.5-3B-Instruct
"""

import os
import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))



import argparse
import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Literal, List
from dotenv import load_dotenv

from src.models import BabylonTrajectory
from src.data_bridge.reader import JsonTrajectoryReader, PostgresTrajectoryReader, validate_llm_calls

# Load environment
env_path = Path(__file__).parent.parent.parent.parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)


# =============================================================================
# Backend Detection
# =============================================================================

def detect_backend() -> Literal["mlx", "cuda", "cpu"]:
    """Auto-detect the best available backend."""
    # Check for MLX (Apple Silicon)
    try:
        import mlx.core  # type: ignore
        logger.info("MLX backend available (Apple Silicon)")
        return "mlx"
    except ImportError:
        pass

    # Check for CUDA
    try:
        import torch
        if torch.cuda.is_available():
            logger.info(
                f"CUDA backend available: {torch.cuda.get_device_name(0)}")
            return "cuda"
    except ImportError:
        pass

    logger.warning("No GPU backend available, falling back to CPU (slow)")
    return "cpu"


# =============================================================================
# Data Loading
# =============================================================================

async def load_postgres_training_data(
    database_url: str,
    min_actions: int,
    lookback_hours: int,
    max_trajectories: int,
) -> List[BabylonTrajectory]:
    """Load REAL training data from the database and parse into Pydantic models."""
    logger.info("Loading real training data from database...")

    trajectories: List[BabylonTrajectory] = []

    try:
        async with PostgresTrajectoryReader(database_url) as reader:
            windows = await reader.get_window_ids(lookback_hours=lookback_hours)
            if not windows:
                raise ValueError(
                    "No trajectory windows found in database. Generate data first.")

            logger.info(f"Found {len(windows)} trajectory windows")

            for window_id in windows:
                if len(trajectories) >= max_trajectories:
                    break

                window_trajectories = await reader.get_trajectories_by_window(
                    window_id, min_actions=min_actions, validate=True
                )
                for traj_row in window_trajectories:
                    try:
                        steps = json.loads(traj_row.steps_json)
                        # Convert TrajectoryRow object to a dict for Pydantic validation
                        traj_data = {
                            "id": traj_row.trajectory_id,
                            "trajectory_id": traj_row.trajectory_id,
                            "agent_id": traj_row.agent_id,
                            "window_id": traj_row.window_id,
                            "steps": steps,
                            "total_reward": traj_row.total_reward,
                            "episode_length": traj_row.episode_length,
                            "final_status": traj_row.final_status,
                            "final_pnl": traj_row.final_pnl,
                            "trades_executed": traj_row.trades_executed,
                            "archetype": traj_row.archetype,
                        }
                        traj_model = BabylonTrajectory.model_validate(
                            traj_data)
                        trajectories.append(traj_model)
                    except Exception as e:
                        logger.warning(
                            f"Skipping DB trajectory {traj_row.trajectory_id} due to parsing error: {e}")

    except Exception as e:
        logger.error(f"Failed to load from database: {e}")
        logger.error(
            "Please ensure the database is running and DATABASE_URL is correct.")
        sys.exit(1)

    if len(trajectories) < 10:
        raise ValueError(
            f"Insufficient training data: only {len(trajectories)} valid trajectories found.")

    logger.info(f"Loaded {len(trajectories)} real trajectories from DB")
    return trajectories


def load_json_training_data(source_dir: str, max_trajectories: int) -> List[BabylonTrajectory]:
    """Loads training data from a directory of JSON files."""
    logger.info(f"Loading training data from local directory: {source_dir}")
    try:
        reader = JsonTrajectoryReader(source_dir)
        all_trajectories: List[BabylonTrajectory] = []
        for window_id in reader.get_window_ids():
            if len(all_trajectories) >= max_trajectories:
                break
            for traj_data in reader.get_trajectories_by_window(window_id):
                try:
                    # Handle the nested `trajectory` key and `stepsJson` string format
                    # from the TypeScript simulation engine.
                    if 'trajectory' in traj_data:
                        traj_data = traj_data['trajectory']
                    if 'stepsJson' in traj_data and isinstance(traj_data['stepsJson'], str):
                        traj_data['steps'] = json.loads(traj_data['stepsJson'])

                    is_valid, issues = validate_llm_calls(
                        traj_data.get('steps', []))
                    if not is_valid:
                        logger.debug(
                            f"Skipping invalid JSON trajectory {traj_data.get('trajectoryId')}: {issues}")
                        continue

                    # Ensure 'id' field is present for Pydantic model validation
                    if 'id' not in traj_data:
                        traj_data['id'] = traj_data.get(
                            'trajectory_id', 'id_missing')

                    all_trajectories.append(
                        BabylonTrajectory.model_validate(traj_data))
                except Exception as e:
                    logger.warning(
                        f"Skipping invalid JSON trajectory {traj_data.get('trajectoryId')}: {e}")

        if len(all_trajectories) == 0:
            raise ValueError(
                "Insufficient training data: 0 valid trajectories were loaded. Check validation logs with DEBUG level.")
        elif len(all_trajectories) < 10:
            logger.warning(
                f"Low training data: only {len(all_trajectories)} valid trajectories found.")

        logger.info(
            f"Loaded {len(all_trajectories)} valid trajectories from JSON files.")
        return all_trajectories
    except (FileNotFoundError, ValueError) as e:
        logger.error(f"Error loading JSON data: {e}")
        sys.exit(1)


def trajectories_to_training_samples(trajectories: List[BabylonTrajectory]) -> list[dict]:
    """
    Convert a list of BabylonTrajectory objects to the training sample format.

    Each LLM call within a trajectory is extracted into a separate sample
    containing a list of messages (system, user, assistant).
    """
    samples = []
    for traj in trajectories:
        for step in traj.steps:
            if not step.llm_calls:
                continue
            for llm_call in step.llm_calls:
                # Basic quality filter for the LLM call
                if not llm_call.response or len(llm_call.response) < 20:
                    continue

                messages = []
                if llm_call.system_prompt:
                    messages.append(
                        {"role": "system", "content": llm_call.system_prompt})
                if llm_call.user_prompt:
                    messages.append(
                        {"role": "user", "content": llm_call.user_prompt})
                messages.append(
                    {"role": "assistant", "content": llm_call.response})

                if len(messages) >= 2:
                    samples.append({"messages": messages})

    logger.info(
        f"Converted {len(trajectories)} trajectories to {len(samples)} training samples")
    return samples


# =============================================================================
# Training Backends
# =============================================================================

def train_mlx(
    samples: list[dict], model_name: str, output_dir: str,
    num_iters: int, batch_size: int, learning_rate: float
) -> str:
    """Train using MLX LoRA on Apple Silicon."""
    import subprocess
    import random

    logger.info("=" * 60 + "\nMLX LORA TRAINING\n" + "=" * 60)
    data_dir = os.path.join(output_dir, "training_data")
    os.makedirs(data_dir, exist_ok=True)

    random.shuffle(samples)
    split_idx = int(len(samples) * 0.9)
    train_samples, valid_samples = samples[:split_idx], samples[split_idx:]

    with open(os.path.join(data_dir, "train.jsonl"), 'w') as f:
        for s in train_samples:
            f.write(json.dumps(s) + "\n")
    with open(os.path.join(data_dir, "valid.jsonl"), 'w') as f:
        for s in valid_samples:
            f.write(json.dumps(s) + "\n")

    adapter_path = os.path.join(output_dir, "adapters")
    import mlx_lm # type: ignore
    cmd = [
        sys.executable, "-m", "mlx_lm", "lora", "--model", model_name, "--train",
        "--data", data_dir, "--adapter-path", adapter_path, "--batch-size", str(
            batch_size),
        "--iters", str(num_iters), "--learning-rate", str(learning_rate),
        "--steps-per-report", "10", "--steps-per-eval", "25", "--val-batches", "5",
        "--max-seq-length", "1024", "--num-layers", "8", "--mask-prompt",
    ]
    logger.info(f"Command: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    return adapter_path


def train_cuda(
    samples: list[dict], model_name: str, output_dir: str,
    epochs: int, batch_size: int, learning_rate: float, use_lora: bool
) -> str:
    """Train using PyTorch/CUDA on NVIDIA GPU."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, Trainer, DataCollatorForLanguageModeling
    from datasets import Dataset

    logger.info("=" * 60 + "\nCUDA/PYTORCH TRAINING\n" + "=" * 60)
    logger.info(
        f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")

    tokenizer = AutoTokenizer.from_pretrained(
        model_name, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    formatted = [{"text": tokenizer.apply_chat_template(
        s['messages'], tokenize=False, add_generation_prompt=False)} for s in samples if s.get("messages")]
    dataset = Dataset.from_list(formatted)

    def tokenize_fn(examples):
        # Using a shorter sequence length to prevent CUDA out-of-memory errors
        # on consumer GPUs. The memory usage scales quadratically with this value.
        return tokenizer(
            examples["text"],
            truncation=True,
            max_length=1024,  # Reduced from 2048 to fit in ~12GB VRAM
            padding="max_length",
        )

    tokenized = dataset.map(tokenize_fn, batched=True, remove_columns=["text"])

    model = AutoModelForCausalLM.from_pretrained(
        model_name, torch_dtype=torch.float16, trust_remote_code=True, device_map="auto")

    if use_lora:
        from peft import LoraConfig, get_peft_model, TaskType
        lora_config = LoraConfig(task_type=TaskType.CAUSAL_LM, r=16, lora_alpha=32,
                                 lora_dropout=0.1, target_modules=["q_proj", "v_proj", "k_proj", "o_proj"])
        model = get_peft_model(model, lora_config)
        model.print_trainable_parameters()

    # Optimized training arguments for consumer GPUs (~12GB VRAM)
    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=epochs,
        # Smallest possible batch size to save memory
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,         # Compensate for small batch size
        learning_rate=learning_rate,
        warmup_steps=100,
        logging_steps=10,
        save_steps=500,
        save_total_limit=2,
        fp16=True,
        report_to="none",
        remove_unused_columns=False
    )

    trainer = Trainer(model=model, args=training_args, train_dataset=tokenized,
                      data_collator=DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False))

    trainer.train()
    trainer.save_model(output_dir)
    return output_dir


def train_cpu(samples: list[dict], model_name: str, output_dir: str, epochs: int, batch_size: int, learning_rate: float) -> str:
    """Train using CPU (slow fallback)."""
    logger.warning("=" * 60 + "\nCPU TRAINING (VERY SLOW)\n" + "=" * 60)
    # Using the CUDA function is fine here, as transformers will default to CPU if no GPU is found.
    # We force a smaller model to make it feasible.
    return train_cuda(samples, "Qwen/Qwen2.5-0.5B-Instruct", output_dir, epochs, batch_size, learning_rate, use_lora=False)

# =============================================================================
# Validation
# =============================================================================


def validate_trained_model(model_path: str, backend: Literal["mlx", "cuda", "cpu"], base_model: str | None = None) -> bool:
    """Validate the trained model by generating a test response."""
    logger.info("=" * 60 + "\nVALIDATING TRAINED MODEL\n" + "=" * 60)
    test_prompt = """You are a trading agent in Babylon prediction markets.

Current State:
- Balance: $10,000
- P&L: $250
- Positions: 2 open

Market Update:
- BTC prediction market at 68% probability
- Recent news: Fed announces rate cut consideration

Analyze this market update and explain your trading decision."""

    try:
        if backend == "mlx":
            from mlx_lm import load, generate # type: ignore
            model, tokenizer = load(base_model, adapter_path=model_path)
            messages = [{"role": "user", "content": test_prompt}]
            prompt = tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True)
            response = generate(model, tokenizer, prompt=prompt,
                                max_tokens=200, verbose=False)
        else:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer
            tokenizer = AutoTokenizer.from_pretrained(
                model_path, trust_remote_code=True)
            model = AutoModelForCausalLM.from_pretrained(
                model_path,
                torch_dtype=torch.float16 if backend == "cuda" else torch.float32,
                device_map="auto" if backend == "cuda" else None,
                trust_remote_code=True,
            )
            messages = [{"role": "user", "content": test_prompt}]
            prompt = tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True)
            inputs = tokenizer(prompt, return_tensors="pt")
            if backend == "cuda":
                inputs = {k: v.cuda() for k, v in inputs.items()}
            outputs = model.generate(**inputs, max_new_tokens=200, temperature=0.7,
                                     do_sample=True, pad_token_id=tokenizer.eos_token_id)
            response = tokenizer.decode(
                outputs[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)

        logger.info("Test Response:\n" + "-" * 40 +
                    f"\n{response[:500]}...\n" + "-" * 40)

        if len(response) < 50:
            logger.error("Response too short - model may not be working")
            return False

        logger.info("✅ Model validation passed!")
        return True

    except Exception as e:
        logger.error(f"Model validation failed: {e}", exc_info=True)
        return False

# =============================================================================
# Main
# =============================================================================


async def main_async(args):
    """Main async training function."""
    backend = args.backend or detect_backend()
    model_name = args.model or (
        "mlx-community/Qwen2.5-1.5B-Instruct-4bit" if backend == "mlx" else "Qwen/Qwen2.5-1.5B-Instruct")
    logger.info(f"Using backend: {backend}, Model: {model_name}")
    os.makedirs(args.output, exist_ok=True)

    try:
        # Main logic to select data source based on CLI arguments
        if args.source_dir:
            trajectories = load_json_training_data(
                args.source_dir, args.max_trajectories)
        else:
            database_url = args.database_url or os.getenv("DATABASE_URL")
            if not database_url:
                logger.error(
                    "DATABASE_URL not set and --source-dir not provided. Exiting.")
                return 1
            trajectories = await load_postgres_training_data(database_url, args.min_actions, args.lookback_hours, args.max_trajectories)
    except (ValueError, FileNotFoundError) as e:
        logger.error(f"Failed to load data: {e}")
        return 1

    samples = trajectories_to_training_samples(trajectories)
    if len(samples) < 10:
        logger.error(
            f"Not enough valid training samples found: {len(samples)}")
        return 1

    model_path, base_model = "", None
    try:
        if backend == "mlx":
            model_path, base_model = train_mlx(
                samples, model_name, args.output, args.iters, args.batch_size, args.lr), model_name
        elif backend == "cuda":
            model_path = train_cuda(
                samples, model_name, args.output, args.epochs, args.batch_size, args.lr, args.lora)
        else:  # cpu
            model_path = train_cpu(
                samples, model_name, args.output, args.epochs, args.batch_size, args.lr)
    except Exception as e:
        logger.error(f"Training process failed: {e}", exc_info=True)
        return 1

    if args.validate and model_path:
        validate_trained_model(model_path, backend, base_model)

    logger.info("\n" + "="*60 + "\nTRAINING COMPLETE\n" +
                f"  Model/adapter saved to: {model_path}\n" + "="*60)
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Babylon Local Training", formatter_class=argparse.ArgumentDefaultsHelpFormatter)

    parser.add_argument(
        "--source-dir", help="Directory with local JSON trajectory files for offline training.")
    parser.add_argument(
        "--database-url", help="Database URL (used if --source-dir is not provided).")
    parser.add_argument("--backend", choices=["mlx", "cuda", "cpu"],
                        help="Training backend (auto-detected if not specified)")
    parser.add_argument(
        "--model", help="Model to train (default depends on backend)")
    parser.add_argument("--min-actions", type=int, default=3,
                        help="Minimum actions per trajectory (DB source)")
    parser.add_argument("--lookback-hours", type=int, default=168,
                        help="Hours to look back for trajectories (DB source)")
    parser.add_argument("--max-trajectories", type=int,
                        default=500, help="Maximum trajectories to load")
    parser.add_argument(
        "--output", default="./trained_models/local", help="Output directory")
    parser.add_argument("--iters", type=int, default=100,
                        help="Training iterations (MLX)")
    parser.add_argument("--epochs", type=int, default=3,
                        help="Training epochs (CUDA/CPU)")
    parser.add_argument("--batch-size", type=int, default=2,
                        help="Batch size (Note: CUDA uses a fixed batch size of 1 for memory optimization)")
    parser.add_argument("--lr", type=float, default=1e-5, help="Learning rate")
    parser.add_argument("--lora", action=argparse.BooleanOptionalAction,
                        default=True, help="Use LoRA (CUDA only)")
    parser.add_argument("--validate", action=argparse.BooleanOptionalAction,
                        default=True, help="Validate trained model")

    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())