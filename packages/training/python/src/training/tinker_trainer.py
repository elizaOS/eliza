"""
Tinker Trainer

Lightweight GRPO trainer using Tinker API.
Replaces heavy local vLLM + PyTorch training with cloud-based training.

This trainer:
1. Uses TinkerClient for training and inference
2. Integrates with RLAIFEnv for trajectory collection
3. Implements GRPO/IS training loop
4. Handles weight synchronization

Benefits over local training:
- No local GPU required
- Access to larger models (Qwen3-235B)
- Faster weight sync (no vLLM restarts)
- Better on-policy training with low staleness
- Pay only for training time, not idle GPU

Based on: tinker-atropos integration (Nous Research)
"""

import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import List

import numpy as np
from dotenv import load_dotenv
from pydantic import BaseModel, Field

from .tinker_client import (
    TinkerClient,
    TinkerConfig,
    TinkerDatum,
    TINKER_AVAILABLE,
)

logger = logging.getLogger(__name__)

# Load environment variables
project_root = Path(__file__).parent.parent.parent.parent
env_path = project_root / ".env"
env_local_path = project_root / ".env.local"

if env_local_path.exists():
    load_dotenv(env_local_path, override=True)
if env_path.exists():
    load_dotenv(env_path, override=False)


class TinkerTrainingConfig(BaseModel):
    """Configuration for Tinker-based training"""

    # Model settings
    base_model: str = Field(
        default="Qwen/Qwen3-30B-A3B-Instruct",
        description="Base model from Tinker's supported models",
    )
    lora_rank: int = Field(default=32, description="LoRA rank for fine-tuning")

    # Training hyperparameters
    learning_rate: float = Field(default=4e-5, description="Learning rate")
    training_steps: int = Field(default=100, description="Number of training steps")
    group_size: int = Field(default=4, description="Group size for GRPO comparison")

    # Weight sync settings
    weight_sync_interval: int = Field(
        default=5, description="Sync weights to sampler every N steps"
    )

    # Environment settings
    database_url: str = Field(
        default_factory=lambda: os.getenv("DATABASE_URL", ""),
        description="PostgreSQL connection URL",
    )
    lookback_hours: int = Field(
        default=72, description="Hours to look back for trajectories"
    )
    min_agents_per_window: int = Field(
        default=2, description="Minimum agents per window"
    )
    min_actions_per_trajectory: int = Field(
        default=3, description="Minimum actions per trajectory"
    )
    max_steps_per_trajectory: int = Field(
        default=20, description="Max steps to include per trajectory"
    )
    max_token_length: int = Field(default=4096, description="Maximum sequence length")

    # RLAIF Judge settings
    judge_model: str = Field(default="gpt-4o-mini", description="Model for RLAIF judge")
    judge_temperature: float = Field(default=0.3, description="Judge temperature")

    # Logging settings
    log_to_file: bool = Field(default=True, description="Log metrics to file")
    log_file: str = Field(
        default="./logs/tinker_training_metrics.jsonl", description="Metrics log file"
    )

    # Inference settings
    inference_max_tokens: int = Field(
        default=512, description="Max tokens for inference"
    )
    inference_temperature: float = Field(
        default=0.7, description="Temperature for inference"
    )


@dataclass
class TrainingMetrics:
    """Metrics from training"""

    step: int
    loss: float
    num_samples: int
    logprobs_mean: float = 0.0
    pos_advantage_mean: float = 0.0
    neg_advantage_mean: float = 0.0
    avg_score: float = 0.0
    windows_processed: int = 0
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class TinkerTrainer:
    """
    GRPO Trainer using Tinker API.

    This replaces local heavyweight trainer flows with a lighter implementation:
    - No local vLLM management
    - No GPU requirements on training machine
    - Training happens in Tinker cloud
    - Only data loading runs locally

    The training loop:
    1. Load trajectory groups from database
    2. Score trajectories using LLM judge (RLAIF)
    3. Convert to training format
    4. Call Tinker for forward_backward + optim_step
    5. Periodically sync weights to sampling client
    """

    def __init__(self, config: TinkerTrainingConfig):
        if not TINKER_AVAILABLE:
            raise RuntimeError(
                "Tinker not installed. Install with: pip install tinker"
            )

        self.config = config
        self.tinker_config = TinkerConfig(
            base_model=config.base_model,
            lora_rank=config.lora_rank,
            learning_rate=config.learning_rate,
            default_max_tokens=config.inference_max_tokens,
            default_temperature=config.inference_temperature,
        )
        self.tinker_client = TinkerClient(self.tinker_config)

        self.current_step = 0
        self.run_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        self.all_metrics: List[TrainingMetrics] = []

        # Database pool (lazy init)
        self._db_pool = None

        # Judge client (lazy init)
        self._judge_client = None

    async def setup(self) -> None:
        """Initialize Tinker client and database connection"""
        logger.info(f"Setting up Tinker trainer with {self.config.base_model}")
        logger.info(f"Run ID: {self.run_id}")

        # Initialize Tinker
        self.tinker_client.setup()
        logger.info("Tinker client initialized")

        # Setup logging
        if self.config.log_to_file:
            log_dir = Path(self.config.log_file).parent
            log_dir.mkdir(parents=True, exist_ok=True)
            logger.info(f"Metrics will be logged to: {self.config.log_file}")

        # Connect to database
        await self._connect_database()

        # Initialize judge
        await self._init_judge()

        logger.info("Setup complete")

    async def _connect_database(self) -> None:
        """Connect to PostgreSQL database"""
        import asyncpg

        if not self.config.database_url:
            raise ValueError("DATABASE_URL not set")

        self._db_pool = await asyncpg.create_pool(
            self.config.database_url,
            min_size=2,
            max_size=10,
            command_timeout=60,
        )
        logger.info("Connected to database")

    async def _init_judge(self) -> None:
        """Initialize OpenAI client for RLAIF judge"""
        import openai

        self._judge_client = openai.AsyncOpenAI()
        logger.info(f"Judge initialized with model: {self.config.judge_model}")

    async def cleanup(self) -> None:
        """Clean up resources"""
        if self._db_pool:
            await self._db_pool.close()
            self._db_pool = None
            logger.info("Database connection closed")

    def log_metrics(self, metrics: TrainingMetrics) -> None:
        """Log metrics to file"""
        if self.config.log_to_file:
            metrics_dict = {
                "timestamp": metrics.timestamp,
                "run_id": self.run_id,
                "step": metrics.step,
                "loss": metrics.loss,
                "num_samples": metrics.num_samples,
                "logprobs_mean": metrics.logprobs_mean,
                "pos_advantage_mean": metrics.pos_advantage_mean,
                "neg_advantage_mean": metrics.neg_advantage_mean,
                "avg_score": metrics.avg_score,
                "windows_processed": metrics.windows_processed,
            }
            with open(self.config.log_file, "a") as f:
                f.write(json.dumps(metrics_dict) + "\n")

        self.all_metrics.append(metrics)

    async def load_trajectory_groups(self) -> List[dict]:
        """Load trajectory groups from database"""
        if not self._db_pool:
            raise RuntimeError("Database not connected")

        async with self._db_pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT 
                    t."trajectoryId",
                    t."agentId",
                    t."windowId",
                    t."scenarioId",
                    t."stepsJson",
                    t."finalPnL",
                    t."episodeLength",
                    t."totalReward",
                    u.username as agent_name
                FROM trajectories t
                LEFT JOIN "User" u ON t."agentId" = u.id
                WHERE 
                    t."createdAt" > NOW() - $1::interval
                    AND t."stepsJson" IS NOT NULL
                    AND t."stepsJson"::text != 'null'
                    AND t."stepsJson"::text != '[]'
                    AND t."episodeLength" >= $2
                ORDER BY t."windowId", t."scenarioId", t."createdAt"
                """,
                f"{self.config.lookback_hours} hours",
                self.config.min_actions_per_trajectory,
            )

        # Group by window/scenario
        groups: dict = {}
        for row in rows:
            group_key = f"{row['windowId']}_{row['scenarioId'] or 'default'}"

            if group_key not in groups:
                groups[group_key] = []

            steps = json.loads(row["stepsJson"] or "[]")
            if len(steps) < self.config.min_actions_per_trajectory:
                continue

            groups[group_key].append(
                {
                    "trajectory_id": row["trajectoryId"],
                    "agent_id": row["agentId"],
                    "agent_name": row["agent_name"] or row["agentId"][:8],
                    "window_id": row["windowId"],
                    "scenario_id": row["scenarioId"],
                    "steps": steps,
                    "final_pnl": float(row["finalPnL"] or 0),
                    "episode_length": row["episodeLength"] or len(steps),
                    "total_reward": float(row["totalReward"] or 0),
                }
            )

        # Filter groups with enough trajectories
        valid_groups = [
            {"group_key": k, "trajectories": v}
            for k, v in groups.items()
            if len(v) >= self.config.min_agents_per_window
        ]

        logger.info(f"Loaded {len(valid_groups)} trajectory groups")
        return valid_groups

    def trajectory_to_messages(self, traj: dict) -> List[dict]:
        """Convert trajectory to chat messages format"""
        messages = []

        # System message
        system_content = f"""You are a trading agent in a prediction market simulation.

Agent: {traj.get('agent_name', 'Agent')}
Window: {traj.get('window_id', 'Unknown')}
Final P&L: ${traj.get('final_pnl', 0):.2f}

Your goal is to make profitable trading decisions based on market analysis."""

        messages.append({"role": "system", "content": system_content})

        # Convert steps
        steps = traj.get("steps", [])
        max_steps = self.config.max_steps_per_trajectory

        if len(steps) > max_steps:
            steps = steps[-max_steps:]

        for step_idx, step in enumerate(steps):
            if not isinstance(step, dict):
                continue

            # Get LLM calls if available
            llm_calls = step.get("llmCalls", step.get("llm_calls", []))

            if llm_calls:
                for llm_call in llm_calls:
                    purpose = llm_call.get("purpose", "action")
                    user_prompt = llm_call.get(
                        "userPrompt", llm_call.get("user_prompt", "")
                    )

                    # Build user content
                    user_content = f"[Step {step_idx + 1}, {purpose.upper()}]\n"

                    env_state = step.get(
                        "environmentState", step.get("environment_state", {})
                    )
                    if env_state:
                        balance = env_state.get(
                            "agentBalance", env_state.get("agent_balance", 0)
                        )
                        pnl = env_state.get("agentPnL", env_state.get("agent_pnl", 0))
                        positions = env_state.get(
                            "openPositions", env_state.get("open_positions", 0)
                        )
                        user_content += (
                            f"State: Balance=${balance:.2f}, "
                            f"P&L=${pnl:.2f}, Positions={positions}\n\n"
                        )

                    if user_prompt:
                        user_content += user_prompt

                    messages.append({"role": "user", "content": user_content})

                    # Assistant response
                    response = llm_call.get("response", "")
                    reasoning = llm_call.get("reasoning", "")

                    assistant_content = ""
                    if reasoning:
                        assistant_content += f"<thinking>\n{reasoning}\n</thinking>\n\n"
                    if response:
                        assistant_content += response

                    if assistant_content.strip():
                        messages.append(
                            {"role": "assistant", "content": assistant_content}
                        )
            else:
                # Fallback: build from environment state and action
                env_state = step.get(
                    "environmentState", step.get("environment_state", {})
                )
                balance = env_state.get(
                    "agentBalance", env_state.get("agent_balance", 0)
                )
                pnl = env_state.get("agentPnL", env_state.get("agent_pnl", 0))
                positions = env_state.get(
                    "openPositions", env_state.get("open_positions", 0)
                )

                user_content = (
                    f"[Step {step_idx + 1}]\n"
                    f"Market Update:\n"
                    f"- Balance: ${balance:.2f}\n"
                    f"- P&L: ${pnl:.2f}\n"
                    f"- Open Positions: {positions}"
                )

                messages.append({"role": "user", "content": user_content})

                # Action as assistant message
                action = step.get("action", {})
                action_type = action.get(
                    "actionType", action.get("action_type", "wait")
                )
                params = action.get("parameters", {})
                reasoning = action.get("reasoning", "")

                assistant_content = ""
                if reasoning:
                    assistant_content += f"<thinking>\n{reasoning}\n</thinking>\n\n"
                assistant_content += f"Action: {action_type}"
                if params:
                    assistant_content += f"\nParameters: {json.dumps(params, indent=2)}"

                messages.append({"role": "assistant", "content": assistant_content})

        return messages

    async def score_trajectories(
        self, trajectories: List[dict]
    ) -> List[float]:
        """Score trajectories using LLM judge (RLAIF)"""
        # Build judge prompt
        prompt_parts = [
            "# Trading Agent Evaluation\n",
            "Score each trajectory from 0.0 to 1.0 based on:\n",
            "- Profitability (higher P&L = higher score)\n",
            "- Risk management\n",
            "- Decision quality\n\n",
            "## Trajectories:\n",
        ]

        for i, traj in enumerate(trajectories):
            prompt_parts.append(f"\n### Trajectory {i + 1}:")
            prompt_parts.append(f"- Agent: {traj.get('agent_name', 'Unknown')}")
            prompt_parts.append(f"- Final P&L: ${traj.get('final_pnl', 0):.2f}")
            prompt_parts.append(f"- Episode Length: {traj.get('episode_length', 0)}")

        prompt_parts.append("\n## Output (JSON only):")
        prompt_parts.append(
            '{"scores": [{"trajectory_id": 1, "score": 0.85}, ...]}'
        )

        judge_prompt = "\n".join(prompt_parts)

        # Call judge
        response = await self._judge_client.chat.completions.create(
            model=self.config.judge_model,
            messages=[
                {
                    "role": "system",
                    "content": "You are an expert evaluator. Respond with valid JSON only.",
                },
                {"role": "user", "content": judge_prompt},
            ],
            max_tokens=500,
            temperature=self.config.judge_temperature,
        )

        # Parse response
        content = response.choices[0].message.content or ""
        try:
            # Clean and parse JSON
            clean = content.strip().replace("```json", "").replace("```", "")
            if "{" in clean:
                start = clean.find("{")
                end = clean.rfind("}") + 1
                parsed = json.loads(clean[start:end])
                scores_data = parsed.get("scores", parsed)

                scores = []
                for item in scores_data:
                    if isinstance(item, dict):
                        scores.append(float(item.get("score", 0.5)))
                    else:
                        scores.append(float(item))

                if len(scores) == len(trajectories):
                    return scores

        except (json.JSONDecodeError, ValueError, KeyError) as e:
            logger.warning(f"Failed to parse judge response: {e}")

        # Fallback: P&L-based scoring
        pnls = [t.get("final_pnl", 0) for t in trajectories]
        min_pnl, max_pnl = min(pnls), max(pnls)
        pnl_range = max_pnl - min_pnl if max_pnl != min_pnl else 1.0

        return [(p - min_pnl) / pnl_range for p in pnls]

    async def train_on_group(
        self, group: dict
    ) -> TrainingMetrics | None:
        """Train on a single trajectory group"""
        trajectories = group["trajectories"]

        # Sample if too many
        if len(trajectories) > self.config.group_size:
            import random

            trajectories = random.sample(trajectories, self.config.group_size)

        if len(trajectories) < 2:
            logger.warning(f"Group {group['group_key']} has insufficient trajectories")
            return None

        # Score trajectories
        scores = await self.score_trajectories(trajectories)

        # Normalize to mean 0 for GRPO
        mean_score = sum(scores) / len(scores)
        advantages = [s - mean_score for s in scores]

        # Normalize variance
        if len(advantages) > 1:
            std = float(np.std(advantages))
            if std > 1e-8:
                advantages = [a / std for a in advantages]

        # Convert to training data
        data: List[TinkerDatum] = []
        valid_advantages: List[float] = []

        for traj, advantage in zip(trajectories, advantages):
            messages = self.trajectory_to_messages(traj)

            if len(messages) < 3:  # Need at least system + user + assistant
                continue

            # Get last assistant message as completion
            assistant_msgs = [m for m in messages if m["role"] == "assistant"]
            if not assistant_msgs:
                continue

            completion = assistant_msgs[-1]["content"]
            context_messages = messages[:-1]  # All but last

            # Prepare datum
            datum = self.tinker_client.prepare_datum(
                messages=context_messages,
                completion=completion,
            )

            data.append(datum)
            valid_advantages.append(advantage)

        if not data:
            logger.warning("No valid training data from group")
            return None

        # Train step
        result = self.tinker_client.train_step(
            data=data,
            scores=valid_advantages,
            loss_fn="importance_sampling",
        )

        return TrainingMetrics(
            step=self.current_step,
            loss=result.loss,
            num_samples=result.num_samples,
            logprobs_mean=result.logprobs_mean,
            pos_advantage_mean=result.pos_advantage_mean,
            neg_advantage_mean=result.neg_advantage_mean,
            avg_score=float(np.mean(scores)),
        )

    async def train(self) -> dict:
        """Main training loop"""
        await self.setup()

        try:
            logger.info(f"Starting training for {self.config.training_steps} steps")

            # Load all trajectory groups
            all_groups = await self.load_trajectory_groups()

            if not all_groups:
                raise ValueError("No trajectory groups found")

            group_idx = 0
            windows_processed = 0

            for step in range(self.config.training_steps):
                self.current_step = step + 1
                logger.info(
                    f"Step {self.current_step}/{self.config.training_steps}"
                )

                # Get next group (circular)
                group = all_groups[group_idx % len(all_groups)]
                group_idx += 1

                # Train on group
                metrics = await self.train_on_group(group)

                if metrics:
                    windows_processed += 1
                    metrics.windows_processed = windows_processed

                    logger.info(
                        f"  Loss: {metrics.loss:.4f}, "
                        f"Samples: {metrics.num_samples}, "
                        f"Avg Score: {metrics.avg_score:.3f}"
                    )

                    self.log_metrics(metrics)
                else:
                    logger.warning("  No metrics (empty batch)")

                # Sync weights periodically
                if self.current_step % self.config.weight_sync_interval == 0:
                    logger.info("Syncing weights to sampling client...")
                    self.tinker_client.sync_weights(
                        name=f"eliza-{self.run_id}-step-{self.current_step}"
                    )

            # Final weight sync
            final_name = f"eliza-{self.run_id}-final"
            self.tinker_client.sync_weights(name=final_name)
            logger.info(f"Training complete! Final weights: {final_name}")

            return {
                "success": True,
                "run_id": self.run_id,
                "steps": self.current_step,
                "windows_processed": windows_processed,
                "final_weights": final_name,
                "metrics_file": self.config.log_file if self.config.log_to_file else None,
            }

        finally:
            await self.cleanup()


# Backward compatibility alias while imports migrate.
BabylonTinkerTrainer = TinkerTrainer
