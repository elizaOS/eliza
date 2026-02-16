#!/usr/bin/env python3
"""
Train from JSONL Scored Trajectories
"""

import os
import sys
import json
import random
import argparse
import logging
from pathlib import Path
from typing import List, Dict, Any

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

def detect_backend() -> str:
    """Auto-detect the best available backend."""
    try:
        import mlx.core
        logger.info("MLX backend available (Apple Silicon)")
        return "mlx"
    except ImportError:
        pass

    try:
        import torch
        if torch.cuda.is_available():
            logger.info(f"CUDA backend available: {torch.cuda.get_device_name(0)}")
            return "cuda"
    except ImportError:
        pass

    logger.warning("No GPU backend available, falling back to CPU")
    return "cpu"

def load_and_process_data(input_file: str, min_score: float) -> List[Dict[str, Any]]:
    """
    Load trajectories from JSONL, filter by score, and convert to chat format.
    """
    samples = []
    
    if not os.path.exists(input_file):
        raise FileNotFoundError(f"Input file not found: {input_file}")

    logger.info(f"Loading data from {input_file}...")
    
    with open(input_file, 'r') as f:
        for line in f:
            if not line.strip():
                continue
            try:
                traj = json.loads(line)
                
                # Check for direct messages format (SFT dataset)
                if 'messages' in traj:
                    samples.append(traj)
                    continue

                # Filter by score if present
                if traj.get('isScored'):
                    if traj.get('score', 0) < min_score:
                        continue
                
                # Extract conversation (Trajectory format)
                # We want to train the model to generate the ACTION based on observation
                # Or generate the RESPONSE based on the task
                
                task = traj.get('metadata', {}).get('task', '')
                steps = traj.get('steps', [])
                
                if not task:
                    continue

                # Simple Format:
                # System: You are a helpful assistant.
                # User: <Task>
                # Assistant: <Response>
                
                # In a real scenario, we might want to train on every step.
                # For this benchmark, we train on the final response to the task.
                
                last_step = steps[-1] if steps else None
                if not last_step:
                    continue
                    
                response = last_step.get('action', {}).get('parameters', {}).get('text')
                if not response:
                    continue
                
                messages = [
                    {"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": task},
                    {"role": "assistant", "content": response}
                ]
                
                samples.append({"messages": messages})

            except json.JSONDecodeError:
                continue
                
    logger.info(f"Loaded {len(samples)} valid training samples (score >= {min_score})")
    return samples

def train_mlx(
    samples: List[Dict], 
    model_name: str, 
    output_dir: str,
    iters: int, 
    batch_size: int, 
    learning_rate: float
):
    """Train using MLX LoRA."""
    import subprocess
    
    logger.info("Starting MLX Training...")
    
    # Prepare Data Directory
    data_dir = os.path.join(output_dir, "data")
    os.makedirs(data_dir, exist_ok=True)
    
    # Split Train/Valid
    random.shuffle(samples)
    split_idx = int(len(samples) * 0.9)
    train_samples = samples[:split_idx]
    valid_samples = samples[split_idx:]
    
    # Write JSONL for MLX
    with open(os.path.join(data_dir, "train.jsonl"), 'w') as f:
        for s in train_samples:
            f.write(json.dumps(s) + "\n")
            
    with open(os.path.join(data_dir, "valid.jsonl"), 'w') as f:
        for s in valid_samples:
            f.write(json.dumps(s) + "\n")
            
    if not valid_samples:
         # Create a dummy validation set if empty (e.g. only 1 sample)
         with open(os.path.join(data_dir, "valid.jsonl"), 'w') as f:
            f.write(json.dumps(train_samples[0]) + "\n")

    adapter_path = os.path.join(output_dir, "adapters")
    
    # Construct MLX Command
    # We use the python module directly via subprocess to avoid import issues with conflicting arguments
    cmd = [
        sys.executable, "-m", "mlx_lm.lora",
        "--model", model_name,
        "--train", 
        "--data", data_dir,
        "--adapter-path", adapter_path,
        "--batch-size", str(batch_size),
        "--iters", str(iters),
        "--learning-rate", str(learning_rate),
        "--steps-per-report", "5",
        "--save-every", "10",
    ]
    
    logger.info(f"Running command: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    logger.info(f"Training complete. Adapters saved to {adapter_path}")

def main():
    parser = argparse.ArgumentParser(description="Train from JSONL")
    parser.add_argument("--input", default="scored_trajectories.jsonl", help="Input JSONL file")
    parser.add_argument("--output", default="trained_models/jsonl_run", help="Output directory")
    parser.add_argument("--min-score", type=float, default=0.7, help="Minimum score to include")
    
    parser.add_argument("--model", default="mlx-community/Qwen2.5-1.5B-Instruct-4bit", help="Base model (default: Qwen 1.5B 4bit for Mac)")
    parser.add_argument("--backend", choices=["mlx", "cuda", "cpu"], default=None)
    
    parser.add_argument("--iters", type=int, default=100, help="Training iterations")
    parser.add_argument("--batch-size", type=int, default=1, help="Batch size") # MLX handles small batch sizes well
    parser.add_argument("--lr", type=float, default=1e-5, help="Learning rate")

    args = parser.parse_args()
    
    # Detect Backend
    backend = args.backend or detect_backend()
    logger.info(f"Backend: {backend}")
    
    # Load Data
    full_input_path = os.path.abspath(args.input)
    samples = load_and_process_data(full_input_path, args.min_score)
    
    if not samples:
        logger.error("No samples found. Exiting.")
        return

    # Train
    output_dir = os.path.abspath(args.output)
    os.makedirs(output_dir, exist_ok=True)

    if backend == "mlx":
        train_mlx(
            samples, 
            args.model, 
            output_dir, 
            args.iters, 
            args.batch_size, 
            args.lr
        )
    else:
        logger.warning(f"Backend {backend} detected. MLX not available. Running in DRY RUN mode for verification.")
        # Dry run: just verify data processing and split
        random.shuffle(samples)
        split_idx = int(len(samples) * 0.9)
        train_samples = samples[:split_idx]
        valid_samples = samples[split_idx:]
        
        logger.info(f"Dry Run: Would train on {len(train_samples)} samples, validate on {len(valid_samples)} samples.")
        logger.info(f"Sample data: {json.dumps(train_samples[0] if train_samples else {}, indent=2)}")
        logger.info("Verification complete (no actual training performed on CPU).")

if __name__ == "__main__":
    main()
