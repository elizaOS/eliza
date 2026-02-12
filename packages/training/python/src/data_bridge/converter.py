"""
Trajectory to Atropos Converter

Converts trajectories to Atropos ScoredDataGroup format for GRPO training.
Uses pre-computed mask metadata from TypeScript when available.
Integrates 'The Judge' (Reward Functions) to score trajectories during conversion.
"""

import json
import random
from dataclasses import dataclass, field
from typing import List, Optional

from ..models import AtroposScoredGroup as PydanticScoredGroup
from ..models import TrainingTrajectory, MarketOutcomes, Action

from ..training.quality_utils import calculate_detailed_tick_quality
from ..training.rewards import TrajectoryRewardInputs, composite_reward, calculate_risk_reward


@dataclass
class AtroposMessage:
    """Single message in a conversation."""

    role: str
    content: str

    def to_dict(self) -> dict[str, str]:
        """Convert to dictionary format."""
        return {"role": self.role, "content": self.content}


@dataclass
class AtroposTrajectory:
    """Trajectory in Atropos format."""

    messages: List[AtroposMessage]
    tokens: List[int] = field(default_factory=list)
    masks: List[int] = field(default_factory=list)
    logprobs: List[float] = field(default_factory=list)
    score: float = 0.0
    metadata: dict = field(default_factory=dict)

    def to_messages_list(self) -> List[dict[str, str]]:
        """Convert messages to list of dicts."""
        return [m.to_dict() for m in self.messages]


@dataclass
class ScoredGroupResult:
    """Scored group for GRPO training."""

    tokens: List[List[int]]
    masks: List[List[int]]
    scores: List[float]
    inference_logprobs: List[List[float]] = field(default_factory=list)
    messages: List[List[dict[str, str]]] = field(default_factory=list)

    @property
    def group_size(self) -> int:
        """Number of trajectories in group."""
        return len(self.tokens)

    def to_pydantic(self) -> PydanticScoredGroup:
        """Convert to Pydantic model."""
        return PydanticScoredGroup(
            tokens=self.tokens,
            masks=self.masks,
            scores=self.scores,
            inference_logprobs=self.inference_logprobs,
            messages=self.messages,
        )


class TrajectoryToAtroposConverter:
    """
    Converts trajectories to Atropos format.

    Args:
        dropout_rate: Random dropout rate for data augmentation (0.0-0.5)
        max_steps: Maximum steps to include per trajectory
        include_messages: Whether to include raw messages in output
    """

    def __init__(
        self,
        dropout_rate: float = 0.0,
        max_steps: int = 20,
        include_messages: bool = True,
    ):
        if not 0.0 <= dropout_rate <= 0.5:
            raise ValueError(
                f"dropout_rate must be 0.0-0.5, got {dropout_rate}")
        self.dropout_rate = dropout_rate
        self.max_steps = max_steps
        self.include_messages = include_messages

    def convert_trajectory(
        self,
        trajectory: TrainingTrajectory,
        market_outcomes: Optional[MarketOutcomes] = None,
        tokenizer=None,
    ) -> Optional[AtroposTrajectory]:
        """
        Convert a trajectory to Atropos format.
        Calculates rewards using 'The Judge' logic.

        Args:
            trajectory: Source trajectory
            market_outcomes: Optional market outcome data for context
            tokenizer: Optional tokenizer for token mask computation

        Returns:
            Converted trajectory, or None if dropped

        Raises:
            ValueError: If trajectory has insufficient messages
        """
        # Random dropout for data augmentation
        if self.dropout_rate > 0 and random.random() < self.dropout_rate:
            return None

        messages: List[AtroposMessage] = []

        # System message with context
        system_msg = self._build_system_message(trajectory, market_outcomes)
        messages.append(AtroposMessage(role="system", content=system_msg))

        # Convert steps to messages
        steps = trajectory.steps[-self.max_steps:] if len(
            trajectory.steps) > self.max_steps else trajectory.steps

        total_format_score = 0.0
        total_reasoning_score = 0.0
        risky_actions_count = 0
        valid_ticks_for_scoring = 0

        for step in steps:
            # 1. Message Generation
            if step.llm_calls:
                for llm_call in step.llm_calls:
                    if not llm_call.user_prompt or not llm_call.response:
                        continue

                    messages.append(AtroposMessage(
                        role="user", content=llm_call.user_prompt))
                    messages.append(AtroposMessage(
                        role="assistant", content=llm_call.response))
            else:
                # Fallback: build from environment state
                env_state = step.environment_state
                user_content = (
                    f"Market Update:\n"
                    f"- Balance: ${env_state.agent_balance:.2f}\n"
                    f"- P&L: ${env_state.agent_pnl:.2f}\n"
                    f"- Open Positions: {env_state.open_positions}"
                )
                messages.append(AtroposMessage(
                    role="user", content=user_content))

                action = step.action
                if action:
                    assistant_content = f"Action: {action.action_type}"
                    if action.parameters:
                        assistant_content += f"\nParameters: {json.dumps(action.parameters)}"
                    messages.append(AtroposMessage(
                        role="assistant", content=assistant_content))

            # 2. Quality & Risk Scoring
            if step.llm_calls:  # Only score ticks with LLM interaction
                valid_ticks_for_scoring += 1

                # A. Detailed Quality (Format + Reasoning)
                fmt_score, rsn_score = calculate_detailed_tick_quality(
                    step.llm_calls,
                    step.action,
                    None,  # No explicit feedback dict in standard steps yet
                    trajectory.archetype
                )
                total_format_score += fmt_score
                total_reasoning_score += rsn_score

                # B. Risk Calculation
                # Use open_positions as a rough proxy for exposure if active_markets is available
                # Assuming ~10% exposure per position for simulation logic
                exposure_proxy = min(
                    1.0, step.environment_state.open_positions * 0.1)

                act_type = step.action.action_type if step.action else "wait"
                risk_penalty = calculate_risk_reward(exposure_proxy, act_type)
                if risk_penalty < 0:
                    risky_actions_count += 1

        if len(messages) < 3:
            # We assume at least System + User + Assistant
            raise ValueError(
                f"Trajectory {trajectory.trajectory_id} has only {len(messages)} messages (need 3+)")

        # Calculate averages
        avg_format = total_format_score / max(1, valid_ticks_for_scoring)
        avg_reasoning = total_reasoning_score / max(1, valid_ticks_for_scoring)

        # Get Financials
        start_bal = 10000.0
        end_bal = 10000.0

        # Try to get precise start/end from steps if available
        if trajectory.steps:
            start_bal = trajectory.steps[0].environment_state.agent_balance
            end_bal = trajectory.steps[-1].environment_state.agent_balance
        elif trajectory.final_balance is not None:
            # Fallback if step data is partial but trajectory header is populated
            end_bal = trajectory.final_balance
            # Infer start from PnL
            start_bal = end_bal - trajectory.final_pnl

        reward_inputs = TrajectoryRewardInputs(
            final_pnl=trajectory.final_pnl,
            starting_balance=start_bal,
            end_balance=end_bal,
            format_score=avg_format,
            reasoning_score=avg_reasoning,
            risky_actions_count=risky_actions_count,

            # Legacy stats
            num_steps=len(trajectory.steps),
            trades_executed=trajectory.trades_executed or 0
        )

        final_score = composite_reward(reward_inputs)

        # Tokenize and create masks if tokenizer provided
        tokens: List[int] = []
        masks: List[int] = []

        if tokenizer is not None:
            messages_dict = [m.to_dict() for m in messages]
            tokenized = tokenizer.apply_chat_template(
                messages_dict, tokenize=True, return_dict=True)
            tokens = tokenized.get("input_ids", [])
            masks = self._create_masks(tokens, messages, tokenizer)

        return AtroposTrajectory(
            messages=messages,
            tokens=tokens,
            masks=masks,
            logprobs=[],
            score=final_score,
            metadata={
                "trajectory_id": trajectory.trajectory_id,
                "agent_id": trajectory.agent_id,
                "window_id": trajectory.window_id,
                "final_pnl": trajectory.final_pnl,
                "episode_length": trajectory.episode_length,
                "trades_executed": trajectory.trades_executed or 0,
                # Store breakdown for debugging/logging
                "format_score": avg_format,
                "reasoning_score": avg_reasoning,
                "risk_penalties": risky_actions_count
            },
        )

    def _create_masks(
        self,
        tokens: List[int],
        messages: List[AtroposMessage],
        tokenizer,
    ) -> List[int]:
        """
        Create training mask marking assistant tokens as trainable.

        Uses simple role-based segmentation. Marks -100 for non-trainable,
        token_id for trainable tokens.

        Args:
            tokens: Full token sequence
            messages: Message list with roles
            tokenizer: Tokenizer for encoding

        Returns:
            Mask list with same length as tokens
        """
        masks = [-100] * len(tokens)

        # Simple approach: tokenize each message and find assistant segments
        current_pos = 0
        has_bos = hasattr(
            tokenizer, "bos_token_id") and tokenizer.bos_token_id is not None

        if has_bos:
            current_pos = 1

        for msg in messages:
            msg_tokens = tokenizer.apply_chat_template(
                [msg.to_dict()], tokenize=True, add_generation_prompt=False)
            msg_len = len(msg_tokens)

            if has_bos and msg_len > 0:
                msg_len -= 1

            if msg.role == "assistant":
                for i in range(current_pos, min(current_pos + msg_len, len(tokens))):
                    masks[i] = tokens[i]

            current_pos += msg_len

        return masks

    def _build_system_message(
        self,
        trajectory: TrainingTrajectory,
        market_outcomes: Optional[MarketOutcomes],
    ) -> str:
        """Build system message with ground truth context."""
        msg = f"""You are evaluating trading agent decisions.

AGENT: {trajectory.agent_id}
TIME WINDOW: {trajectory.window_id}
"""

        if market_outcomes and market_outcomes.stocks:
            msg += "\nMARKET OUTCOMES (ground truth agent didn't know):\n"

            for ticker, outcome in market_outcomes.stocks.items():
                msg += f"\n{ticker}:"
                msg += f"\n  Price: ${outcome.start_price:.2f} → ${outcome.end_price:.2f} ({outcome.change_percent:+.1f}%)"
                msg += f"\n  Sentiment: {outcome.sentiment or 'UNKNOWN'}"

                if outcome.news_events:
                    msg += f"\n  News: {outcome.news_events[0]}"

        msg += "\n\nEvaluate this agent's decisions given the outcomes."
        return msg

    def convert_window_group(
        self,
        trajectories: List[TrainingTrajectory],
        market_outcomes: Optional[MarketOutcomes],
        scores: Optional[List[float]] = None,
        max_per_group: int = 8,
        tokenizer=None,
    ) -> ScoredGroupResult:
        """
        Convert window trajectories to Atropos ScoredDataGroup.

        Args:
            trajectories: Trajectories from same window
            market_outcomes: Market outcome data
            scores: Optional pre-computed scores
            max_per_group: Maximum trajectories per group
            tokenizer: Optional tokenizer

        Returns:
            Scored group result

        Raises:
            ValueError: If fewer than 2 trajectories
        """
        if len(trajectories) < 2:
            raise ValueError(
                f"Need 2+ trajectories for GRPO, got {len(trajectories)}")

        # Sample if too many
        if len(trajectories) > max_per_group:
            indices = random.sample(range(len(trajectories)), max_per_group)
            sampled = [trajectories[i] for i in indices]
            # Note: We ignore incoming 'scores' list if we are calculating them internally via The Judge
            # However, if scores were passed in, we filter them to match sample
            if scores:
                scores = [scores[i] for i in indices]
        else:
            sampled = trajectories

        # Convert all
        atropos_trajectories: List[AtroposTrajectory] = []
        for traj in sampled:
            converted = self.convert_trajectory(
                traj, market_outcomes, tokenizer)
            if converted:
                atropos_trajectories.append(converted)

        if len(atropos_trajectories) < 2:
            raise ValueError(
                f"Only {len(atropos_trajectories)} trajectories after conversion (need 2+)")

        # Build result
        tokens_list = [t.tokens for t in atropos_trajectories]
        masks_list = [t.masks for t in atropos_trajectories]
        logprobs_list = [t.logprobs for t in atropos_trajectories]

        # Use the internally calculated scores from The Judge
        scores_list = [t.score for t in atropos_trajectories]

        messages_list: List[List[dict[str, str]]] = []
        if self.include_messages:
            messages_list = [t.to_messages_list()
                             for t in atropos_trajectories]

        return ScoredGroupResult(
            tokens=tokens_list,
            masks=masks_list,
            scores=scores_list,
            inference_logprobs=logprobs_list,
            messages=messages_list,
        )


def calculate_dropout_rate(
    current_trajectories: int,
    target_trajectories: int,
    max_dropout: float = 0.3
) -> float:
    """
    Calculate the dropout rate required to reduce the number of trajectories
    from the current count to the target count.

    Args:
        current_trajectories: The number of trajectories currently available.
        target_trajectories: The desired number of trajectories.
        max_dropout: The maximum allowable dropout rate (0.0 to 1.0).

    Returns:
        The calculated dropout rate, capped by max_dropout.
    """
    if current_trajectories <= target_trajectories:
        return 0.0

    # Dropout rate = 1 - (target / current)
    rate = 1.0 - (float(target_trajectories) / current_trajectories)

    return min(rate, max_dropout)


# Backward compatibility alias while imports migrate.
BabylonToAtroposConverter = TrajectoryToAtroposConverter
