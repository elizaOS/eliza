"""
Kondo-Gated SFT: Selective Supervised Fine-Tuning

Standard SFT treats every training example equally. This wastes compute on
examples the model already handles well ("refuse this obvious scam") and
underweights the hard edge cases ("this looks legitimate but isn't").

Kondo-Gated SFT computes delight = loss × surprisal for each example and
only backprops on the top-k% most informative ones. This focuses training
compute on the examples where the model is BOTH wrong AND surprised.

Delight = per-example loss × mean token surprisal
  - High loss + high surprisal = model is wrong AND didn't expect to be → LEARN
  - High loss + low surprisal = model knows it's wrong (already seen) → SKIP
  - Low loss + high surprisal = model is right but surprised → minor LEARN
  - Low loss + low surprisal = model is right and expected to be → SKIP

This gives SFT the efficiency of RL (selective updates) without needing
reward functions or rollout generation.

Usage:
    from training.kondo_sft import KondoSFTTrainer, KondoSFTConfig

    config = KondoSFTConfig(
        model_name="Qwen/Qwen3.5-4B",
        gate_rate=0.1,  # Only backprop on top 10% most informative
    )
    trainer = KondoSFTTrainer(config)
    trainer.train(dataset)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import torch
import torch.nn.functional as F

logger = logging.getLogger(__name__)


@dataclass
class KondoSFTConfig:
    """Configuration for Kondo-Gated SFT."""

    model_name: str = "Qwen/Qwen3.5-4B"
    learning_rate: float = 1e-5
    lora_rank: int = 16
    lora_alpha: int = 32
    max_seq_length: int = 768
    batch_size: int = 1
    gradient_accumulation_steps: int = 4

    # Kondo gate parameters
    gate_rate: float = 0.10  # Top 10% of examples get backprop
    gate_warmup_steps: int = 500  # Train on everything for first N steps
    use_hard_gate: bool = True  # Binary gate (vs soft weighting)

    # What counts as "delight"
    delight_mode: str = "loss_times_surprisal"  # or "loss_only", "surprisal_only"

    # Tracking
    log_every: int = 10


class KondoSFTTrainer:
    """
    SFT trainer with Kondo Gate for selective backpropagation.

    For each batch:
    1. Forward pass: compute per-example loss
    2. Compute surprisal: mean -log_prob across tokens (no grad)
    3. Compute delight: loss × surprisal
    4. Gate: only backprop if delight in top-k%
    5. Accumulate gradients from gated examples only
    6. Step optimizer
    """

    def __init__(self, config: KondoSFTConfig):
        self.config = config
        self.step = 0
        self.total_examples = 0
        self.gated_examples = 0
        self.skipped_examples = 0
        self.delight_history: list[float] = []
        self.loss_history: list[float] = []

    def compute_delight(
        self,
        loss: torch.Tensor,
        logits: torch.Tensor,
        labels: torch.Tensor,
    ) -> float:
        """Compute delight score for a single example."""
        with torch.no_grad():
            # Surprisal: mean negative log probability of correct tokens
            log_probs = F.log_softmax(logits, dim=-1)
            # Only compute on non-masked tokens (labels != -100)
            mask = labels != -100
            if mask.sum() == 0:
                return 0.0

            token_log_probs = log_probs.gather(
                -1, labels.clamp(min=0).unsqueeze(-1)
            ).squeeze(-1)
            surprisal = -(token_log_probs * mask.float()).sum() / mask.sum()

            if self.config.delight_mode == "loss_times_surprisal":
                return (loss.detach() * surprisal).item()
            elif self.config.delight_mode == "loss_only":
                return loss.detach().item()
            elif self.config.delight_mode == "surprisal_only":
                return surprisal.item()
            else:
                return loss.detach().item()

    def should_backprop(self, delight: float) -> bool:
        """Kondo gate decision: should we backprop this example?"""
        # Warmup: always backprop for first N steps
        if self.step < self.config.gate_warmup_steps:
            return True

        # Need history to compute threshold
        if len(self.delight_history) < 20:
            return True

        # Compute threshold: top gate_rate% of recent delight scores
        recent = sorted(self.delight_history[-1000:], reverse=True)
        k = max(1, int(len(recent) * self.config.gate_rate))
        threshold = recent[min(k, len(recent) - 1)]

        return delight >= threshold

    def train_step(
        self,
        model: torch.nn.Module,
        optimizer: torch.optim.Optimizer,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        labels: torch.Tensor,
    ) -> dict[str, Any]:
        """Single training step with Kondo gating."""
        self.step += 1
        self.total_examples += 1

        # Forward pass
        outputs = model(
            input_ids=input_ids,
            attention_mask=attention_mask,
            labels=labels,
        )
        loss = outputs.loss
        logits = outputs.logits

        # Compute delight
        delight = self.compute_delight(loss, logits, labels)
        self.delight_history.append(delight)
        self.loss_history.append(loss.item())

        # Gate decision
        should_update = self.should_backprop(delight)

        if should_update:
            # Scale loss for gradient accumulation
            scaled_loss = loss / self.config.gradient_accumulation_steps
            scaled_loss.backward()
            self.gated_examples += 1
        else:
            self.skipped_examples += 1

        # Step optimizer every gradient_accumulation_steps
        did_step = False
        if self.step % self.config.gradient_accumulation_steps == 0:
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            optimizer.zero_grad()
            did_step = True

        gate_rate = self.gated_examples / max(self.total_examples, 1)
        metrics = {
            "loss": loss.item(),
            "delight": delight,
            "gated": should_update,
            "gate_rate": gate_rate,
            "step": self.step,
            "did_optimizer_step": did_step,
        }

        if self.step % self.config.log_every == 0:
            logger.info(
                f"Step {self.step}: loss={loss.item():.4f} delight={delight:.4f} "
                f"gated={should_update} rate={gate_rate:.1%} "
                f"({self.gated_examples}/{self.total_examples})"
            )

        return metrics

    def get_stats(self) -> dict[str, Any]:
        """Get training statistics."""
        return {
            "total_examples": self.total_examples,
            "gated_examples": self.gated_examples,
            "skipped_examples": self.skipped_examples,
            "effective_gate_rate": self.gated_examples / max(self.total_examples, 1),
            "avg_loss": sum(self.loss_history[-100:]) / max(len(self.loss_history[-100:]), 1),
            "avg_delight": sum(self.delight_history[-100:]) / max(len(self.delight_history[-100:]), 1),
        }
