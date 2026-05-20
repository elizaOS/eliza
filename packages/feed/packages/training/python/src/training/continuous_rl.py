"""
Continuous Reinforcement Learning Agent for Feed

DEPRECATED: Use shared_model_rl.py instead. This module is kept for backwards
compatibility. The SharedModelTrainer in shared_model_rl.py replaces both this
module and team_rl.py with a single shared model approach.

Each ContinuousRLAgent wraps a single model and optimizer, connects to a shared
Feed game via SimulationBridge, and continuously learns from interactions.

The training loop:
  1. Forward pass: generate action for current game state (TurboQuant KV cache)
  2. Execute action in the shared game, receive reward
  3. Compute delight = advantage × surprisal
  4. Kondo gate: skip backward pass if delight is low
  5. If selected: APOLLO optimizer full-param update
  6. Repeat

This is the "online" counterpart to the offline GRPO pipeline.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
from dataclasses import dataclass
from typing import Any

import torch
import torch.nn.functional as F
from transformers import AutoModelForCausalLM, AutoTokenizer

from .simulation_bridge import ActionOutcome, Scenario, SimulationBridge
from .turboquant import TurboQuantSettings, build_generation_cache

logger = logging.getLogger(__name__)

# ─── Module names that benefit from APOLLO low-rank projection ──────────────

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


# ─── Configuration ──────────────────────────────────────────────────────────


@dataclass
class ContinuousRLConfig:
    """Configuration for a single continuous RL agent."""

    # Model
    model_name: str = "Qwen/Qwen3.5-4B"
    device: str = "cuda"

    # Optimizer
    optimizer: str = "apollo"  # "adamw" or "apollo"
    learning_rate: float = 5e-6
    weight_decay: float = 0.0
    apollo_rank: int = 128
    apollo_scale: float = 32.0
    apollo_update_proj_gap: int = 200
    max_grad_norm: float = 1.0

    # Kondo gate
    use_kondo: bool = True
    kondo_gate_rate: float = 0.03  # Only 3% of interactions trigger backward
    kondo_price: float | None = None
    kondo_temperature: float = 0.1
    kondo_hard: bool = True
    kondo_deterministic: bool = True

    # TurboQuant KV cache
    use_turboquant: bool = True
    turboquant_key_bits: float = 3.5
    turboquant_value_bits: float = 3.5
    turboquant_residual_length: int = 128

    # Reward
    reward_baseline: str = "running_mean"  # "running_mean" or "zero"
    reward_ema_alpha: float = 0.01

    # Generation
    max_new_tokens: int = 256
    temperature: float = 0.7
    top_p: float = 0.9

    # Checkpointing
    checkpoint_dir: str = "./continuous_rl_checkpoints"
    checkpoint_every: int = 100  # Save every N interactions
    keep_checkpoints: int = 3

    # Game connection
    bridge_url: str = "http://localhost:3001"
    agent_archetype: str = "trader"


# ─── Reward Tracker ─────────────────────────────────────────────────────────


class RewardTracker:
    """Track running reward statistics for advantage computation."""

    def __init__(self, ema_alpha: float = 0.01):
        self.ema_alpha = ema_alpha
        self.mean: float = 0.0
        self.var: float = 1.0
        self.count: int = 0

    def update(self, reward: float) -> float:
        """Update tracker and return advantage (reward - baseline)."""
        self.count += 1
        if self.count == 1:
            self.mean = reward
            return 0.0
        delta = reward - self.mean
        self.mean += self.ema_alpha * delta
        self.var = (1 - self.ema_alpha) * self.var + self.ema_alpha * delta * delta
        std = max(self.var**0.5, 1e-8)
        return delta / std


# ─── Continuous RL Agent ─────────────────────────────────────────────────────


class ContinuousRLAgent:
    """
    A single agent with its own model that learns continuously from a shared
    Feed game. Wraps: model + optimizer + Kondo gate + TurboQuant cache.
    """

    def __init__(self, agent_id: str, config: ContinuousRLConfig):
        self.agent_id = agent_id
        self.config = config
        self.model: AutoModelForCausalLM | None = None
        self.tokenizer: AutoTokenizer | None = None
        self.optimizer: torch.optim.Optimizer | None = None
        self.kondo_gate = None
        self.turboquant_settings: TurboQuantSettings | None = None
        self.reward_tracker = RewardTracker(ema_alpha=config.reward_ema_alpha)

        # Metrics
        self.total_interactions: int = 0
        self.total_backward_passes: int = 0
        self.total_backward_skipped: int = 0
        self.cumulative_reward: float = 0.0
        self.cumulative_delight: float = 0.0
        self._checkpoint_history: list[str] = []

    def setup(self) -> None:
        """Initialize model, tokenizer, then optimizer/gate/cache."""
        logger.info(f"[{self.agent_id}] Loading model: {self.config.model_name}")

        self.tokenizer = AutoTokenizer.from_pretrained(
            self.config.model_name,
            trust_remote_code=True,
        )
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token

        self.model = AutoModelForCausalLM.from_pretrained(
            self.config.model_name,
            torch_dtype=torch.bfloat16,
            trust_remote_code=True,
        ).to(self.config.device)
        self.model.gradient_checkpointing_enable()
        self.model.train()

        self._setup_training_components()

    def _setup_training_components(self) -> None:
        """Initialize optimizer, Kondo gate, and TurboQuant on the current model.

        Called by both setup() (fresh init) and load_checkpoint() (after loading
        model weights from disk) to avoid redundant model reloads.
        """
        assert self.model is not None, "model must be loaded before _setup_training_components"

        # Optimizer
        if self.config.optimizer == "apollo":
            try:
                from apollo_torch import APOLLOAdamW
            except ImportError as exc:
                raise ImportError(
                    "apollo_torch required for optimizer='apollo'. pip install apollo-torch"
                ) from exc
            lowrank, regular = [], []
            for name, param in self.model.named_parameters():
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
                        "rank": self.config.apollo_rank,
                        "proj": "random",
                        "scale_type": "channel",
                        "scale": self.config.apollo_scale,
                        "update_proj_gap": self.config.apollo_update_proj_gap,
                        "proj_type": "std",
                    }
                )
            self.optimizer = APOLLOAdamW(
                groups,
                lr=self.config.learning_rate,
                weight_decay=self.config.weight_decay,
            )
            logger.info(
                f"[{self.agent_id}] APOLLO: {len(lowrank)} low-rank, {len(regular)} regular params"
            )
        else:
            self.optimizer = torch.optim.AdamW(
                self.model.parameters(),
                lr=self.config.learning_rate,
                weight_decay=self.config.weight_decay,
            )

        # Kondo gate
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
                logger.info(f"[{self.agent_id}] Kondo gate: rate={self.config.kondo_gate_rate}")
            except ImportError:
                logger.warning(f"[{self.agent_id}] kondo-gate not installed, disabling")

        # TurboQuant
        if self.config.use_turboquant:
            self.turboquant_settings = TurboQuantSettings(
                key_bits=self.config.turboquant_key_bits,
                value_bits=self.config.turboquant_value_bits,
                residual_length=self.config.turboquant_residual_length,
            )
            logger.info(
                f"[{self.agent_id}] TurboQuant KV: K={self.config.turboquant_key_bits}b, "
                f"V={self.config.turboquant_value_bits}b"
            )

        logger.info(f"[{self.agent_id}] Ready on {self.config.device}")

    # ── Generation ──────────────────────────────────────────────────────────

    def _build_prompt(self, scenario: Scenario) -> str:
        """Build chat-template prompt from scenario context."""
        system_msg = (
            f"You are a {self.config.agent_archetype} agent in Feed prediction markets. "
            "Respond with <think>...</think> reasoning then a JSON action."
        )
        messages = [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": scenario.to_prompt_context()},
        ]
        return self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )

    @torch.no_grad()
    def generate_action(self, scenario: Scenario) -> tuple[str, torch.Tensor, torch.Tensor]:
        """
        Generate an action response for the given scenario.

        Returns:
            (response_text, input_ids, output_ids) - text and tensors for training.
        """
        prompt = self._build_prompt(scenario)
        enc = self.tokenizer(
            prompt,
            return_tensors="pt",
            truncation=True,
            max_length=2048,
        ).to(self.config.device)

        # Build TurboQuant cache if enabled
        past_kv = None
        if self.turboquant_settings is not None and self.model is not None:
            past_kv = build_generation_cache(
                self.model.config,
                cache_implementation="turboquant",
                turboquant_settings=self.turboquant_settings,
            )

        generate_kwargs: dict[str, Any] = {
            "max_new_tokens": self.config.max_new_tokens,
            "temperature": self.config.temperature,
            "top_p": self.config.top_p,
            "do_sample": True,
            "pad_token_id": self.tokenizer.pad_token_id,
        }
        if past_kv is not None:
            generate_kwargs["past_key_values"] = past_kv

        # Must switch to eval for generation — gradient checkpointing
        # corrupts KV cache and produces garbled output in train mode.
        self.model.eval()
        output_ids = self.model.generate(enc["input_ids"], **generate_kwargs)
        self.model.train()
        prompt_len = enc["input_ids"].shape[1]
        response_ids = output_ids[0, prompt_len:]
        response_text = self.tokenizer.decode(response_ids, skip_special_tokens=True)

        return response_text, enc["input_ids"], output_ids

    def parse_action(self, response: str) -> dict[str, Any] | None:
        """Extract JSON action from model response."""
        # Strip think tags
        text = response
        if "</think>" in text:
            text = text.split("</think>")[-1].strip()
        match = re.search(r"\{[^{}]*\}", text)
        if match:
            try:
                action = json.loads(match.group())
                if "action" in action:
                    return action
            except json.JSONDecodeError:
                pass
        return None

    # ── Training step ───────────────────────────────────────────────────────

    def train_on_interaction(
        self,
        input_ids: torch.Tensor,
        output_ids: torch.Tensor,
        reward: float,
    ) -> dict[str, Any]:
        """
        Perform one online RL update on a single interaction.

        1. Compute advantage = (reward - baseline) via running mean.
        2. Forward pass to get log-probs of the generated response.
        3. Compute delight = advantage × surprisal.
        4. Kondo gate: if delight is below threshold, skip backward.
        5. Otherwise: compute REINFORCE loss, backward, optimizer step.

        Returns metrics dict.
        """
        assert self.model is not None
        assert self.optimizer is not None

        self.total_interactions += 1
        self.cumulative_reward += reward
        advantage = self.reward_tracker.update(reward)

        # Forward pass to get log-probs of the generated tokens
        prompt_len = input_ids.shape[1]
        full_ids = output_ids.to(self.config.device)
        targets = full_ids[0, prompt_len:].clone()
        n_response_tokens = targets.shape[0]

        if n_response_tokens < 1:
            return {"skipped": True, "reason": "no_response_tokens"}

        self.model.train()
        outputs = self.model(full_ids[:, :-1])
        logits = outputs.logits[0, prompt_len - 1 :, :]  # logits for response positions
        logits = logits[:n_response_tokens]

        log_probs = F.log_softmax(logits, dim=-1)
        token_log_probs = log_probs.gather(1, targets.unsqueeze(1)).squeeze(1)
        mean_log_prob = token_log_probs.mean()
        surprisal = -mean_log_prob.detach()

        # Delight = advantage × surprisal
        delight = float(advantage * surprisal.item())
        self.cumulative_delight += abs(delight)

        metrics: dict[str, Any] = {
            "reward": reward,
            "advantage": advantage,
            "surprisal": float(surprisal.item()),
            "delight": delight,
            "backward": False,
            "loss": 0.0,
        }

        # ── Kondo gate decision ──────────────────────────────────────────
        if self.kondo_gate is not None:
            adv_t = torch.tensor([advantage], device=self.config.device)
            lp_t = torch.tensor([mean_log_prob.item()], device=self.config.device)
            gate_out = self.kondo_gate.compute_gate(lp_t, adv_t)
            metrics["kondo_gate_prob"] = float(gate_out.gate_probs[0].item())

            if self.config.kondo_hard:
                if gate_out.gate_weights[0].item() < 0.5:
                    # Skip backward pass — this interaction wasn't "delightful" enough
                    self.total_backward_skipped += 1
                    metrics["skipped"] = True
                    metrics["reason"] = "kondo_gated"
                    return metrics

        # ── Backward pass (only reached if Kondo gate passes) ────────────
        self.total_backward_passes += 1
        metrics["backward"] = True

        # REINFORCE-style policy gradient loss
        # loss = -advantage * mean_log_prob
        loss = -advantage * mean_log_prob
        loss.backward()

        grad_norm = torch.nn.utils.clip_grad_norm_(
            self.model.parameters(),
            max_norm=self.config.max_grad_norm,
        )
        self.optimizer.step()
        self.optimizer.zero_grad()

        metrics["loss"] = float(loss.item())
        metrics["grad_norm"] = float(grad_norm.item())

        return metrics

    # ── Checkpointing ───────────────────────────────────────────────────────

    def save_checkpoint(self, tag: str | None = None) -> str:
        """Save model + optimizer state."""
        assert self.model is not None and self.tokenizer is not None
        name = tag or f"step_{self.total_interactions}"
        path = os.path.join(self.config.checkpoint_dir, self.agent_id, name)
        os.makedirs(path, exist_ok=True)

        self.model.save_pretrained(path)
        self.tokenizer.save_pretrained(path)

        state = {
            "optimizer": self.optimizer.state_dict(),
            "total_interactions": self.total_interactions,
            "total_backward_passes": self.total_backward_passes,
            "total_backward_skipped": self.total_backward_skipped,
            "cumulative_reward": self.cumulative_reward,
            "cumulative_delight": self.cumulative_delight,
            "reward_tracker_mean": self.reward_tracker.mean,
            "reward_tracker_var": self.reward_tracker.var,
            "reward_tracker_count": self.reward_tracker.count,
        }
        torch.save(state, os.path.join(path, "training_state.pt"))
        logger.info(f"[{self.agent_id}] Checkpoint saved: {path}")

        self._checkpoint_history.append(path)
        while len(self._checkpoint_history) > self.config.keep_checkpoints:
            old = self._checkpoint_history.pop(0)
            if os.path.exists(old):
                shutil.rmtree(old)

        return path

    def load_checkpoint(self, path: str) -> None:
        """Load model + optimizer state from checkpoint."""
        logger.info(f"[{self.agent_id}] Loading checkpoint: {path}")

        self.model = AutoModelForCausalLM.from_pretrained(
            path,
            torch_dtype=torch.bfloat16,
            trust_remote_code=True,
        ).to(self.config.device)
        self.model.gradient_checkpointing_enable()
        self.model.train()
        self.tokenizer = AutoTokenizer.from_pretrained(path, trust_remote_code=True)
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token

        # Re-create optimizer, Kondo gate, and TurboQuant on the loaded model
        # (does NOT reload the model — only builds the training components)
        self._setup_training_components()

        state_path = os.path.join(path, "training_state.pt")
        if os.path.exists(state_path):
            state = torch.load(state_path, map_location=self.config.device)
            self.optimizer.load_state_dict(state["optimizer"])
            self.total_interactions = state.get("total_interactions", 0)
            self.total_backward_passes = state.get("total_backward_passes", 0)
            self.total_backward_skipped = state.get("total_backward_skipped", 0)
            self.cumulative_reward = state.get("cumulative_reward", 0.0)
            self.cumulative_delight = state.get("cumulative_delight", 0.0)
            self.reward_tracker.mean = state.get("reward_tracker_mean", 0.0)
            self.reward_tracker.var = state.get("reward_tracker_var", 1.0)
            self.reward_tracker.count = state.get("reward_tracker_count", 0)

    def get_stats(self) -> dict[str, Any]:
        """Return current agent statistics."""
        backward_total = self.total_backward_passes + self.total_backward_skipped
        return {
            "agent_id": self.agent_id,
            "total_interactions": self.total_interactions,
            "total_backward_passes": self.total_backward_passes,
            "total_backward_skipped": self.total_backward_skipped,
            "backward_rate": (
                self.total_backward_passes / backward_total if backward_total > 0 else 0.0
            ),
            "cumulative_reward": self.cumulative_reward,
            "mean_reward": (
                self.cumulative_reward / self.total_interactions
                if self.total_interactions > 0
                else 0.0
            ),
            "cumulative_delight": self.cumulative_delight,
            "reward_baseline": self.reward_tracker.mean,
        }


# ─── Online Training Loop ───────────────────────────────────────────────────


async def run_online_training(
    agent: ContinuousRLAgent,
    bridge: SimulationBridge,
    npc_id: str,
    max_ticks: int = 0,
    log_every: int = 10,
) -> dict[str, Any]:
    """
    Run the online continuous RL training loop for a single agent.

    Args:
        agent: The ContinuousRLAgent (already setup'd).
        bridge: A connected SimulationBridge.
        npc_id: The NPC ID this agent controls in the game.
        max_ticks: Maximum ticks to run (0 = unlimited).
        log_every: Log stats every N interactions.

    Returns:
        Final statistics dict.
    """
    tick = 0
    consecutive_errors = 0
    max_consecutive_errors = 10
    logger.info(f"[{agent.agent_id}] Starting online training as NPC {npc_id}")

    while max_ticks == 0 or tick < max_ticks:
        tick += 1

        try:
            # 1. Get current game state for this NPC
            scenario = await bridge.get_scenario(npc_id)

            # 2. Generate action (forward pass with TurboQuant KV cache)
            response_text, input_ids, output_ids = agent.generate_action(scenario)

            # 3. Parse and execute action in the game
            action = agent.parse_action(response_text)
            if action is None:
                action = {"action": "wait", "reason": "failed to parse"}

            outcome = await bridge.execute_action(
                npc_id=npc_id,
                action_type=action.get("action", "wait"),
                ticker=action.get("ticker"),
                market_id=action.get("market"),
                amount=action.get("amount"),
                side=action.get("side") or action.get("direction"),
                reasoning=action.get("reason"),
            )

            # 4. Compute reward from outcome
            reward = _compute_reward(action, outcome, scenario)

            # 5. Train on this interaction (Kondo gate decides backward pass)
            metrics = agent.train_on_interaction(input_ids, output_ids, reward)

            # 6. Periodic logging
            if agent.total_interactions % log_every == 0:
                stats = agent.get_stats()
                logger.info(
                    f"[{agent.agent_id}] tick={tick} interactions={stats['total_interactions']} "
                    f"reward={stats['mean_reward']:.4f} backward_rate={stats['backward_rate']:.3f} "
                    f"delight={metrics.get('delight', 0):.4f}"
                )

            # 7. Periodic checkpointing
            if (
                agent.config.checkpoint_every > 0
                and agent.total_interactions % agent.config.checkpoint_every == 0
            ):
                agent.save_checkpoint()

        except (asyncio.TimeoutError, OSError, RuntimeError) as e:
            consecutive_errors += 1
            logger.warning(
                f"[{agent.agent_id}] tick={tick} recoverable error "
                f"({consecutive_errors}/{max_consecutive_errors}): {e}"
            )
            if consecutive_errors >= max_consecutive_errors:
                logger.error(f"[{agent.agent_id}] too many consecutive errors, stopping")
                break
            await asyncio.sleep(min(consecutive_errors, 5))
            continue
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as e:
            logger.error(f"[{agent.agent_id}] tick={tick} fatal error: {e}", exc_info=True)
            raise
        else:
            consecutive_errors = 0  # Reset on success

    # Final checkpoint
    agent.save_checkpoint(tag="final")
    return agent.get_stats()


def _compute_reward(
    action: dict[str, Any],
    outcome: ActionOutcome,
    scenario: Scenario,
) -> float:
    """
    Compute reward from an action outcome.

    Composite reward:
      - PnL component (realized profit/loss from trades)
      - Format component (valid action structure)
      - Social component (social impact from interactions)
    """
    reward = 0.0

    # PnL reward (normalized to [-1, 1] range)
    if outcome.success:
        pnl_reward = max(-1.0, min(1.0, outcome.pnl / max(scenario.balance, 1.0)))
        reward += 0.5 * pnl_reward

    # Format reward: valid action that executed
    if outcome.success:
        reward += 0.2
    elif outcome.error:
        reward -= 0.1

    # Activity reward: non-wait actions that succeeded
    if action.get("action") != "wait" and outcome.success:
        reward += 0.1

    # Social impact reward
    social = outcome.social_impact
    if social:
        social_score = (
            social.get("likes_received", 0) * 0.02
            + social.get("replies_received", 0) * 0.03
            + social.get("reputation_delta", 0) * 0.1
        )
        reward += min(0.2, social_score)

    return reward
