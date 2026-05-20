"""
Feed GRPO Trainer using Atropos

This trainer implements Group Relative Policy Optimization (GRPO) for
training Feed trading agents using trajectories collected and scored
by the Feed RLAIF Environment.

Key features:
- Pulls batches from Atropos API server
- Implements GRPO training loop with transformers/vLLM
- Supports checkpoint saving and vLLM model reloading
- Optional W&B logging (online or offline mode)
- Learning rate scheduling (constant, linear, cosine)
- Checkpoint resume support

Based on: https://github.com/NousResearch/atropos/blob/main/example_trainer/grpo.py
"""

import atexit
import json
import logging
import math
import os
import shutil
import subprocess
import time
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

import numpy as np
import requests
import torch
import torch.nn.functional as F
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from tenacity import retry, stop_after_attempt, wait_exponential
from torch.optim import AdamW
from torch.optim.lr_scheduler import LambdaLR
from transformers import AutoModelForCausalLM, AutoTokenizer

from .turboquant import TurboQuantSettings, build_generation_cache

logger = logging.getLogger(__name__)

# Module names that benefit from APOLLO low-rank projection.
_LOW_RANK_HINTS = (
    "q_proj",
    "k_proj",
    "v_proj",
    "o_proj",
    "gate_proj",
    "up_proj",
    "down_proj",
    "c_attn",
    "c_proj",
    "c_fc",
    "w1",
    "w2",
    "w3",
)


def _build_apollo_param_groups(
    model: AutoModelForCausalLM,
    apollo_rank: int,
    apollo_scale: float,
    apollo_update_proj_gap: int,
) -> list:
    """Split parameters into low-rank projected (large linear layers) and regular groups."""
    lowrank, regular = [], []
    for name, param in model.named_parameters():
        if not param.requires_grad:
            continue
        if param.ndim >= 2 and any(h in name for h in _LOW_RANK_HINTS):
            lowrank.append(param)
        else:
            regular.append(param)
    groups: list[dict] = []
    if regular:
        groups.append({"params": regular})
    if lowrank:
        groups.append(
            {
                "params": lowrank,
                "rank": apollo_rank,
                "proj": "random",
                "scale_type": "channel",
                "scale": apollo_scale,
                "update_proj_gap": apollo_update_proj_gap,
                "proj_type": "std",
            }
        )
    return groups


def _create_optimizer(
    model: AutoModelForCausalLM,
    optimizer_name: str,
    lr: float,
    weight_decay: float = 0.0,
    apollo_rank: int = 128,
    apollo_scale: float = 32.0,
    apollo_update_proj_gap: int = 200,
) -> torch.optim.Optimizer:
    """Create AdamW or APOLLO optimizer."""
    if optimizer_name == "apollo":
        try:
            from apollo_torch import APOLLOAdamW
        except ImportError as exc:
            raise ImportError(
                "apollo_torch is required for --optimizer apollo. "
                "Install with: pip install apollo-torch"
            ) from exc
        groups = _build_apollo_param_groups(
            model,
            apollo_rank,
            apollo_scale,
            apollo_update_proj_gap,
        )
        return APOLLOAdamW(groups, lr=lr, weight_decay=weight_decay)
    return AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)


# Load environment variables
project_root = Path(__file__).parent.parent.parent
env_path = project_root / ".env"
env_local_path = project_root / ".env.local"

if env_local_path.exists():
    load_dotenv(env_local_path, override=True)
if env_path.exists():
    load_dotenv(env_path, override=False)

# Global variable for vLLM process cleanup
vllm_process: subprocess.Popen | None = None


def cleanup_vllm():
    """Cleanup vLLM process on exit"""
    global vllm_process
    if vllm_process:
        logger.info("Terminating vLLM process...")
        vllm_process.terminate()
        deadline = time.time() + 5
        while vllm_process.poll() is None and time.time() < deadline:
            time.sleep(0.1)
        if vllm_process.poll() is None:
            logger.warning("vLLM process did not terminate gracefully, killing.")
            vllm_process.kill()
            vllm_process.wait()
        else:
            logger.info("vLLM process terminated.")
        vllm_process = None


atexit.register(cleanup_vllm)


class LRSchedulerType(str, Enum):
    """Learning rate scheduler types"""

    CONSTANT = "constant"
    LINEAR = "linear"
    COSINE = "cosine"


class AtroposTrainingConfig(BaseModel):
    """Configuration for Atropos GRPO training"""

    # Model settings
    model_name: str = Field(default="Qwen/Qwen3.5-4B", description="Base model to train")

    # Training hyperparameters
    learning_rate: float = Field(default=1e-5, description="Initial learning rate")
    min_learning_rate: float = Field(
        default=1e-7, description="Minimum learning rate for scheduling"
    )
    training_steps: int = Field(default=100, description="Number of training steps")
    batch_size: int = Field(default=4, description="Batch size per step")
    gradient_accumulation_steps: int = Field(default=8, description="Gradient accumulation steps")
    seq_len: int = Field(default=4096, description="Maximum sequence length")
    max_grad_norm: float = Field(default=1.0, description="Gradient clipping norm")

    # Learning rate scheduling
    lr_scheduler: LRSchedulerType = Field(
        default=LRSchedulerType.COSINE, description="LR scheduler type"
    )
    warmup_steps: int = Field(default=10, description="Number of warmup steps")

    # Device settings
    device: str = Field(
        default_factory=lambda: "cuda" if torch.cuda.is_available() else "cpu",
        description="Device to train on",
    )

    # vLLM settings
    vllm_port: int = Field(default=9001, description="Port for vLLM inference server")
    skip_vllm: bool = Field(
        default=False, description="Skip vLLM startup (assumes already running)"
    )
    vllm_restart_interval: int = Field(default=5, description="Restart vLLM every N steps")
    vllm_gpu_utilization: float = Field(default=0.45, description="GPU memory for vLLM")

    # Checkpoint settings
    save_path: str = Field(default="./trained_models", description="Directory to save checkpoints")
    save_every_steps: int = Field(default=5, description="Save checkpoint every N steps")
    keep_checkpoints: int = Field(default=3, description="Number of recent checkpoints to keep")
    resume_from: str | None = Field(default=None, description="Path to checkpoint to resume from")

    # Atropos API settings
    api_url: str = Field(default="http://localhost:8000", description="Atropos API URL")

    # Logging settings
    log_to_file: bool = Field(default=True, description="Log metrics to file")
    log_file: str = Field(default="./logs/training_metrics.jsonl", description="Metrics log file")

    # W&B settings
    use_wandb: bool = Field(default=True, description="Enable W&B logging")
    wandb_project: str = Field(default="feed-training", description="W&B project name")
    wandb_group: str = Field(default="feed-training", description="W&B run group")
    wandb_entity: str | None = Field(default=None, description="W&B entity/team")
    wandb_run_name: str | None = Field(default=None, description="W&B run name")

    # Judge model settings
    judge_model: str = Field(default="gpt-4o-mini", description="Model for AI judge scoring")

    # Optimizer settings
    optimizer: str = Field(default="apollo", description="Optimizer: 'adamw' or 'apollo'")
    weight_decay: float = Field(default=0.0, description="Weight decay")
    apollo_rank: int = Field(default=128, description="APOLLO low-rank projection rank")
    apollo_scale: float = Field(default=32.0, description="APOLLO projection scale")
    apollo_update_proj_gap: int = Field(
        default=200, description="APOLLO projection refresh interval"
    )

    # Kondo gate settings
    use_kondo: bool = Field(
        default=True, description="Enable Kondo gate for selective backward passes"
    )
    kondo_gate_rate: float | None = Field(
        default=0.3, description="Fraction of backward passes to keep"
    )
    kondo_price: float | None = Field(
        default=None, description="Fixed delight threshold (overrides gate_rate)"
    )
    kondo_temperature: float = Field(default=0.1, description="Gate softness")
    kondo_hard: bool = Field(default=True, description="Binary gating vs soft sigmoid weights")
    kondo_deterministic: bool = Field(
        default=True, description="Deterministic top-k vs stochastic Bernoulli"
    )

    # TurboQuant KV cache during training rollouts
    use_turboquant: bool = Field(
        default=True, description="Enable TurboQuant KV cache for training forward passes"
    )
    turboquant_key_bits: float = Field(default=3.5, description="TurboQuant key quantization bits")
    turboquant_value_bits: float = Field(
        default=3.5, description="TurboQuant value quantization bits"
    )
    turboquant_residual_length: int = Field(
        default=128, description="TurboQuant full-precision residual window"
    )


def get_lr_scheduler(
    optimizer: AdamW,
    scheduler_type: LRSchedulerType,
    num_training_steps: int,
    warmup_steps: int,
    min_lr_ratio: float,
) -> LambdaLR:
    """
    Create a learning rate scheduler.

    Args:
        optimizer: The optimizer to schedule
        scheduler_type: Type of scheduler (constant, linear, cosine)
        num_training_steps: Total number of training steps
        warmup_steps: Number of warmup steps
        min_lr_ratio: Minimum LR as a ratio of initial LR
    """

    def lr_lambda(current_step: int) -> float:
        # Warmup phase
        if current_step < warmup_steps:
            return float(current_step) / float(max(1, warmup_steps))

        # After warmup
        progress = float(current_step - warmup_steps) / float(
            max(1, num_training_steps - warmup_steps)
        )
        progress = min(1.0, progress)  # Clamp to [0, 1]

        if scheduler_type == LRSchedulerType.CONSTANT:
            return 1.0

        elif scheduler_type == LRSchedulerType.LINEAR:
            # Linear decay from 1.0 to min_lr_ratio
            return max(min_lr_ratio, 1.0 - progress * (1.0 - min_lr_ratio))

        elif scheduler_type == LRSchedulerType.COSINE:
            # Cosine decay from 1.0 to min_lr_ratio
            cosine_decay = 0.5 * (1.0 + math.cos(math.pi * progress))
            return min_lr_ratio + (1.0 - min_lr_ratio) * cosine_decay

        return 1.0

    return LambdaLR(optimizer, lr_lambda)


class FeedAtroposTrainer:
    """
    GRPO Trainer for Feed using Atropos

    This trainer:
    1. Registers with Atropos API server
    2. Pulls batches of scored trajectories
    3. Trains using GRPO (Group Relative Policy Optimization)
    4. Periodically saves checkpoints and restarts vLLM
    5. Logs metrics to W&B and/or JSONL
    """

    def __init__(self, config: AtroposTrainingConfig):
        self.config = config
        self.model: AutoModelForCausalLM | None = None
        self.tokenizer: AutoTokenizer | None = None
        self.optimizer: torch.optim.Optimizer | None = None
        self.scheduler: LambdaLR | None = None
        self.kondo_gate = None
        self.turboquant_settings: TurboQuantSettings | None = None
        self.current_step: int = 0
        self.vllm_process: subprocess.Popen | None = None
        self.run_id: str = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        self._wandb_initialized: bool = False
        self._checkpoint_history: list[str] = []

    def setup(self):
        """Initialize model, tokenizer, optimizer, Kondo gate, and TurboQuant cache"""
        logger.info(f"Loading model: {self.config.model_name}")

        self.tokenizer = AutoTokenizer.from_pretrained(
            self.config.model_name, trust_remote_code=True
        )

        self.model = AutoModelForCausalLM.from_pretrained(
            self.config.model_name, torch_dtype=torch.bfloat16, trust_remote_code=True
        )

        self.model.to(self.config.device)
        self.model.gradient_checkpointing_enable()
        self.model.train()

        # Create optimizer (AdamW or APOLLO)
        self.optimizer = _create_optimizer(
            self.model,
            optimizer_name=self.config.optimizer,
            lr=self.config.learning_rate,
            weight_decay=self.config.weight_decay,
            apollo_rank=self.config.apollo_rank,
            apollo_scale=self.config.apollo_scale,
            apollo_update_proj_gap=self.config.apollo_update_proj_gap,
        )

        # Create LR scheduler
        min_lr_ratio = self.config.min_learning_rate / self.config.learning_rate
        self.scheduler = get_lr_scheduler(
            optimizer=self.optimizer,
            scheduler_type=self.config.lr_scheduler,
            num_training_steps=self.config.training_steps,
            warmup_steps=self.config.warmup_steps,
            min_lr_ratio=min_lr_ratio,
        )

        # Initialize Kondo gate for selective backward passes
        if self.config.use_kondo:
            try:
                from kondo_gate import KondoGate, KondoGateConfig

                self.kondo_gate = KondoGate(
                    KondoGateConfig(
                        gate_rate=self.config.kondo_gate_rate
                        if self.config.kondo_price is None
                        else None,
                        price=self.config.kondo_price,
                        temperature=self.config.kondo_temperature,
                        hard=self.config.kondo_hard,
                        deterministic=self.config.kondo_deterministic,
                    )
                )
                logger.info(
                    f"Kondo gate enabled: rate={self.config.kondo_gate_rate}, "
                    f"hard={self.config.kondo_hard}, deterministic={self.config.kondo_deterministic}"
                )
            except ImportError:
                logger.warning("kondo-gate not installed, disabling Kondo gating")
                self.kondo_gate = None

        # Initialize TurboQuant KV cache settings for training forward passes
        if self.config.use_turboquant:
            self.turboquant_settings = TurboQuantSettings(
                key_bits=self.config.turboquant_key_bits,
                value_bits=self.config.turboquant_value_bits,
                residual_length=self.config.turboquant_residual_length,
            )
            logger.info(
                f"TurboQuant KV cache enabled: K={self.config.turboquant_key_bits}b, "
                f"V={self.config.turboquant_value_bits}b, residual={self.config.turboquant_residual_length}"
            )

        logger.info(f"Model loaded on {self.config.device}, optimizer={self.config.optimizer}")
        logger.info(
            f"LR scheduler: {self.config.lr_scheduler.value} (warmup: {self.config.warmup_steps} steps)"
        )

    def setup_wandb(self) -> bool:
        """
        Initialize Weights & Biases logging.

        Returns True if W&B was successfully initialized, False otherwise.
        Automatically falls back to offline mode if no API key is set.
        """
        if not self.config.use_wandb:
            logger.info("W&B logging disabled via config")
            return False

        import wandb

        api_key = os.getenv("WANDB_API_KEY")
        if not api_key:
            logger.warning("WANDB_API_KEY not set, using offline mode")
            mode = "offline"
        else:
            mode = "online"

        # Prepare config dict for W&B
        wandb_config = {
            "model_name": self.config.model_name,
            "learning_rate": self.config.learning_rate,
            "min_learning_rate": self.config.min_learning_rate,
            "lr_scheduler": self.config.lr_scheduler.value,
            "warmup_steps": self.config.warmup_steps,
            "training_steps": self.config.training_steps,
            "batch_size": self.config.batch_size,
            "gradient_accumulation_steps": self.config.gradient_accumulation_steps,
            "seq_len": self.config.seq_len,
            "max_grad_norm": self.config.max_grad_norm,
            "device": self.config.device,
            "judge_model": self.config.judge_model,
            "optimizer": self.config.optimizer,
            "apollo_rank": self.config.apollo_rank,
            "use_kondo": self.config.use_kondo,
            "kondo_gate_rate": self.config.kondo_gate_rate,
            "use_turboquant": self.config.use_turboquant,
        }

        run_name = self.config.wandb_run_name or f"feed-grpo-{self.run_id}"

        wandb.init(
            project=self.config.wandb_project,
            entity=self.config.wandb_entity,
            name=run_name,
            config=wandb_config,
            mode=mode,
            resume="allow" if self.config.resume_from else None,
        )

        self._wandb_initialized = True
        logger.info(f"W&B initialized: project={self.config.wandb_project}, mode={mode}")

        return True

    def setup_logging(self):
        """Initialize metrics logging (file and W&B)"""
        if self.config.log_to_file:
            log_dir = Path(self.config.log_file).parent
            log_dir.mkdir(parents=True, exist_ok=True)
            logger.info(f"Metrics will be logged to: {self.config.log_file}")

        # Initialize W&B
        self.setup_wandb()

    def log_metrics(self, metrics: dict, step: int):
        """Log metrics to file and W&B"""
        if self.config.log_to_file:
            full_metrics = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "run_id": self.run_id,
                "step": step,
                **metrics,
            }
            with open(self.config.log_file, "a") as f:
                f.write(json.dumps(full_metrics) + "\n")

        if self._wandb_initialized:
            import wandb

            wandb.log(metrics, step=step)

    def load_checkpoint(self, checkpoint_path: str) -> int:
        """
        Load model, optimizer, and scheduler state from checkpoint.

        Returns the step number to resume from.
        """
        logger.info(f"Loading checkpoint from: {checkpoint_path}")

        checkpoint_dir = Path(checkpoint_path)

        # Load model
        self.model = AutoModelForCausalLM.from_pretrained(
            checkpoint_dir, torch_dtype=torch.bfloat16, trust_remote_code=True
        )
        self.model.to(self.config.device)
        self.model.gradient_checkpointing_enable()
        self.model.train()

        # Load tokenizer
        self.tokenizer = AutoTokenizer.from_pretrained(checkpoint_dir, trust_remote_code=True)

        # Re-create optimizer (matching the configured type)
        self.optimizer = _create_optimizer(
            self.model,
            optimizer_name=self.config.optimizer,
            lr=self.config.learning_rate,
            weight_decay=self.config.weight_decay,
            apollo_rank=self.config.apollo_rank,
            apollo_scale=self.config.apollo_scale,
            apollo_update_proj_gap=self.config.apollo_update_proj_gap,
        )

        # Load optimizer state if available
        optimizer_path = checkpoint_dir / "optimizer.pt"
        if optimizer_path.exists():
            optimizer_state = torch.load(optimizer_path, map_location=self.config.device)
            self.optimizer.load_state_dict(optimizer_state["optimizer"])
            resume_step = optimizer_state.get("step", 0)
            logger.info(f"Loaded optimizer state from step {resume_step}")
        else:
            resume_step = self._extract_step_from_path(checkpoint_path)
            logger.warning(f"No optimizer state found, resuming from step {resume_step}")

        # Re-create scheduler and advance to current step
        min_lr_ratio = self.config.min_learning_rate / self.config.learning_rate
        self.scheduler = get_lr_scheduler(
            optimizer=self.optimizer,
            scheduler_type=self.config.lr_scheduler,
            num_training_steps=self.config.training_steps,
            warmup_steps=self.config.warmup_steps,
            min_lr_ratio=min_lr_ratio,
        )

        # Advance scheduler to current step
        for _ in range(resume_step):
            self.scheduler.step()

        logger.info(f"Checkpoint loaded, resuming from step {resume_step}")
        return resume_step

    def _extract_step_from_path(self, path: str) -> int:
        """Extract step number from checkpoint path like 'step_50'"""
        name = Path(path).name
        if name.startswith("step_"):
            step_str = name.replace("step_", "")
            if step_str.isdigit():
                return int(step_str)
        return 0

    @retry(stop=stop_after_attempt(5), wait=wait_exponential(multiplier=1, min=2, max=30))
    def register_with_api(self):
        """Register trainer with Atropos API"""
        logger.info(f"Registering with Atropos API at {self.config.api_url}")

        response = requests.post(
            f"{self.config.api_url}/register",
            json={
                "wandb_group": self.config.wandb_group,
                "wandb_project": self.config.wandb_project,
                "batch_size": self.config.batch_size * self.config.gradient_accumulation_steps,
                "max_token_len": self.config.seq_len,
                "starting_step": self.current_step,
                "checkpoint_dir": self.config.save_path,
                "save_checkpoint_interval": self.config.save_every_steps,
                "num_steps": self.config.training_steps,
            },
            timeout=30,
        )
        response.raise_for_status()

        result = response.json()
        logger.info(f"Registered with API: {result}")
        return result

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=10))
    def get_batch(self) -> list | None:
        """Get next batch from Atropos API"""
        response = requests.get(f"{self.config.api_url}/batch", timeout=30)
        response.raise_for_status()

        data = response.json()
        return data.get("batch")

    def start_vllm(self, model_path: str | None = None):
        """Start vLLM inference server"""
        global vllm_process

        # Terminate existing process
        if self.vllm_process:
            logger.info("Terminating existing vLLM process...")
            self.vllm_process.terminate()
            deadline = time.time() + 5
            while self.vllm_process.poll() is None and time.time() < deadline:
                time.sleep(0.1)
            if self.vllm_process.poll() is None:
                self.vllm_process.kill()
                self.vllm_process.wait()
            self.vllm_process = None

        # Clear CUDA cache
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        model_to_load = model_path or self.config.model_name

        cmd = [
            "python",
            "-m",
            "vllm.entrypoints.openai.api_server",
            "--model",
            model_to_load,
            "--port",
            str(self.config.vllm_port),
            "--dtype",
            "auto",
            "--gpu-memory-utilization",
            str(self.config.vllm_gpu_utilization),
            "--disable-log-requests",
            "--served-model-name",
            self.config.model_name,
        ]

        logger.info(f"Starting vLLM: {' '.join(cmd)}")

        self.vllm_process = subprocess.Popen(cmd)
        vllm_process = self.vllm_process  # Update global for cleanup

        logger.info(f"vLLM started with PID: {self.vllm_process.pid}")

        # Wait for server to be ready with health check
        self._wait_for_vllm_ready()

    def _wait_for_vllm_ready(self, timeout: int = 120, poll_interval: float = 2.0):
        """Wait for vLLM server to be ready, with health checks"""
        vllm_url = f"http://localhost:{self.config.vllm_port}/health"
        start_time = time.time()

        logger.info(f"Waiting for vLLM server to be ready (timeout: {timeout}s)...")

        while time.time() - start_time < timeout:
            # Check if process died
            if self.vllm_process and self.vllm_process.poll() is not None:
                raise RuntimeError(f"vLLM process died with code {self.vllm_process.returncode}")

            try:
                response = requests.get(vllm_url, timeout=5)
                if response.status_code == 200:
                    logger.info("vLLM server is ready!")
                    return
            except requests.exceptions.ConnectionError:
                pass  # Server not ready yet
            except requests.exceptions.Timeout:
                pass  # Server busy loading

            time.sleep(poll_interval)

        raise TimeoutError(f"vLLM server did not become ready within {timeout} seconds")

    def prepare_batch(self, batch_data: list) -> tuple[list, list, list, list]:
        """
        Prepare batch data for GRPO training

        Returns:
            token_batches: List of token tensors
            label_batches: List of label tensors (with -100 for non-trainable tokens)
            advantage_batches: List of advantage tensors
            temperature_batches: List of temperature tensors
        """
        max_token_len = 0
        for item in batch_data:
            for tokens in item.get("tokens", []):
                max_token_len = max(max_token_len, len(tokens))

        # Pad to multiple of 64 for efficiency
        good_multiple = 64
        if (max_token_len - 1) % good_multiple != 0:
            max_token_len = math.ceil((max_token_len - 1) / good_multiple) * good_multiple + 1

        input_ids_list = []
        labels_list = []
        advantages_list = []
        temperatures_list = []

        for item in batch_data:
            scores = np.array(item.get("scores", [0.0]))

            # Normalize scores within group
            if len(scores) > 1:
                scores = scores - scores.mean()
                std = scores.std()
                if std > 1e-8:
                    scores = scores / std

            tokens_list = item.get("tokens", [])
            masks_list = item.get("masks", [])

            for i in range(len(tokens_list)):
                tokens = np.array(tokens_list[i])
                masks = np.array(masks_list[i])
                score = scores[i] if i < len(scores) else 0.0

                # Pad tokens and masks
                pad_length = max(0, max_token_len - len(tokens))

                padded_tokens = np.concatenate([tokens, np.zeros(pad_length, dtype=np.int32)])
                padded_masks = np.concatenate([masks, np.full(pad_length, -100, dtype=np.int32)])

                # Create input_ids (all but last) and labels (all but first, shifted)
                input_ids_list.append(padded_tokens[:-1])
                labels_list.append(padded_masks[1:])
                advantages_list.append(score)

                # Get temperature from overrides or default to 1.0
                temp = 1.0
                overrides = item.get("overrides")
                if overrides and i < len(overrides) and isinstance(overrides[i], dict):
                    temp = float(overrides[i].get("temperature", 1.0))
                elif item.get("generation_params"):
                    temp = float(item["generation_params"].get("temperature", 1.0))
                temperatures_list.append(temp)

        # Split into batches
        batch_size = self.config.batch_size
        token_batches = []
        label_batches = []
        advantage_batches = []
        temperature_batches = []

        num_batches = len(input_ids_list) // batch_size

        for i in range(num_batches):
            start = i * batch_size
            end = start + batch_size

            token_batches.append(torch.tensor(np.stack(input_ids_list[start:end])))
            label_batches.append(torch.tensor(np.stack(labels_list[start:end])))
            advantage_batches.append(
                torch.tensor(advantages_list[start:end], dtype=torch.float32).view(-1, 1)
            )
            temperature_batches.append(
                torch.tensor(temperatures_list[start:end], dtype=torch.float32).view(-1, 1, 1)
            )

        return token_batches, label_batches, advantage_batches, temperature_batches

    def _build_past_key_values(self):
        """Build TurboQuant KV cache for the training forward pass, if enabled."""
        if self.turboquant_settings is None or self.model is None:
            return None
        return build_generation_cache(
            self.model.config,
            cache_implementation="turboquant",
            turboquant_settings=self.turboquant_settings,
        )

    def train_step(
        self,
        token_batches: list[torch.Tensor],
        label_batches: list[torch.Tensor],
        advantage_batches: list[torch.Tensor],
        temperature_batches: list[torch.Tensor],
    ) -> dict:
        """Execute one GRPO training step with Kondo gate + TurboQuant support"""
        assert self.model is not None
        assert self.optimizer is not None
        assert self.scheduler is not None

        total_loss = 0.0
        total_pos_logp = 0.0
        total_neg_logp = 0.0
        total_pos = 0
        total_neg = 0
        kondo_metrics = {
            "kondo_gate_rate": 0.0,
            "kondo_mean_delight": 0.0,
            "kondo_backward_skipped": 0,
            "kondo_backward_executed": 0,
        }

        for tokens, labels, advantages, temperatures in zip(
            token_batches, label_batches, advantage_batches, temperature_batches, strict=False
        ):
            tokens = tokens.to(self.config.device)
            labels = labels.to(self.config.device)
            advantages = advantages.to(self.config.device)

            # Forward pass (with optional TurboQuant KV cache)
            forward_kwargs = {"input_ids": tokens}
            past_kv = self._build_past_key_values()
            if past_kv is not None:
                forward_kwargs["past_key_values"] = past_kv
            outputs = self.model(**forward_kwargs)
            logits = outputs.logits

            # Temperature scaling
            t = temperatures.to(logits.device, logits.dtype)
            t = torch.where(t <= 0, torch.ones_like(t), t)
            logits = logits / t

            # Calculate log probabilities
            logp_per_token = -F.cross_entropy(
                logits.view(-1, logits.size(-1)),
                labels.view(-1),
                reduction="none",
                ignore_index=-100,
            ).view(labels.shape)

            # Create mask for trainable tokens
            mask = (labels != -100).float()

            with torch.no_grad():
                pos = (advantages > 0).float()
                neg = (advantages <= 0).float()
                mask_sum = mask.sum(dim=-1).clamp_min(1e-8)

                avg_logp = (logp_per_token * mask).sum(dim=-1) / mask_sum
                pos_logp = (avg_logp * pos.squeeze(-1)).sum().item()
                neg_logp = (avg_logp * neg.squeeze(-1)).sum().item()

                total_pos_logp += pos_logp
                total_neg_logp += neg_logp
                total_pos += pos.sum().item()
                total_neg += neg.sum().item()

            # ── Kondo gate: decide whether this batch deserves a backward pass ──
            if self.kondo_gate is not None:
                with torch.no_grad():
                    # Per-sample mean log-prob as the "action log-prob" for gating
                    sample_logp = (logp_per_token * mask).sum(dim=-1) / mask_sum
                    gate_output = self.kondo_gate.compute_gate(
                        sample_logp,
                        advantages.squeeze(-1),
                    )
                    kondo_metrics["kondo_gate_rate"] = float(gate_output.actual_gate_rate.item())
                    kondo_metrics["kondo_mean_delight"] = float(
                        gate_output.delight.float().mean().item()
                    )

                if self.config.kondo_hard:
                    # Hard gating: skip backward entirely if no samples selected
                    selected = gate_output.gate_weights.nonzero(as_tuple=True)[0]
                    if len(selected) == 0:
                        kondo_metrics["kondo_backward_skipped"] += 1
                        continue
                    kondo_metrics["kondo_backward_executed"] += 1
                    # Re-weight advantages by gate for selected samples
                    gate_scale = gate_output.gate_weights.to(advantages.device).unsqueeze(-1)
                    advantages = advantages * gate_scale
                else:
                    # Soft gating: scale advantages by gate probability
                    kondo_metrics["kondo_backward_executed"] += 1
                    gate_scale = gate_output.gate_weights.to(advantages.device).unsqueeze(-1)
                    advantages = advantages * gate_scale
            else:
                kondo_metrics["kondo_backward_executed"] += 1

            # GRPO loss calculation
            grpo_loss_term = torch.exp(logp_per_token - logp_per_token.detach())
            grpo_loss = (
                ((-grpo_loss_term * mask).sum(-1) / mask.sum(-1))
                * advantages.to(logp_per_token.device).squeeze(-1)
            ).mean() / self.config.gradient_accumulation_steps

            grpo_loss.backward()
            total_loss += grpo_loss.item()

        # Gradient clipping and optimizer step
        grad_norm = torch.nn.utils.clip_grad_norm_(
            self.model.parameters(), max_norm=self.config.max_grad_norm
        )

        self.optimizer.step()
        self.optimizer.zero_grad()

        # Update learning rate
        self.scheduler.step()
        current_lr = self.scheduler.get_last_lr()[0]

        # Normalize metrics
        if total_pos > 0:
            total_pos_logp /= total_pos
        if total_neg > 0:
            total_neg_logp /= total_neg

        return {
            "loss": total_loss,
            "grad_norm": grad_norm.item(),
            "learning_rate": current_lr,
            "pos_logp": total_pos_logp,
            "neg_logp": total_neg_logp,
            "total_pos": total_pos,
            "total_neg": total_neg,
            **kondo_metrics,
        }

    def save_checkpoint(self, step: int, is_final: bool = False) -> str:
        """Save model checkpoint with optimizer state"""
        assert self.model is not None
        assert self.tokenizer is not None
        assert self.optimizer is not None

        checkpoint_name = "final_model" if is_final else f"step_{step}"
        checkpoint_path = os.path.join(self.config.save_path, checkpoint_name)

        # Remove existing checkpoint with same name
        if os.path.exists(checkpoint_path):
            shutil.rmtree(checkpoint_path)

        os.makedirs(checkpoint_path, exist_ok=True)

        # Save model and tokenizer
        self.model.save_pretrained(checkpoint_path)
        self.tokenizer.save_pretrained(checkpoint_path)

        # Save optimizer state
        optimizer_state = {
            "optimizer": self.optimizer.state_dict(),
            "step": step,
            "run_id": self.run_id,
        }
        torch.save(optimizer_state, os.path.join(checkpoint_path, "optimizer.pt"))

        logger.info(f"Checkpoint saved: {checkpoint_path}")

        # Manage checkpoint history (keep last N)
        if not is_final:
            self._checkpoint_history.append(checkpoint_path)
            while len(self._checkpoint_history) > self.config.keep_checkpoints:
                old_checkpoint = self._checkpoint_history.pop(0)
                if os.path.exists(old_checkpoint) and old_checkpoint != checkpoint_path:
                    logger.info(f"Removing old checkpoint: {old_checkpoint}")
                    shutil.rmtree(old_checkpoint)

        return checkpoint_path

    async def train(self, steps: int | None = None, batch_size: int | None = None) -> dict:
        """Main training loop (async interface for compatibility)"""
        if steps:
            self.config.training_steps = steps
        if batch_size:
            self.config.batch_size = batch_size

        return self._train_sync()

    def _train_sync(self) -> dict:
        """Synchronous training loop"""
        logger.info("=" * 60)
        logger.info("FEED GRPO TRAINING")
        logger.info("=" * 60)
        logger.info(f"Model: {self.config.model_name}")
        logger.info(f"Steps: {self.config.training_steps}")
        logger.info(f"Batch size: {self.config.batch_size}")
        logger.info(
            f"LR: {self.config.learning_rate} (scheduler: {self.config.lr_scheduler.value})"
        )
        logger.info(f"Device: {self.config.device}")
        logger.info("=" * 60)

        # Check for resume
        if self.config.resume_from:
            self.current_step = self.load_checkpoint(self.config.resume_from)
        else:
            # Fresh setup
            self.setup()

        self.setup_logging()
        self.register_with_api()

        # Start vLLM (unless skipped)
        if not self.config.skip_vllm:
            self.start_vllm()
        else:
            logger.info("Skipping vLLM startup (--skip-vllm flag set)")

        # Create save directory
        os.makedirs(self.config.save_path, exist_ok=True)

        batches_buffer: list = []
        all_metrics: list[dict] = []
        successful_steps = 0  # Track steps that actually trained

        start_step = self.current_step
        for step in range(start_step, self.config.training_steps):
            self.current_step = step + 1
            logger.info(f"Step {self.current_step}/{self.config.training_steps}")

            # Get batch data
            while not batches_buffer:
                batch = self.get_batch()
                if batch:
                    batches_buffer = batch if isinstance(batch, list) else [batch]
                else:
                    logger.info("Waiting for batch data...")
                    time.sleep(2)

            # Prepare batch
            batch_data = batches_buffer.pop(0) if batches_buffer else []
            if not isinstance(batch_data, list):
                batch_data = [batch_data]

            raw_scores = [float(score) for item in batch_data for score in item.get("scores", [])]

            token_batches, label_batches, advantage_batches, temperature_batches = (
                self.prepare_batch(batch_data)
            )

            if not token_batches:
                logger.warning("Empty batch, skipping step")
                continue

            # Train step
            metrics = self.train_step(
                token_batches, label_batches, advantage_batches, temperature_batches
            )

            # Count as successful if we got non-zero gradients
            if metrics.get("grad_norm", 0) > 0:
                successful_steps += 1

            logger.info(
                f"  Loss: {metrics['loss']:.4f}, "
                f"Grad norm: {metrics['grad_norm']:.4f}, "
                f"LR: {metrics['learning_rate']:.2e}"
            )

            reward_mean = sum(raw_scores) / len(raw_scores) if raw_scores else 0.0
            reward_min = min(raw_scores) if raw_scores else 0.0
            reward_max = max(raw_scores) if raw_scores else 0.0
            reward_std = 0.0
            if len(raw_scores) > 1:
                reward_std = (
                    sum((score - reward_mean) ** 2 for score in raw_scores) / len(raw_scores)
                ) ** 0.5

            # Log metrics
            log_data = {
                "train/loss": metrics["loss"],
                "train/grad_norm": metrics["grad_norm"],
                "train/learning_rate": metrics["learning_rate"],
                "train/pos_logp": metrics["pos_logp"],
                "train/neg_logp": metrics["neg_logp"],
                "train/successful_steps": successful_steps,
                "train/reward_mean": reward_mean,
                "train/reward_std": reward_std,
                "train/reward_min": reward_min,
                "train/reward_max": reward_max,
                "train/reward_count": len(raw_scores),
            }
            if self.config.use_kondo:
                log_data.update(
                    {
                        "kondo/gate_rate": metrics.get("kondo_gate_rate", 0.0),
                        "kondo/mean_delight": metrics.get("kondo_mean_delight", 0.0),
                        "kondo/backward_skipped": metrics.get("kondo_backward_skipped", 0),
                        "kondo/backward_executed": metrics.get("kondo_backward_executed", 0),
                    }
                )
            self.log_metrics(log_data, self.current_step)

            metrics["reward_mean"] = reward_mean
            metrics["reward_std"] = reward_std
            metrics["reward_min"] = reward_min
            metrics["reward_max"] = reward_max
            metrics["reward_count"] = len(raw_scores)
            all_metrics.append(metrics)

            # Checkpoint and vLLM restart
            should_checkpoint = (
                self.current_step % self.config.save_every_steps == 0
                or self.current_step == self.config.training_steps
            )

            if should_checkpoint:
                checkpoint_path = self.save_checkpoint(self.current_step)

                # Restart vLLM with new weights (if not final step and not skipped)
                if not self.config.skip_vllm and self.current_step < self.config.training_steps:
                    if self.current_step % self.config.vllm_restart_interval == 0:
                        self.start_vllm(checkpoint_path)

        # Final save - ONLY if we actually trained
        final_checkpoint = None
        if successful_steps > 0:
            final_checkpoint = self.save_checkpoint(self.current_step, is_final=True)
            logger.info(f"Training complete with {successful_steps} successful steps")
        else:
            logger.warning(
                "NO SUCCESSFUL TRAINING STEPS - model NOT saved! "
                "This may indicate issues with scoring (all identical scores) "
                "or empty batches. Check data quality and scoring logic."
            )

        # Finish W&B run
        if self._wandb_initialized:
            import wandb

            wandb.finish()

        logger.info("=" * 60)
        logger.info("TRAINING COMPLETE")
        logger.info(f"Successful steps: {successful_steps}/{self.current_step}")
        if final_checkpoint:
            logger.info(f"Final checkpoint: {final_checkpoint}")
        else:
            logger.warning("No checkpoint saved - training was ineffective")
        logger.info("=" * 60)

        return {
            "steps": self.current_step,
            "successful_steps": successful_steps,
            "final_checkpoint": final_checkpoint,
            "metrics": all_metrics,
        }


def main():
    """CLI entry point"""
    import argparse

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    )

    parser = argparse.ArgumentParser(description="Feed GRPO Trainer with Atropos")

    # Model settings
    parser.add_argument("--model", default="Qwen/Qwen3.5-4B", help="Model to train")
    parser.add_argument("--steps", type=int, default=100, help="Training steps")
    parser.add_argument("--batch-size", type=int, default=4, help="Batch size")

    # Learning rate settings
    parser.add_argument("--lr", type=float, default=1e-5, help="Initial learning rate")
    parser.add_argument("--min-lr", type=float, default=1e-7, help="Minimum learning rate")
    parser.add_argument(
        "--lr-scheduler",
        choices=["constant", "linear", "cosine"],
        default="cosine",
        help="Learning rate scheduler",
    )
    parser.add_argument("--warmup-steps", type=int, default=10, help="LR warmup steps")

    # Checkpoint settings
    parser.add_argument("--save-path", default="./trained_models", help="Checkpoint directory")
    parser.add_argument("--save-every", type=int, default=5, help="Save checkpoint every N steps")
    parser.add_argument("--keep-checkpoints", type=int, default=3, help="Checkpoints to keep")
    parser.add_argument("--resume", help="Resume from checkpoint path")

    # API settings
    parser.add_argument("--api-url", default="http://localhost:8000", help="Atropos API URL")
    parser.add_argument("--vllm-port", type=int, default=9001, help="vLLM server port")
    parser.add_argument(
        "--skip-vllm", action="store_true", help="Skip vLLM startup (assumes already running)"
    )

    # Logging settings
    parser.add_argument(
        "--log-file", default="./logs/training_metrics.jsonl", help="Metrics log file"
    )

    # W&B settings
    parser.add_argument("--no-wandb", action="store_true", help="Disable W&B logging")
    parser.add_argument("--wandb-project", default="feed-training", help="W&B project")
    parser.add_argument("--wandb-entity", help="W&B entity/team")
    parser.add_argument("--wandb-run-name", help="W&B run name")

    # Optimizer settings
    parser.add_argument(
        "--optimizer",
        choices=["adamw", "apollo"],
        default="adamw",
        help="Optimizer: adamw (default) or apollo (full-param, no LoRA)",
    )
    parser.add_argument("--weight-decay", type=float, default=0.0, help="Weight decay")
    parser.add_argument("--apollo-rank", type=int, default=128, help="APOLLO projection rank")
    parser.add_argument("--apollo-scale", type=float, default=32.0, help="APOLLO projection scale")
    parser.add_argument(
        "--apollo-update-proj-gap", type=int, default=200, help="APOLLO projection refresh interval"
    )

    # Kondo gate settings
    parser.add_argument(
        "--kondo", action="store_true", help="Enable Kondo gate for selective backward passes"
    )
    parser.add_argument(
        "--kondo-gate-rate", type=float, default=0.3, help="Fraction of backward passes to keep"
    )
    parser.add_argument("--kondo-price", type=float, default=None, help="Fixed delight threshold")
    parser.add_argument("--kondo-temperature", type=float, default=0.1, help="Gate softness")
    parser.add_argument(
        "--kondo-soft", action="store_true", help="Use soft sigmoid gating instead of hard"
    )
    parser.add_argument(
        "--kondo-stochastic", action="store_true", help="Use stochastic Bernoulli instead of top-k"
    )

    # TurboQuant settings
    parser.add_argument(
        "--turboquant", action="store_true", help="Enable TurboQuant KV cache during training"
    )
    parser.add_argument(
        "--turboquant-key-bits", type=float, default=3.5, help="TurboQuant key bits"
    )
    parser.add_argument(
        "--turboquant-value-bits", type=float, default=3.5, help="TurboQuant value bits"
    )
    parser.add_argument(
        "--turboquant-residual", type=int, default=128, help="TurboQuant residual window"
    )

    args = parser.parse_args()

    config = AtroposTrainingConfig(
        model_name=args.model,
        training_steps=args.steps,
        batch_size=args.batch_size,
        learning_rate=args.lr,
        min_learning_rate=args.min_lr,
        lr_scheduler=LRSchedulerType(args.lr_scheduler),
        warmup_steps=args.warmup_steps,
        save_path=args.save_path,
        save_every_steps=args.save_every,
        keep_checkpoints=args.keep_checkpoints,
        resume_from=args.resume,
        api_url=args.api_url,
        vllm_port=args.vllm_port,
        skip_vllm=args.skip_vllm,
        log_file=args.log_file,
        use_wandb=not args.no_wandb,
        wandb_project=args.wandb_project,
        wandb_entity=args.wandb_entity,
        wandb_run_name=args.wandb_run_name,
        # Optimizer
        optimizer=args.optimizer,
        weight_decay=args.weight_decay,
        apollo_rank=args.apollo_rank,
        apollo_scale=args.apollo_scale,
        apollo_update_proj_gap=args.apollo_update_proj_gap,
        # Kondo gate
        use_kondo=args.kondo,
        kondo_gate_rate=None if args.kondo_price is not None else args.kondo_gate_rate,
        kondo_price=args.kondo_price,
        kondo_temperature=args.kondo_temperature,
        kondo_hard=not args.kondo_soft,
        kondo_deterministic=not args.kondo_stochastic,
        # TurboQuant
        use_turboquant=args.turboquant,
        turboquant_key_bits=args.turboquant_key_bits,
        turboquant_value_bits=args.turboquant_value_bits,
        turboquant_residual_length=args.turboquant_residual,
    )

    trainer = FeedAtroposTrainer(config)
    trainer._train_sync()


if __name__ == "__main__":
    main()
