"""
KL Divergence Controller for GRPO Training

⚠️ STATUS: NOT YET INTEGRATED
This module is ready to use but not currently called by babylon_env.py or online_env.py.
To integrate, see TRAINING_ROADMAP.md Phase 4.

Prevents reward hacking by penalizing divergence from a reference model.
This helps maintain response quality while optimizing for rewards.

Features:
- Frozen reference model for stable KL computation
- Adaptive KL coefficient based on divergence trends
- Efficient batched KL computation
- Integration with reward function

Usage:
    kl_controller = KLController("Qwen/Qwen2.5-3B-Instruct")
    
    # During reward computation
    penalty, mean_kl = kl_controller.get_penalty(
        policy_logprobs=model_logprobs,
        tokens=input_ids,
        attention_mask=mask,
    )
    
    # Subtract penalty from reward
    adjusted_reward = base_reward - penalty
"""

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Optional torch import for type hints
try:
    import torch
    import torch.nn.functional as F
    from transformers import AutoModelForCausalLM, AutoTokenizer
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False
    torch = None


# =============================================================================
# Configuration
# =============================================================================


@dataclass
class KLConfig:
    """Configuration for KL controller"""
    
    # Reference model
    reference_model_name: str
    
    # KL coefficient
    kl_coeff: float = 0.1
    
    # Target KL for adaptive adjustment
    kl_target: float = 3.0
    
    # Enable adaptive coefficient
    adaptive: bool = True
    
    # Min/max bounds for adaptive coefficient
    kl_coeff_min: float = 0.01
    kl_coeff_max: float = 1.0
    
    # History window for adaptation
    adaptation_window: int = 10
    
    # Coefficient adjustment factors
    increase_factor: float = 1.5
    decrease_factor: float = 0.8
    
    # Device for reference model
    device: str = "auto"
    
    # Use bfloat16 for memory efficiency
    use_bf16: bool = True


# =============================================================================
# KL Statistics
# =============================================================================


@dataclass
class KLStats:
    """Statistics from KL computation"""
    mean_kl: float = 0.0
    max_kl: float = 0.0
    min_kl: float = 0.0
    std_kl: float = 0.0
    current_coeff: float = 0.1
    adaptation_count: int = 0
    samples_processed: int = 0
    
    def to_dict(self) -> Dict:
        return {
            "kl/mean": round(self.mean_kl, 4),
            "kl/max": round(self.max_kl, 4),
            "kl/min": round(self.min_kl, 4),
            "kl/std": round(self.std_kl, 4),
            "kl/coeff": round(self.current_coeff, 4),
            "kl/adaptation_count": self.adaptation_count,
            "kl/samples_processed": self.samples_processed,
        }


# =============================================================================
# KL Controller (CPU-based approximation)
# =============================================================================


class KLControllerBase:
    """
    Base KL controller that works without GPU/torch.
    
    Uses log-probability approximations when actual model isn't available.
    """
    
    def __init__(self, config: KLConfig):
        self.config = config
        self.kl_coeff = config.kl_coeff
        
        self._kl_history: List[float] = []
        self._adaptation_count = 0
        self._samples_processed = 0
    
    def compute_kl_from_logprobs(
        self,
        policy_logprobs: List[float],
        reference_logprobs: List[float],
    ) -> float:
        """
        Compute KL divergence from pre-computed logprobs.
        
        KL(policy || reference) = sum(policy_logprob - reference_logprob)
        
        Args:
            policy_logprobs: Log probabilities from current policy
            reference_logprobs: Log probabilities from reference model
        
        Returns:
            KL divergence value
        """
        if len(policy_logprobs) != len(reference_logprobs):
            raise ValueError("Logprob lists must have same length")
        
        if not policy_logprobs:
            return 0.0
        
        kl = sum(p - r for p, r in zip(policy_logprobs, reference_logprobs))
        
        # Normalize by sequence length
        kl /= len(policy_logprobs)
        
        return max(0.0, kl)  # KL should be non-negative
    
    def get_penalty_from_logprobs(
        self,
        policy_logprobs: List[float],
        reference_logprobs: List[float],
    ) -> Tuple[float, float]:
        """
        Compute KL penalty from pre-computed logprobs.
        
        Returns:
            (penalty, mean_kl)
        """
        kl = self.compute_kl_from_logprobs(policy_logprobs, reference_logprobs)
        
        self._kl_history.append(kl)
        self._samples_processed += 1
        
        self._maybe_adapt(kl)
        
        penalty = self.kl_coeff * kl
        return penalty, kl
    
    def get_batch_penalty_from_logprobs(
        self,
        policy_logprobs_batch: List[List[float]],
        reference_logprobs_batch: List[List[float]],
    ) -> Tuple[List[float], KLStats]:
        """
        Compute KL penalties for a batch of samples.
        
        Returns:
            (list of penalties, statistics)
        """
        penalties = []
        kls = []
        
        for policy_lp, ref_lp in zip(policy_logprobs_batch, reference_logprobs_batch):
            kl = self.compute_kl_from_logprobs(policy_lp, ref_lp)
            kls.append(kl)
            penalties.append(self.kl_coeff * kl)
        
        self._kl_history.extend(kls)
        self._samples_processed += len(kls)
        
        if kls:
            mean_kl = sum(kls) / len(kls)
            self._maybe_adapt(mean_kl)
        else:
            mean_kl = 0.0
        
        stats = self._compute_stats(kls)
        return penalties, stats
    
    def _maybe_adapt(self, current_kl: float) -> None:
        """Adaptively adjust KL coefficient if enabled"""
        if not self.config.adaptive:
            return
        
        if len(self._kl_history) < self.config.adaptation_window:
            return
        
        recent = self._kl_history[-self.config.adaptation_window:]
        avg_kl = sum(recent) / len(recent)
        
        old_coeff = self.kl_coeff
        
        if avg_kl > self.config.kl_target * 1.5:
            # KL too high, increase penalty
            self.kl_coeff *= self.config.increase_factor
        elif avg_kl < self.config.kl_target * 0.5:
            # KL too low, decrease penalty
            self.kl_coeff *= self.config.decrease_factor
        
        # Clamp to bounds
        self.kl_coeff = max(
            self.config.kl_coeff_min,
            min(self.config.kl_coeff_max, self.kl_coeff),
        )
        
        if old_coeff != self.kl_coeff:
            self._adaptation_count += 1
            logger.debug(
                f"KL coefficient adapted: {old_coeff:.4f} -> {self.kl_coeff:.4f} "
                f"(avg_kl={avg_kl:.4f}, target={self.config.kl_target})"
            )
    
    def _compute_stats(self, kls: List[float]) -> KLStats:
        """Compute statistics from KL values"""
        if not kls:
            return KLStats(current_coeff=self.kl_coeff)
        
        mean_kl = sum(kls) / len(kls)
        max_kl = max(kls)
        min_kl = min(kls)
        
        if len(kls) > 1:
            variance = sum((k - mean_kl) ** 2 for k in kls) / len(kls)
            std_kl = variance ** 0.5
        else:
            std_kl = 0.0
        
        return KLStats(
            mean_kl=mean_kl,
            max_kl=max_kl,
            min_kl=min_kl,
            std_kl=std_kl,
            current_coeff=self.kl_coeff,
            adaptation_count=self._adaptation_count,
            samples_processed=self._samples_processed,
        )
    
    def get_stats(self) -> KLStats:
        """Get current statistics"""
        recent = self._kl_history[-100:] if self._kl_history else []
        return self._compute_stats(recent)
    
    def reset_history(self) -> None:
        """Reset KL history (e.g., at checkpoint)"""
        self._kl_history = []
    
    def save_state(self) -> Dict:
        """Save controller state for checkpointing"""
        return {
            "kl_coeff": self.kl_coeff,
            "adaptation_count": self._adaptation_count,
            "samples_processed": self._samples_processed,
            "recent_history": self._kl_history[-100:],
        }
    
    def load_state(self, state: Dict) -> None:
        """Load controller state from checkpoint"""
        self.kl_coeff = state.get("kl_coeff", self.config.kl_coeff)
        self._adaptation_count = state.get("adaptation_count", 0)
        self._samples_processed = state.get("samples_processed", 0)
        self._kl_history = state.get("recent_history", [])


# =============================================================================
# GPU-based KL Controller (with actual model)
# =============================================================================


if TORCH_AVAILABLE:
    class KLController(KLControllerBase):
        """
        Full KL controller with reference model.
        
        Computes exact KL divergence using a frozen reference model.
        Requires GPU and transformers library.
        """
        
        def __init__(
            self,
            config: KLConfig,
            load_model: bool = True,
        ):
            super().__init__(config)
            
            self.ref_model = None
            self.tokenizer = None
            
            if load_model:
                self._load_reference_model()
        
        def _load_reference_model(self) -> None:
            """Load the frozen reference model"""
            logger.info(f"Loading reference model: {self.config.reference_model_name}")
            
            dtype = torch.bfloat16 if self.config.use_bf16 else torch.float32
            
            self.ref_model = AutoModelForCausalLM.from_pretrained(
                self.config.reference_model_name,
                torch_dtype=dtype,
                device_map=self.config.device,
                trust_remote_code=True,
            )
            
            # Freeze the model
            self.ref_model.eval()
            for param in self.ref_model.parameters():
                param.requires_grad = False
            
            self.tokenizer = AutoTokenizer.from_pretrained(
                self.config.reference_model_name,
                trust_remote_code=True,
            )
            
            logger.info("Reference model loaded and frozen")
        
        def compute_kl(
            self,
            policy_logprobs: torch.Tensor,
            tokens: torch.Tensor,
            attention_mask: torch.Tensor,
        ) -> torch.Tensor:
            """
            Compute KL divergence from reference model.
            
            Args:
                policy_logprobs: [batch, seq_len] log probs from policy
                tokens: [batch, seq_len] input token IDs
                attention_mask: [batch, seq_len] attention mask
            
            Returns:
                [batch] tensor of KL divergences
            """
            if self.ref_model is None:
                raise RuntimeError("Reference model not loaded")
            
            with torch.no_grad():
                ref_outputs = self.ref_model(
                    input_ids=tokens,
                    attention_mask=attention_mask,
                )
                ref_logits = ref_outputs.logits
            
            # Get reference log probabilities
            ref_logprobs = F.log_softmax(ref_logits, dim=-1)
            
            # Gather logprobs for actual tokens
            # Shift by 1 for next-token prediction
            token_indices = tokens[:, 1:].unsqueeze(-1)
            ref_token_logprobs = ref_logprobs[:, :-1].gather(-1, token_indices).squeeze(-1)
            policy_token_logprobs = policy_logprobs[:, :-1]
            
            # KL divergence: policy_logprob - ref_logprob
            kl = policy_token_logprobs - ref_token_logprobs
            
            # Mean over non-padded tokens
            mask = attention_mask[:, 1:].float()
            kl_per_sample = (kl * mask).sum(dim=-1) / mask.sum(dim=-1).clamp(min=1.0)
            
            return kl_per_sample
        
        def get_penalty(
            self,
            policy_logprobs: torch.Tensor,
            tokens: torch.Tensor,
            attention_mask: torch.Tensor,
        ) -> Tuple[torch.Tensor, float]:
            """
            Compute KL penalty for reward modification.
            
            Args:
                policy_logprobs: Log probs from policy model
                tokens: Input token IDs
                attention_mask: Attention mask
            
            Returns:
                (penalty tensor, mean KL for logging)
            """
            kl = self.compute_kl(policy_logprobs, tokens, attention_mask)
            mean_kl = kl.mean().item()
            
            self._kl_history.append(mean_kl)
            self._samples_processed += kl.shape[0]
            
            self._maybe_adapt(mean_kl)
            
            penalty = self.kl_coeff * kl
            return penalty, mean_kl
        
        def get_batch_penalty(
            self,
            policy_logprobs: torch.Tensor,
            tokens: torch.Tensor,
            attention_mask: torch.Tensor,
        ) -> Tuple[torch.Tensor, KLStats]:
            """
            Compute KL penalties for a batch with statistics.
            
            Returns:
                (penalty tensor, statistics)
            """
            kl = self.compute_kl(policy_logprobs, tokens, attention_mask)
            
            kl_list = kl.tolist()
            self._kl_history.extend(kl_list)
            self._samples_processed += len(kl_list)
            
            mean_kl = sum(kl_list) / len(kl_list) if kl_list else 0.0
            self._maybe_adapt(mean_kl)
            
            penalty = self.kl_coeff * kl
            stats = self._compute_stats(kl_list)
            
            return penalty, stats
        
        def compute_reference_logprobs(
            self,
            tokens: torch.Tensor,
            attention_mask: torch.Tensor,
        ) -> torch.Tensor:
            """
            Compute reference model log probabilities.
            
            Useful for caching reference logprobs.
            
            Returns:
                [batch, seq_len] tensor of log probabilities
            """
            if self.ref_model is None:
                raise RuntimeError("Reference model not loaded")
            
            with torch.no_grad():
                ref_outputs = self.ref_model(
                    input_ids=tokens,
                    attention_mask=attention_mask,
                )
                ref_logits = ref_outputs.logits
            
            # Get log probabilities
            ref_logprobs = F.log_softmax(ref_logits, dim=-1)
            
            # Gather logprobs for actual tokens
            token_indices = tokens[:, 1:].unsqueeze(-1)
            ref_token_logprobs = ref_logprobs[:, :-1].gather(-1, token_indices).squeeze(-1)
            
            # Pad to match original sequence length
            padding = torch.zeros(
                tokens.shape[0], 1,
                dtype=ref_token_logprobs.dtype,
                device=ref_token_logprobs.device,
            )
            
            return torch.cat([padding, ref_token_logprobs], dim=1)
else:
    # Fallback when torch is not available
    KLController = KLControllerBase


# =============================================================================
# Factory Function
# =============================================================================


def create_kl_controller(
    reference_model_name: str,
    kl_coeff: float = 0.1,
    kl_target: float = 3.0,
    adaptive: bool = True,
    load_model: bool = True,
) -> KLControllerBase:
    """
    Create a KL controller with appropriate implementation.
    
    Uses GPU-based controller if torch is available, otherwise
    falls back to logprob-based approximation.
    
    Args:
        reference_model_name: Name of reference model
        kl_coeff: Initial KL coefficient
        kl_target: Target KL for adaptation
        adaptive: Enable adaptive coefficient
        load_model: Whether to load the reference model (GPU only)
    
    Returns:
        KL controller instance
    """
    config = KLConfig(
        reference_model_name=reference_model_name,
        kl_coeff=kl_coeff,
        kl_target=kl_target,
        adaptive=adaptive,
    )
    
    if TORCH_AVAILABLE and load_model:
        return KLController(config, load_model=True)
    else:
        logger.warning(
            "Using CPU-based KL controller (torch not available or load_model=False). "
            "This requires pre-computed reference logprobs."
        )
        return KLControllerBase(config)


# =============================================================================
# Utility Functions
# =============================================================================


def compute_kl_divergence(
    policy_probs: List[float],
    reference_probs: List[float],
) -> float:
    """
    Compute KL divergence between probability distributions.
    
    KL(P || Q) = sum(P * log(P/Q))
    
    Args:
        policy_probs: Policy probability distribution
        reference_probs: Reference probability distribution
    
    Returns:
        KL divergence value
    """
    import math
    
    if len(policy_probs) != len(reference_probs):
        raise ValueError("Distributions must have same length")
    
    kl = 0.0
    for p, q in zip(policy_probs, reference_probs):
        if p > 0 and q > 0:
            kl += p * math.log(p / q)
    
    return max(0.0, kl)


def estimate_kl_from_samples(
    policy_samples: List[str],
    reference_samples: List[str],
    tokenizer,
) -> float:
    """
    Estimate KL divergence from response samples.
    
    Uses token frequency as a proxy for distribution.
    This is a rough approximation useful for debugging.
    
    Args:
        policy_samples: Responses from policy model
        reference_samples: Responses from reference model
        tokenizer: Tokenizer for tokenization
    
    Returns:
        Estimated KL divergence
    """
    from collections import Counter
    
    # Tokenize samples
    policy_tokens = []
    for s in policy_samples:
        policy_tokens.extend(tokenizer.encode(s))
    
    reference_tokens = []
    for s in reference_samples:
        reference_tokens.extend(tokenizer.encode(s))
    
    # Count frequencies
    policy_counts = Counter(policy_tokens)
    reference_counts = Counter(reference_tokens)
    
    # Normalize to distributions
    policy_total = sum(policy_counts.values())
    reference_total = sum(reference_counts.values())
    
    # Get union of tokens
    all_tokens = set(policy_counts.keys()) | set(reference_counts.keys())
    
    # Compute KL with smoothing
    smoothing = 0.0001
    kl = 0.0
    
    for token in all_tokens:
        p = (policy_counts.get(token, 0) + smoothing) / (policy_total + smoothing * len(all_tokens))
        q = (reference_counts.get(token, 0) + smoothing) / (reference_total + smoothing * len(all_tokens))
        
        import math
        kl += p * math.log(p / q)
    
    return max(0.0, kl)

