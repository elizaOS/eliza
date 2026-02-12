#!/usr/bin/env python3
"""
ElizaOS RL Training - Full Pipeline Runner

This script orchestrates the complete RLAIF training pipeline:
1. Validates environment and prerequisites
2. Starts background services (Atropos API, vLLM)
3. Starts the RLAIF environment
4. Runs the GRPO trainer with optional W&B logging

Usage:
    # Use a GPU profile (recommended - auto-configures for your hardware)
    python scripts/run_training.py --profile 12gb --steps 100
    python scripts/run_training.py --profile 24gb --steps 100
    
    # List available profiles
    python scripts/run_training.py --list-profiles
    
    # Manual configuration (override profile or use without profile)
    python scripts/run_training.py --model Qwen/Qwen2.5-0.5B-Instruct --vllm-gpu-memory 0.25 --steps 100
    
    # Resume from checkpoint
    python scripts/run_training.py --profile 12gb --resume ./trained_models/step_50
    
    # Disable W&B
    python scripts/run_training.py --profile 12gb --steps 100 --no-wandb

GPU Profiles (config/profiles/*.json):
    12gb - RTX 3060/4070 (0.5B model, 25% vLLM memory)
    16gb - RTX 4080/A4000 (1.5B model, 35% vLLM memory)
    24gb - RTX 4090/A5000 (3B model, 40% vLLM memory)
    48gb - A40/A6000 (7B model, 45% vLLM memory)

Or run components separately:
    Terminal 1: run-api
    Terminal 2: python -m src.training.rlaif_env serve --slurm false
    Terminal 3: python -m src.training.atropos_trainer --steps 100
"""

import argparse
import json
import logging
import os
import signal
import subprocess
import sys
import time
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

# Profile directory
PROFILES_DIR = Path(__file__).parent.parent / "config" / "profiles"


def get_available_profiles() -> list[str]:
    """Get list of available GPU profiles."""
    if not PROFILES_DIR.exists():
        return []
    return [p.stem for p in PROFILES_DIR.glob("*.json")]


def load_profile(profile_name: str) -> dict:
    """Load a GPU profile by name."""
    profile_path = PROFILES_DIR / f"{profile_name}.json"
    if not profile_path.exists():
        available = get_available_profiles()
        raise ValueError(
            f"Profile '{profile_name}' not found. "
            f"Available: {', '.join(available) or 'none'}"
        )
    
    with open(profile_path) as f:
        profile = json.load(f)
    
    logger.info(f"Loaded profile: {profile.get('name', profile_name)}")
    if profile.get('notes'):
        logger.info(f"  Note: {profile['notes']}")
    
    return profile


def list_profiles() -> None:
    """Print available profiles and exit."""
    print("\nAvailable GPU Profiles:")
    print("=" * 60)
    
    for profile_name in sorted(get_available_profiles()):
        try:
            profile = load_profile(profile_name)
            print(f"\n  --profile {profile_name}")
            print(f"    {profile.get('name', 'Unnamed')}")
            print(f"    Model: {profile.get('model', 'default')}")
            print(f"    vLLM Memory: {profile.get('vllm_gpu_memory', 0.45) * 100:.0f}%")
            if profile.get('notes'):
                print(f"    Note: {profile['notes']}")
        except Exception as e:
            print(f"\n  --profile {profile_name}")
            print(f"    Error loading: {e}")
    
    print()


def validate_environment() -> list[str]:
    """
    Validate that all required environment variables and dependencies are present.
    
    Returns a list of error messages for missing requirements.
    """
    errors = []
    
    # Check DATABASE_URL
    if not os.getenv("DATABASE_URL"):
        errors.append(
            "DATABASE_URL not set. Required for loading training trajectories.\n"
            "  Set in .env or export DATABASE_URL=postgresql://..."
        )
    
    # Check OPENAI_API_KEY (for RLAIF judge)
    if not os.getenv("OPENAI_API_KEY"):
        errors.append(
            "OPENAI_API_KEY not set. Required for RLAIF judge scoring.\n"
            "  Set in .env or export OPENAI_API_KEY=sk-..."
        )
    
    # Check for run-api command (Atropos)
    import shutil
    if not shutil.which("run-api"):
        errors.append(
            "Atropos API not found. Install with: pip install atroposlib"
        )
    
    # Check for PyTorch and CUDA
    try:
        import torch
        if not torch.cuda.is_available():
            errors.append(
                "CUDA not available. GPU is recommended for training.\n"
                "  For CPU-only (slow), use --skip-vllm and provide external inference."
            )
        else:
            gpu_name = torch.cuda.get_device_name(0)
            gpu_mem = torch.cuda.get_device_properties(0).total_memory / 1e9
            logger.info(f"GPU: {gpu_name} ({gpu_mem:.1f} GB)")
    except ImportError:
        errors.append("PyTorch not installed. Install with: pip install torch")
    
    return errors


class TrainingOrchestrator:
    """
    Orchestrates the complete training pipeline.
    
    Manages:
    - Service lifecycle (Atropos API, vLLM)
    - Environment server
    - GRPO trainer
    """
    
    def __init__(
        self,
        model_name: str = "Qwen/Qwen2.5-3B-Instruct",
        base_model: Optional[str] = None,
        dataset_input: Optional[str] = None,
        scoring_mode: str = "deterministic",
        training_steps: int = 100,
        batch_size: int = 4,
        learning_rate: float = 1e-5,
        min_learning_rate: float = 1e-7,
        lr_scheduler: str = "cosine",
        warmup_steps: int = 10,
        api_port: int = 8000,
        vllm_host: str = "127.0.0.1",
        vllm_port: int = 9001,
        vllm_gpu_memory: float = 0.45,
        save_path: str = "./trained_models",
        save_every: int = 5,
        keep_checkpoints: int = 3,
        resume_from: Optional[str] = None,
        use_wandb: bool = True,
        wandb_project: str = "eliza-training",
        wandb_entity: Optional[str] = None,
        wandb_run_name: Optional[str] = None,
        skip_services: bool = False,
        log_dir: str = "./logs",
        # Phase 3: Online training parameters
        mode: str = "offline",
        bridge_url: str = "http://localhost:3001",
        hybrid_online_ratio: float = 0.2,
        # Phase 4: Cloud/Multi-GPU parameters
        tensor_parallel_size: int = 1,
        use_flash_attention: bool = False,
        vllm_gpu: Optional[str] = None,  # Explicit GPU assignment for vLLM
        training_gpu: Optional[str] = None,  # Explicit GPU assignment for training
    ):
        self.model_name = model_name
        self.base_model = base_model
        self.dataset_input = dataset_input
        self.scoring_mode = scoring_mode
        self.training_steps = training_steps
        self.batch_size = batch_size
        self.learning_rate = learning_rate
        self.min_learning_rate = min_learning_rate
        self.lr_scheduler = lr_scheduler
        self.warmup_steps = warmup_steps
        self.api_port = api_port
        self.vllm_host = vllm_host
        self.vllm_port = vllm_port
        self.vllm_gpu_memory = vllm_gpu_memory
        self.save_path = save_path
        self.save_every = save_every
        self.keep_checkpoints = keep_checkpoints
        self.resume_from = resume_from
        self.use_wandb = use_wandb
        self.wandb_project = wandb_project
        self.wandb_entity = wandb_entity
        self.wandb_run_name = wandb_run_name
        self.skip_services = skip_services
        self.log_dir = Path(log_dir)
        # Phase 3: Online training
        self.mode = mode
        self.bridge_url = bridge_url
        self.hybrid_online_ratio = hybrid_online_ratio
        # Phase 4: Cloud/Multi-GPU
        self.tensor_parallel_size = tensor_parallel_size
        self.use_flash_attention = use_flash_attention
        self.vllm_gpu = vllm_gpu
        self.training_gpu = training_gpu
        
        self.env_process: Optional[subprocess.Popen] = None
        self.trainer_process: Optional[subprocess.Popen] = None
        self._service_manager = None
        self._shutdown_requested = False
        self._log_handles: list = []  # Track open file handles
        
        self.log_dir.mkdir(parents=True, exist_ok=True)
        
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)
        
    def _signal_handler(self, signum, frame):
        """Handle shutdown signals"""
        if self._shutdown_requested:
            logger.warning("Forced shutdown, exiting immediately")
            sys.exit(1)
        
        logger.info("Received shutdown signal, cleaning up...")
        self._shutdown_requested = True
        self.cleanup()
        sys.exit(0)
        
    def cleanup(self):
        """Clean up all subprocesses and services"""
        self._stop_process(self.trainer_process, "trainer")
        self._stop_process(self.env_process, "environment")
        
        if self._service_manager:
            self._service_manager.stop_all()
        
        for handle in self._log_handles:
            handle.close()
        self._log_handles.clear()
    
    def _stop_process(self, proc: Optional[subprocess.Popen], name: str, timeout: int = 10) -> None:
        """Stop a subprocess gracefully"""
        if not proc:
            return
        
        logger.info(f"Stopping {name}...")
        proc.terminate()
        
        deadline = time.time() + timeout
        while proc.poll() is None and time.time() < deadline:
            time.sleep(0.5)
        
        if proc.poll() is None:
            proc.kill()
            proc.wait()
                    
    def start_services(self) -> bool:
        """Start background services using ServiceManager"""
        if self.skip_services:
            logger.info("Skipping service startup (--skip-services)")
            return True
        
        from src.training.service_manager import ServiceManager, ServiceConfig
        
        config = ServiceConfig(
            atropos_port=self.api_port,
            vllm_port=self.vllm_port,
            model_name=self.model_name,
            vllm_gpu_memory_utilization=self.vllm_gpu_memory,
            log_dir=str(self.log_dir / "services"),
            # Phase 4: Multi-GPU support
            tensor_parallel_size=self.tensor_parallel_size,
            use_flash_attention=self.use_flash_attention,
            vllm_gpu=self.vllm_gpu,
            training_gpu=self.training_gpu,
        )
        
        self._service_manager = ServiceManager(config)
        
        if not self._service_manager.start_all():
            return False
        
        if not self._service_manager.wait_for_ready():
            logger.error("Services failed to become ready")
            return False
        
        return True
        
    def check_bridge_health(self) -> bool:
        """Check if simulation bridge is running and healthy"""
        import urllib.request
        import urllib.error
        
        logger.info(f"Checking simulation bridge at {self.bridge_url}...")
        
        health_url = f"{self.bridge_url}/health"
        for attempt in range(3):
            try:
                req = urllib.request.Request(health_url, method='GET')
                with urllib.request.urlopen(req, timeout=5) as resp:
                    if resp.status == 200:
                        logger.info("Simulation bridge is healthy ✓")
                        return True
            except urllib.error.URLError as e:
                if attempt < 2:
                    logger.warning(f"Bridge not ready (attempt {attempt + 1}/3): {e}")
                    time.sleep(2)
                else:
                    logger.error(f"Simulation bridge not available at {self.bridge_url}")
                    logger.error("Start it with: make bridge-server")
                    return False
            except Exception as e:
                logger.error(f"Bridge health check failed: {e}")
                return False
        
        return False
    
    def start_environment(self) -> bool:
        """Start RLAIF environment (offline mode)"""
        logger.info("Starting RLAIF environment (offline mode)...")
        
        env_cmd = [
            sys.executable, "-m", "src.training.rlaif_env", "serve",
            "--slurm", "false",
            "--env.tokenizer_name", self.model_name,
            "--env.scoring_mode", self.scoring_mode,
            "--env.rollout_server_url", f"http://localhost:{self.api_port}",
            "--openai.model_name", self.model_name,
            "--openai.base_url", f"http://{self.vllm_host}:{self.vllm_port}/v1",
        ]
        
        if not self.use_wandb:
            env_cmd.extend(["--env.use_wandb", "false"])
        
        log_file = self.log_dir / "environment.log"
        log_handle = open(log_file, "w")
        self._log_handles.append(log_handle)
        
        self.env_process = subprocess.Popen(
            env_cmd,
            cwd=str(Path(__file__).parent.parent),
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            env=os.environ.copy(),  # Pass environment variables including DATABASE_URL
        )
        
        time.sleep(5)  # Wait for environment to initialize
        
        if self.env_process.poll() is not None:
            logger.error(f"Environment failed to start (exit code: {self.env_process.returncode})")
            logger.error(f"Check logs at: {log_file}")
            return False
        
        logger.info(f"Environment started (PID: {self.env_process.pid}), logs: {log_file}")
        return True
    
    def start_online_environment(self) -> bool:
        """Start online environment (online mode with simulation bridge)"""
        logger.info("Starting online environment (online mode)...")
        
        env_cmd = [
            sys.executable, "-m", "src.training.online_env", "serve",
            "--slurm", "false",
            "--env.tokenizer_name", self.model_name,
            "--env.rollout_server_url", f"http://localhost:{self.api_port}",
            "--openai.model_name", self.model_name,
            "--openai.base_url", f"http://{self.vllm_host}:{self.vllm_port}/v1",
            # Online-specific settings
            "--env.use_simulation_bridge", "true",
            "--env.simulation_bridge_url", self.bridge_url,
        ]
        
        if not self.use_wandb:
            env_cmd.extend(["--env.use_wandb", "false"])
        
        log_file = self.log_dir / "online_environment.log"
        log_handle = open(log_file, "w")
        self._log_handles.append(log_handle)
        
        # Set environment variables for bridge
        env_vars = os.environ.copy()
        env_vars["USE_SIMULATION_BRIDGE"] = "1"
        env_vars["SIMULATION_BRIDGE_URL"] = self.bridge_url
        
        self.env_process = subprocess.Popen(
            env_cmd,
            cwd=str(Path(__file__).parent.parent),
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            env=env_vars,
        )
        
        time.sleep(5)  # Wait for environment to initialize
        
        if self.env_process.poll() is not None:
            logger.error(f"Online environment failed to start (exit code: {self.env_process.returncode})")
            logger.error(f"Check logs at: {log_file}")
            return False
        
        logger.info(f"Online environment started (PID: {self.env_process.pid}), logs: {log_file}")
        return True
    
    def start_hybrid_environment(self) -> bool:
        """Start hybrid environment (mix of offline and online)"""
        logger.info(f"Starting hybrid environment (online ratio: {self.hybrid_online_ratio:.0%})...")
        
        env_cmd = [
            sys.executable, "-m", "src.training.hybrid_env", "serve",
            "--slurm", "false",
            "--env.tokenizer_name", self.model_name,
            "--env.rollout_server_url", f"http://localhost:{self.api_port}",
            "--openai.model_name", self.model_name,
            "--openai.base_url", f"http://{self.vllm_host}:{self.vllm_port}/v1",
            # Hybrid-specific settings
            "--env.use_simulation_bridge", "true",
            "--env.simulation_bridge_url", self.bridge_url,
            "--env.online_ratio", str(self.hybrid_online_ratio),
        ]
        
        if not self.use_wandb:
            env_cmd.extend(["--env.use_wandb", "false"])
        
        log_file = self.log_dir / "hybrid_environment.log"
        log_handle = open(log_file, "w")
        self._log_handles.append(log_handle)
        
        # Set environment variables
        env_vars = os.environ.copy()
        env_vars["USE_SIMULATION_BRIDGE"] = "1"
        env_vars["SIMULATION_BRIDGE_URL"] = self.bridge_url
        env_vars["HYBRID_ONLINE_RATIO"] = str(self.hybrid_online_ratio)
        
        self.env_process = subprocess.Popen(
            env_cmd,
            cwd=str(Path(__file__).parent.parent),
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            env=env_vars,
        )
        
        time.sleep(5)  # Wait for environment to initialize
        
        if self.env_process.poll() is not None:
            logger.error(f"Hybrid environment failed to start (exit code: {self.env_process.returncode})")
            logger.error(f"Check logs at: {log_file}")
            return False
        
        logger.info(f"Hybrid environment started (PID: {self.env_process.pid}), logs: {log_file}")
        return True
            
    def start_trainer(self) -> bool:
        """Start GRPO trainer"""
        logger.info("Starting GRPO trainer...")
        
        trainer_cmd = [
            sys.executable, "-m", "src.training.atropos_trainer",
            "--model", self.model_name,
            "--scoring-mode", self.scoring_mode,
            "--steps", str(self.training_steps),
            "--batch-size", str(self.batch_size),
            "--lr", str(self.learning_rate),
            "--min-lr", str(self.min_learning_rate),
            "--lr-scheduler", self.lr_scheduler,
            "--warmup-steps", str(self.warmup_steps),
            "--api-url", f"http://localhost:{self.api_port}",
            "--vllm-host", self.vllm_host,
            "--vllm-port", str(self.vllm_port),
            "--vllm-gpu-utilization", str(self.vllm_gpu_memory),
            "--save-path", self.save_path,
            "--save-every", str(self.save_every),
            "--keep-checkpoints", str(self.keep_checkpoints),
            "--log-file", str(self.log_dir / "training_metrics.jsonl"),
            "--wandb-project", self.wandb_project,
            "--skip-vllm",  # vLLM already started by ServiceManager
        ]
        
        if self.base_model:
            trainer_cmd.extend(["--base-model", self.base_model])
        if self.dataset_input:
            trainer_cmd.extend(["--dataset-input", self.dataset_input])
        if self.resume_from:
            trainer_cmd.extend(["--resume", self.resume_from])
        if not self.use_wandb:
            trainer_cmd.append("--no-wandb")
        if self.wandb_entity:
            trainer_cmd.extend(["--wandb-entity", self.wandb_entity])
        if self.wandb_run_name:
            trainer_cmd.extend(["--wandb-run-name", self.wandb_run_name])
        
        # Set up environment with GPU assignment for training
        env = os.environ.copy()
        if self.training_gpu:
            env["CUDA_VISIBLE_DEVICES"] = self.training_gpu
            logger.info(f"Training GPU (explicit): {self.training_gpu}")
        
        # Pipe stdout for streaming to console
        self.trainer_process = subprocess.Popen(
            trainer_cmd,
            cwd=str(Path(__file__).parent.parent),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
        )
        
        logger.info(f"Trainer started (PID: {self.trainer_process.pid})")
        return True
            
    def run(self) -> int:
        """Run the complete training pipeline"""
        self._log_config()
        start_time = time.time()
        
        try:
            # Step 1: Start services
            if not self.start_services():
                logger.error("Failed to start services")
                return 1
            
            # Step 2: For online/hybrid modes, check bridge health
            if self.mode in ("online", "hybrid"):
                if not self.check_bridge_health():
                    logger.error("Simulation bridge not available")
                    logger.error("Start it with: make bridge-server")
                    return 1
            
            # Step 3: Start appropriate environment based on mode
            env_starter = {
                "offline": self.start_environment,
                "online": self.start_online_environment,
                "hybrid": self.start_hybrid_environment,
            }.get(self.mode, self.start_environment)
            
            if not env_starter():
                logger.error(f"Failed to start {self.mode} environment")
                return 1
            
            # Step 4: Start trainer
            if not self.start_trainer():
                logger.error("Failed to start trainer")
                return 1
            
            return_code = self._stream_trainer_output()
            elapsed = time.time() - start_time
            
            if return_code == 0:
                logger.info("\n" + "=" * 70)
                logger.info("TRAINING COMPLETED SUCCESSFULLY")
                logger.info(f"Mode: {self.mode.upper()}")
                logger.info(f"Total time: {elapsed:.1f}s ({elapsed/60:.1f} minutes)")
                logger.info(f"Model saved to: {self.save_path}")
                logger.info("=" * 70)
            else:
                logger.error(f"Training failed with return code: {return_code}")
                logger.error(f"Check logs at: {self.log_dir}")
                
            return return_code
        finally:
            self.cleanup()
    
    def _log_config(self):
        """Log training configuration"""
        logger.info("=" * 70)
        logger.info("ELIZAOS RL TRAINING PIPELINE")
        logger.info("=" * 70)
        logger.info(f"Mode: {self.mode.upper()}")
        if self.mode in ("online", "hybrid"):
            logger.info(f"Bridge URL: {self.bridge_url}")
            if self.mode == "hybrid":
                logger.info(f"Online ratio: {self.hybrid_online_ratio:.0%}")
        logger.info(f"Model: {self.model_name}")
        logger.info(f"Steps: {self.training_steps}")
        logger.info(f"Batch size: {self.batch_size}")
        logger.info(f"Learning rate: {self.learning_rate} (scheduler: {self.lr_scheduler})")
        logger.info(f"Save path: {self.save_path}")
        logger.info(f"W&B: {'enabled' if self.use_wandb else 'disabled'}")
        if self.resume_from:
            logger.info(f"Resuming from: {self.resume_from}")
        logger.info("=" * 70)
    
    def _stream_trainer_output(self) -> int:
        """Stream trainer output to console and log file"""
        logger.info("\n" + "-" * 70)
        logger.info("TRAINING IN PROGRESS")
        logger.info("-" * 70 + "\n")
        
        log_file = self.log_dir / "trainer.log"
        
        assert self.trainer_process is not None
        assert self.trainer_process.stdout is not None
        
        with open(log_file, "w") as log_handle:
            for line in iter(self.trainer_process.stdout.readline, b''):
                decoded = line.decode('utf-8', errors='replace')
                print(decoded, end='')
                log_handle.write(decoded)
                log_handle.flush()
        
        return self.trainer_process.wait()


def main():
    parser = argparse.ArgumentParser(
        description="ElizaOS RL Training Pipeline",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    
    # Profile settings (applied first, can be overridden by explicit args)
    parser.add_argument(
        "--profile",
        choices=get_available_profiles() or None,
        help="GPU profile to use (e.g., 12gb, 24gb). See --list-profiles"
    )
    parser.add_argument(
        "--list-profiles",
        action="store_true",
        help="List available GPU profiles and exit"
    )
    
    # Model settings
    parser.add_argument(
        "--model",
        default=None,  # Will use profile default or fallback
        help="Model to train (default: from profile or Qwen2.5-3B-Instruct)"
    )
    parser.add_argument(
        "--base-model",
        default=None,
        help="Optional base model alias passed to trainer"
    )
    parser.add_argument(
        "--dataset-input",
        default=None,
        help="Optional dataset input path passed to trainer"
    )
    parser.add_argument(
        "--scoring-mode",
        choices=["deterministic", "llm_judge"],
        default="deterministic",
        help="Scoring mode used by environment/trainer pipeline"
    )
    parser.add_argument(
        "--steps",
        type=int,
        default=100,
        help="Number of training steps"
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=4,
        help="Batch size"
    )
    
    # Learning rate settings
    parser.add_argument(
        "--lr",
        type=float,
        default=1e-5,
        help="Initial learning rate"
    )
    parser.add_argument(
        "--min-lr",
        type=float,
        default=1e-7,
        help="Minimum learning rate"
    )
    parser.add_argument(
        "--lr-scheduler",
        choices=["constant", "linear", "cosine"],
        default="cosine",
        help="Learning rate scheduler"
    )
    parser.add_argument(
        "--warmup-steps",
        type=int,
        default=10,
        help="LR warmup steps"
    )
    
    # Service settings
    parser.add_argument(
        "--api-port",
        type=int,
        default=8000,
        help="Atropos API server port"
    )
    parser.add_argument(
        "--vllm-port",
        type=int,
        default=9001,
        help="vLLM inference server port"
    )
    parser.add_argument(
        "--vllm-host",
        default="127.0.0.1",
        help="vLLM inference host"
    )
    parser.add_argument(
        "--vllm-gpu-memory",
        type=float,
        default=0.45,
        help="GPU memory fraction for vLLM"
    )
    parser.add_argument(
        "--skip-services",
        action="store_true",
        help="Skip starting services (assume already running)"
    )
    
    # Checkpoint settings
    parser.add_argument(
        "--save-path",
        default="./trained_models",
        help="Directory to save checkpoints"
    )
    parser.add_argument(
        "--save-every",
        type=int,
        default=5,
        help="Save checkpoint every N steps"
    )
    parser.add_argument(
        "--keep-checkpoints",
        type=int,
        default=3,
        help="Number of checkpoints to keep"
    )
    parser.add_argument(
        "--resume",
        help="Resume from checkpoint path"
    )
    
    # W&B settings
    parser.add_argument(
        "--wandb-project",
        default="eliza-training",
        help="W&B project name"
    )
    parser.add_argument(
        "--wandb-entity",
        help="W&B entity/team"
    )
    parser.add_argument(
        "--wandb-run-name",
        help="W&B run name"
    )
    parser.add_argument(
        "--no-wandb",
        action="store_true",
        help="Disable W&B logging"
    )
    
    # Logging
    parser.add_argument(
        "--log-dir",
        default="./logs",
        help="Directory for log files"
    )
    
    # Validation
    parser.add_argument(
        "--skip-validation",
        action="store_true",
        help="Skip environment validation"
    )
    
    # Training Mode (Phase 3)
    parser.add_argument(
        "--mode",
        choices=["offline", "online", "hybrid"],
        default="offline",
        help="Training mode: offline (DB trajectories), online (simulation bridge), hybrid (mix)"
    )
    parser.add_argument(
        "--bridge-url",
        default="http://localhost:3001",
        help="Simulation bridge URL (for online/hybrid modes)"
    )
    parser.add_argument(
        "--hybrid-online-ratio",
        type=float,
        default=0.2,
        help="Ratio of online rollouts in hybrid mode (0.0-1.0)"
    )
    parser.add_argument(
        "--online",
        action="store_true",
        help="Shorthand for --mode online"
    )
    
    args = parser.parse_args()
    
    # Handle --online shorthand
    if args.online:
        args.mode = "online"
    
    # Handle --list-profiles
    if args.list_profiles:
        list_profiles()
        sys.exit(0)
    
    # Apply profile defaults (can be overridden by explicit args)
    profile = {}
    if args.profile:
        profile = load_profile(args.profile)
    
    # Apply profile values as defaults for unset args
    if args.model is None:
        args.model = profile.get("model", "Qwen/Qwen2.5-3B-Instruct")
    if args.batch_size == 4 and "batch_size" in profile:  # 4 is the argparse default
        args.batch_size = profile["batch_size"]
    if args.vllm_gpu_memory == 0.45 and "vllm_gpu_memory" in profile:  # 0.45 is the default
        args.vllm_gpu_memory = profile["vllm_gpu_memory"]
    
    # Phase 4: Read multi-GPU settings from profile
    args.tensor_parallel_size = profile.get("tensor_parallel_size", 1)
    args.use_flash_attention = profile.get("use_flash_attention", False)
    args.vllm_gpu = profile.get("vllm_gpu")  # Explicit GPU assignment for vLLM
    args.training_gpu = profile.get("training_gpu")  # Explicit GPU assignment for training
    
    # Log effective settings
    if args.profile:
        tp_info = f", tp={args.tensor_parallel_size}" if args.tensor_parallel_size > 1 else ""
        logger.info(f"Using profile '{args.profile}': model={args.model}, "
                    f"vllm_mem={args.vllm_gpu_memory:.0%}, batch={args.batch_size}{tp_info}")
    
    # Validate environment
    if not args.skip_validation:
        errors = validate_environment()
        if errors:
            logger.error("Environment validation failed:")
            for error in errors:
                logger.error(f"  • {error}")
            logger.error("\nFix the above issues or use --skip-validation to bypass.")
            sys.exit(1)
    
    orchestrator = TrainingOrchestrator(
        model_name=args.model,
        base_model=args.base_model,
        dataset_input=args.dataset_input,
        scoring_mode=args.scoring_mode,
        training_steps=args.steps,
        batch_size=args.batch_size,
        learning_rate=args.lr,
        min_learning_rate=args.min_lr,
        lr_scheduler=args.lr_scheduler,
        warmup_steps=args.warmup_steps,
        api_port=args.api_port,
        vllm_host=args.vllm_host,
        vllm_port=args.vllm_port,
        vllm_gpu_memory=args.vllm_gpu_memory,
        save_path=args.save_path,
        save_every=args.save_every,
        keep_checkpoints=args.keep_checkpoints,
        resume_from=args.resume,
        use_wandb=not args.no_wandb,
        wandb_project=args.wandb_project,
        wandb_entity=args.wandb_entity,
        wandb_run_name=args.wandb_run_name,
        skip_services=args.skip_services,
        log_dir=args.log_dir,
        # Phase 3: Online training
        mode=args.mode,
        bridge_url=args.bridge_url,
        hybrid_online_ratio=args.hybrid_online_ratio,
        # Phase 4: Cloud/Multi-GPU
        tensor_parallel_size=args.tensor_parallel_size,
        use_flash_attention=args.use_flash_attention,
        vllm_gpu=args.vllm_gpu,
        training_gpu=args.training_gpu,
    )
    
    sys.exit(orchestrator.run())


if __name__ == "__main__":
    main()
