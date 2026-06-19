from __future__ import annotations

import argparse
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal

LocalTrainingBackend = Literal["mlx", "cuda", "cpu"]
LocalTrainingSampleProfile = Literal["raw", "trade-canonical", "decision-canonical", "canonical"]
LocalTrainingOptimizer = Literal["adamw", "apollo"]
LocalTrainingQuantization = Literal["none", "nf4"]

LOCAL_TRAINING_BACKENDS: tuple[LocalTrainingBackend, ...] = ("mlx", "cuda", "cpu")
LOCAL_TRAINING_SAMPLE_PROFILES: tuple[LocalTrainingSampleProfile, ...] = (
    "raw",
    "trade-canonical",
    "decision-canonical",
    "canonical",
)
LOCAL_TRAINING_OPTIMIZERS: tuple[LocalTrainingOptimizer, ...] = ("adamw", "apollo")
LOCAL_TRAINING_QUANTIZATION_MODES: tuple[LocalTrainingQuantization, ...] = ("none", "nf4")


def parse_lora_target_modules(
    value: str | Iterable[str] | None,
) -> list[str] | None:
    if value is None:
        return None

    raw_items = value.split(",") if isinstance(value, str) else value
    modules: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        module_name = str(item).strip()
        if not module_name or module_name in seen:
            continue
        seen.add(module_name)
        modules.append(module_name)
    return modules or None


@dataclass(frozen=True)
class LocalTrainingRecipe:
    backend: LocalTrainingBackend | None = None
    model: str | None = None
    sample_profile: LocalTrainingSampleProfile = "canonical"
    steps: int = 5
    batch_size: int = 1
    learning_rate: float = 1e-5
    optimizer: LocalTrainingOptimizer = "adamw"
    quantization: LocalTrainingQuantization = "none"
    use_lora: bool = True
    lora_rank: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.1
    lora_target_modules: tuple[str, ...] | None = None
    max_seq_length: int = 1024
    gradient_accumulation_steps: int = 1
    seed: int = 1337
    eval_split_ratio: float = 0.1

    @classmethod
    def from_values(
        cls,
        *,
        backend: LocalTrainingBackend | None = None,
        model: str | None = None,
        sample_profile: LocalTrainingSampleProfile = "canonical",
        steps: int = 5,
        batch_size: int = 1,
        learning_rate: float = 1e-5,
        optimizer: LocalTrainingOptimizer = "adamw",
        quantization: LocalTrainingQuantization = "none",
        use_lora: bool = True,
        lora_rank: int = 16,
        lora_alpha: int = 32,
        lora_dropout: float = 0.1,
        lora_target_modules: str | Iterable[str] | None = None,
        max_seq_length: int = 1024,
        gradient_accumulation_steps: int = 1,
        seed: int = 1337,
        eval_split_ratio: float = 0.1,
    ) -> LocalTrainingRecipe:
        if not 0.0 <= lora_dropout < 1.0:
            raise ValueError("LoRA dropout must be between 0.0 and 1.0.")
        if not 0.0 <= eval_split_ratio < 1.0:
            raise ValueError("Validation split ratio must be between 0.0 and 1.0.")

        parsed_target_modules = parse_lora_target_modules(lora_target_modules)
        return cls(
            backend=backend,
            model=model.strip() if model else None,
            sample_profile=sample_profile,
            steps=max(1, steps),
            batch_size=max(1, batch_size),
            learning_rate=learning_rate,
            optimizer=optimizer,
            quantization=quantization,
            use_lora=use_lora,
            lora_rank=max(1, lora_rank),
            lora_alpha=max(1, lora_alpha),
            lora_dropout=lora_dropout,
            lora_target_modules=tuple(parsed_target_modules) if parsed_target_modules else None,
            max_seq_length=max(1, max_seq_length),
            gradient_accumulation_steps=max(1, gradient_accumulation_steps),
            seed=seed,
            eval_split_ratio=eval_split_ratio,
        )

    def with_overrides(self, **overrides: Any) -> LocalTrainingRecipe:
        values = self.to_dict()
        values.update(overrides)
        return type(self).from_values(**values)

    def to_dict(self) -> dict[str, Any]:
        return {
            "backend": self.backend,
            "model": self.model,
            "sample_profile": self.sample_profile,
            "steps": self.steps,
            "batch_size": self.batch_size,
            "learning_rate": self.learning_rate,
            "optimizer": self.optimizer,
            "quantization": self.quantization,
            "use_lora": self.use_lora,
            "lora_rank": self.lora_rank,
            "lora_alpha": self.lora_alpha,
            "lora_dropout": self.lora_dropout,
            "lora_target_modules": list(self.lora_target_modules)
            if self.lora_target_modules
            else None,
            "max_seq_length": self.max_seq_length,
            "gradient_accumulation_steps": self.gradient_accumulation_steps,
            "seed": self.seed,
            "eval_split_ratio": self.eval_split_ratio,
        }

    def to_prefixed_dict(self, prefix: str) -> dict[str, Any]:
        normalized_prefix = prefix.rstrip("_")
        return {f"{normalized_prefix}_{key}": value for key, value in self.to_dict().items()}

    def to_recipe_dict(self) -> dict[str, Any]:
        return {
            "sample_profile": self.sample_profile,
            "steps": self.steps,
            "batch_size": self.batch_size,
            "learning_rate": self.learning_rate,
            "optimizer": self.optimizer,
            "quantization": self.quantization,
            "lora_enabled": self.use_lora,
            "lora_rank": self.lora_rank,
            "lora_alpha": self.lora_alpha,
            "lora_dropout": self.lora_dropout,
            "lora_target_modules": list(self.lora_target_modules)
            if self.lora_target_modules
            else None,
            "max_seq_length": self.max_seq_length,
            "gradient_accumulation_steps": self.gradient_accumulation_steps,
            "seed": self.seed,
            "validation_split_ratio": self.eval_split_ratio,
        }

    def to_cuda_training_kwargs(self) -> dict[str, Any]:
        return {
            "batch_size": self.batch_size,
            "learning_rate": self.learning_rate,
            "use_lora": self.use_lora,
            "quantization": self.quantization,
            "lora_rank": self.lora_rank,
            "lora_alpha": self.lora_alpha,
            "lora_dropout": self.lora_dropout,
            "lora_target_modules": list(self.lora_target_modules)
            if self.lora_target_modules
            else None,
            "max_steps": self.steps,
            "max_seq_length": self.max_seq_length,
            "gradient_accumulation_steps": self.gradient_accumulation_steps,
            "seed": self.seed,
            "validation_split_ratio": self.eval_split_ratio,
            "optimizer_name": self.optimizer,
        }

    def to_cpu_training_kwargs(self) -> dict[str, Any]:
        return {
            "batch_size": self.batch_size,
            "learning_rate": self.learning_rate,
            "max_steps": self.steps,
            "max_seq_length": self.max_seq_length,
            "gradient_accumulation_steps": self.gradient_accumulation_steps,
            "seed": self.seed,
            "validation_split_ratio": self.eval_split_ratio,
            "optimizer_name": self.optimizer,
        }


def add_local_training_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--local-backend",
        choices=LOCAL_TRAINING_BACKENDS,
        default=None,
        help="Override auto-detected local training backend.",
    )
    parser.add_argument(
        "--local-model",
        default=None,
        help="Override the local training base model.",
    )
    parser.add_argument(
        "--local-sample-profile",
        choices=LOCAL_TRAINING_SAMPLE_PROFILES,
        default="canonical",
        help="How local training converts trajectories into supervised samples.",
    )
    parser.add_argument(
        "--local-steps",
        type=int,
        default=5,
        help="Local training optimizer steps.",
    )
    parser.add_argument(
        "--local-batch-size",
        type=int,
        default=1,
        help="Local training batch size.",
    )
    parser.add_argument(
        "--local-lr",
        type=float,
        default=1e-5,
        help="Local training learning rate.",
    )
    parser.add_argument(
        "--local-optimizer",
        choices=LOCAL_TRAINING_OPTIMIZERS,
        default="adamw",
        help="Optimizer for local CUDA training.",
    )
    parser.add_argument(
        "--local-quantization",
        choices=LOCAL_TRAINING_QUANTIZATION_MODES,
        default="none",
        help="Quantization mode for local CUDA training.",
    )
    parser.add_argument(
        "--local-lora",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable LoRA adapters for local CUDA training.",
    )
    parser.add_argument(
        "--local-lora-rank",
        type=int,
        default=16,
        help="LoRA rank for local CUDA training.",
    )
    parser.add_argument(
        "--local-lora-alpha",
        type=int,
        default=32,
        help="LoRA alpha for local CUDA training.",
    )
    parser.add_argument(
        "--local-lora-dropout",
        type=float,
        default=0.1,
        help="LoRA dropout for local CUDA training.",
    )
    parser.add_argument(
        "--local-lora-target-modules",
        default=None,
        help="Optional comma-separated LoRA target modules for local CUDA training.",
    )
    parser.add_argument(
        "--local-max-seq-length",
        type=int,
        default=1024,
        help="Maximum sequence length for local training tokenization.",
    )
    parser.add_argument(
        "--local-gradient-accumulation-steps",
        type=int,
        default=1,
        help="Gradient accumulation steps for local training.",
    )
    parser.add_argument(
        "--local-seed",
        type=int,
        default=1337,
        help="Seed for local training.",
    )
    parser.add_argument(
        "--local-eval-split-ratio",
        type=float,
        default=0.1,
        help="Validation split ratio when no separate eval set is provided.",
    )


def local_training_recipe_from_args(args: argparse.Namespace) -> LocalTrainingRecipe:
    return LocalTrainingRecipe.from_values(
        backend=getattr(args, "local_backend", None),
        model=getattr(args, "local_model", None),
        sample_profile=getattr(args, "local_sample_profile", "canonical"),
        steps=getattr(args, "local_steps", 5),
        batch_size=getattr(args, "local_batch_size", 1),
        learning_rate=getattr(args, "local_lr", 1e-5),
        optimizer=getattr(args, "local_optimizer", "adamw"),
        quantization=getattr(args, "local_quantization", "none"),
        use_lora=getattr(args, "local_lora", True),
        lora_rank=getattr(args, "local_lora_rank", 16),
        lora_alpha=getattr(args, "local_lora_alpha", 32),
        lora_dropout=getattr(args, "local_lora_dropout", 0.1),
        lora_target_modules=getattr(args, "local_lora_target_modules", None),
        max_seq_length=getattr(args, "local_max_seq_length", 1024),
        gradient_accumulation_steps=getattr(args, "local_gradient_accumulation_steps", 1),
        seed=getattr(args, "local_seed", 1337),
        eval_split_ratio=getattr(args, "local_eval_split_ratio", 0.1),
    )
