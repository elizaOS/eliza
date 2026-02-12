"""
Multi-Turn Episode Manager for GRPO Training

⚠️ STATUS: NOT YET INTEGRATED
This module is ready to use but not currently called by babylon_env.py or online_env.py.
To integrate, see TRAINING_ROADMAP.md Phase 4.

Handles multi-turn trading episodes with proper credit assignment
using Generalized Advantage Estimation (GAE).

For trading scenarios:
- A single action's value depends on future market movements
- Subsequent actions affect overall trajectory value
- Final episode outcome determines success

This module provides:
1. TurnData - Structure for individual turn data
2. EpisodeBuffer - Buffer for collecting episode turns
3. MultiTurnEpisodeManager - GAE-based advantage computation
4. Trajectory utilities for GRPO training

Usage:
    manager = MultiTurnEpisodeManager(gamma=0.99, gae_lambda=0.95)
    
    # Collect episode turns
    episode = EpisodeBuffer(scenario_id="test-1")
    for turn in range(max_turns):
        turn_data = TurnData(...)
        episode.add_turn(turn_data)
        if done:
            break
    
    # Compute advantages
    manager.compute_advantages(episode.turns)
    
    # Create training items
    training_items = manager.create_training_items(episode.turns, tokenizer)
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# =============================================================================
# Turn and Episode Data Structures
# =============================================================================


@dataclass
class TurnData:
    """
    Data for a single turn in a multi-turn episode.
    
    Contains all information needed for training on this turn,
    including computed advantages for GRPO.
    """
    # Turn identification
    turn_number: int
    episode_id: str = ""
    
    # State at this turn
    state: Dict[str, Any] = field(default_factory=dict)
    observation: str = ""
    
    # Action taken
    action: Dict[str, Any] = field(default_factory=dict)
    action_text: str = ""
    action_type: str = ""
    
    # Messages up to this point
    messages: List[Dict[str, str]] = field(default_factory=list)
    
    # Reward received after action
    reward: float = 0.0
    
    # Quality scores
    format_score: float = 0.0
    reasoning_score: float = 0.0
    
    # Episode termination
    done: bool = False
    termination_reason: str = ""
    
    # Computed values (filled in by GAE)
    value: float = 0.0
    advantage: float = 0.0
    return_to_go: float = 0.0
    
    # Token data for training
    tokens: List[int] = field(default_factory=list)
    masks: List[int] = field(default_factory=list)
    logprobs: List[float] = field(default_factory=list)
    
    # Metadata
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for serialization"""
        return {
            "turn_number": self.turn_number,
            "episode_id": self.episode_id,
            "action_type": self.action_type,
            "action_text": self.action_text[:200],  # Truncate for logging
            "reward": round(self.reward, 4),
            "format_score": round(self.format_score, 3),
            "reasoning_score": round(self.reasoning_score, 3),
            "done": self.done,
            "value": round(self.value, 4),
            "advantage": round(self.advantage, 4),
            "return_to_go": round(self.return_to_go, 4),
        }


@dataclass
class EpisodeBuffer:
    """
    Buffer for collecting turns during an episode.
    
    Tracks episode-level metrics and provides utilities
    for episode analysis.
    """
    # Episode identification
    episode_id: str
    scenario_id: str = ""
    archetype: str = "trader"
    
    # Turns collected
    turns: List[TurnData] = field(default_factory=list)
    
    # Episode-level metrics (computed after completion)
    total_reward: float = 0.0
    total_pnl: float = 0.0
    episode_length: int = 0
    completed: bool = False
    success: bool = False
    
    # Timing
    start_time: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    end_time: Optional[datetime] = None
    
    def add_turn(self, turn: TurnData) -> None:
        """Add a turn to the buffer"""
        turn.episode_id = self.episode_id
        self.turns.append(turn)
        
        if turn.done:
            self._finalize()
    
    def _finalize(self) -> None:
        """Finalize episode after completion"""
        self.completed = True
        self.end_time = datetime.now(timezone.utc)
        self.episode_length = len(self.turns)
        self.total_reward = sum(t.reward for t in self.turns)
        
        # Check success based on final reward
        if self.turns:
            final_turn = self.turns[-1]
            # Episode is successful if total reward is positive
            self.success = self.total_reward > 0
    
    def get_messages(self) -> List[Dict[str, str]]:
        """Get all messages from the episode"""
        if self.turns:
            return self.turns[-1].messages.copy()
        return []
    
    def get_trajectory(self) -> List[Tuple[str, float, str]]:
        """Get (action_type, reward, action_text) for each turn"""
        return [
            (t.action_type, t.reward, t.action_text[:100])
            for t in self.turns
        ]
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for logging"""
        return {
            "episode_id": self.episode_id,
            "scenario_id": self.scenario_id,
            "archetype": self.archetype,
            "episode_length": self.episode_length,
            "total_reward": round(self.total_reward, 4),
            "total_pnl": round(self.total_pnl, 2),
            "completed": self.completed,
            "success": self.success,
            "turns": [t.to_dict() for t in self.turns],
        }


# =============================================================================
# Multi-Turn Episode Manager
# =============================================================================


@dataclass
class GAEConfig:
    """Configuration for GAE computation"""
    gamma: float = 0.99  # Discount factor
    gae_lambda: float = 0.95  # GAE lambda
    normalize_advantages: bool = True  # Normalize across batch
    clip_advantages: bool = True  # Clip extreme advantages
    advantage_clip: float = 10.0  # Clip threshold
    use_value_normalization: bool = True  # Normalize values


class MultiTurnEpisodeManager:
    """
    Manages multi-turn trading episodes with GAE-based credit assignment.
    
    For trading scenarios, a single action's value depends on:
    - Future market movements
    - Subsequent actions
    - Final episode outcome
    
    This manager computes proper advantages for each turn to enable
    credit assignment in multi-turn settings.
    """
    
    def __init__(
        self,
        gamma: float = 0.99,
        gae_lambda: float = 0.95,
        max_turns: int = 20,
        normalize_advantages: bool = True,
    ):
        self.config = GAEConfig(
            gamma=gamma,
            gae_lambda=gae_lambda,
            normalize_advantages=normalize_advantages,
        )
        self.max_turns = max_turns
        
        # Statistics
        self._episodes_processed = 0
        self._total_turns = 0
    
    def compute_advantages(self, turns: List[TurnData]) -> None:
        """
        Compute GAE advantages for each turn in an episode.
        
        Modifies turns in-place to add:
        - value: Estimated value of the state
        - return_to_go: Cumulative discounted future reward
        - advantage: GAE advantage estimate
        
        Args:
            turns: List of turns in chronological order
        """
        if not turns:
            return
        
        # Step 1: Compute return-to-go (cumulative discounted reward)
        # Going backwards from the end
        cumulative = 0.0
        for turn in reversed(turns):
            cumulative = turn.reward + self.config.gamma * cumulative
            turn.return_to_go = cumulative
        
        # Step 2: Estimate values
        # Simple approach: value = return_to_go (Monte Carlo estimate)
        for turn in turns:
            turn.value = turn.return_to_go
        
        # Step 3: Compute GAE advantages
        next_value = 0.0
        gae = 0.0
        
        for turn in reversed(turns):
            # TD error
            if turn.done:
                next_value = 0.0
            
            delta = turn.reward + self.config.gamma * next_value - turn.value
            
            # GAE accumulation
            gae = delta + self.config.gamma * self.config.gae_lambda * gae
            turn.advantage = gae
            
            next_value = turn.value
        
        # Step 4: Clip extreme advantages
        if self.config.clip_advantages:
            for turn in turns:
                turn.advantage = max(
                    -self.config.advantage_clip,
                    min(self.config.advantage_clip, turn.advantage),
                )
        
        self._episodes_processed += 1
        self._total_turns += len(turns)
    
    def compute_batch_advantages(
        self,
        episodes: List[List[TurnData]],
    ) -> None:
        """
        Compute advantages for a batch of episodes.
        
        Also normalizes advantages across the batch if configured.
        
        Args:
            episodes: List of episodes, each containing turns
        """
        # Compute per-episode advantages
        for episode in episodes:
            self.compute_advantages(episode)
        
        # Normalize across batch
        if self.config.normalize_advantages and episodes:
            all_advantages = []
            for episode in episodes:
                for turn in episode:
                    all_advantages.append(turn.advantage)
            
            if all_advantages:
                mean = sum(all_advantages) / len(all_advantages)
                
                if len(all_advantages) > 1:
                    variance = sum((a - mean) ** 2 for a in all_advantages) / len(all_advantages)
                    std = max(variance ** 0.5, 1e-8)
                else:
                    std = 1.0
                
                # Normalize
                for episode in episodes:
                    for turn in episode:
                        turn.advantage = (turn.advantage - mean) / std
    
    def create_training_items(
        self,
        turns: List[TurnData],
        tokenizer,
        train_on_all_assistant_turns: bool = True,
    ) -> List[Dict]:
        """
        Create training items from episode turns.
        
        Args:
            turns: List of turns with computed advantages
            tokenizer: Tokenizer for token processing
            train_on_all_assistant_turns: Train on all turns or just last
        
        Returns:
            List of training items suitable for GRPO
        """
        items = []
        
        for turn in turns:
            # Skip if no advantage computed
            if turn.advantage == 0.0 and turn.reward == 0.0:
                continue
            
            # If tokens not pre-computed, compute from messages
            if not turn.tokens and turn.messages:
                tokens = self._tokenize_messages(tokenizer, turn.messages)
                turn.tokens = tokens
                turn.masks = self._create_masks(tokenizer, turn.messages, tokens)
            
            item = {
                "tokens": turn.tokens,
                "masks": turn.masks,
                "score": turn.advantage,  # Use advantage as score for GRPO
                "metadata": {
                    "turn": turn.turn_number,
                    "episode_id": turn.episode_id,
                    "reward": turn.reward,
                    "value": turn.value,
                    "return_to_go": turn.return_to_go,
                    "action_type": turn.action_type,
                },
            }
            
            items.append(item)
        
        return items
    
    def _tokenize_messages(
        self,
        tokenizer,
        messages: List[Dict[str, str]],
    ) -> List[int]:
        """Tokenize chat messages"""
        try:
            tokens = tokenizer.apply_chat_template(
                messages,
                add_generation_prompt=False,
                return_tensors=None,
            )
            return tokens
        except Exception as e:
            logger.warning(f"Tokenization failed: {e}")
            return []
    
    def _create_masks(
        self,
        tokenizer,
        messages: List[Dict[str, str]],
        tokens: List[int],
    ) -> List[int]:
        """
        Create training masks for tokens.
        
        Masks assistant turns for training.
        """
        if not tokens:
            return []
        
        # Simple approach: find last assistant turn and mask it
        masks = [0] * len(tokens)
        
        # Find the position where the last assistant response starts
        # This is an approximation; proper implementation would use
        # the tokenizer's chat template structure
        
        if not messages:
            return masks
        
        # Find last assistant message
        last_assistant_idx = -1
        for i, msg in enumerate(messages):
            if msg.get("role") == "assistant":
                last_assistant_idx = i
        
        if last_assistant_idx == -1:
            return masks
        
        # Tokenize everything before the last assistant message
        prompt_messages = messages[:last_assistant_idx]
        if prompt_messages:
            prompt_tokens = self._tokenize_messages(tokenizer, prompt_messages)
            prompt_len = len(prompt_tokens)
        else:
            prompt_len = 0
        
        # Mark tokens after prompt as trainable
        for i in range(prompt_len, len(tokens)):
            masks[i] = 1
        
        return masks
    
    def get_stats(self) -> Dict:
        """Get manager statistics"""
        return {
            "episodes_processed": self._episodes_processed,
            "total_turns": self._total_turns,
            "avg_turns_per_episode": (
                self._total_turns / max(1, self._episodes_processed)
            ),
            "gamma": self.config.gamma,
            "gae_lambda": self.config.gae_lambda,
            "max_turns": self.max_turns,
        }


# =============================================================================
# Reward Shaping Utilities
# =============================================================================


def shape_trading_rewards(
    turns: List[TurnData],
    format_weight: float = 0.2,
    reasoning_weight: float = 0.1,
    pnl_weight: float = 0.5,
    action_weight: float = 0.2,
) -> None:
    """
    Shape rewards for trading episodes.
    
    Combines multiple reward signals:
    - Format quality (think tags, action JSON)
    - Reasoning quality
    - PnL changes
    - Action quality (valid, appropriate for situation)
    
    Modifies turns in-place.
    
    Args:
        turns: Episode turns
        format_weight: Weight for format score
        reasoning_weight: Weight for reasoning score
        pnl_weight: Weight for PnL-based reward
        action_weight: Weight for action quality
    """
    for turn in turns:
        # Start with raw reward (usually PnL-based)
        raw_reward = turn.reward
        
        # Add format and reasoning bonuses
        format_bonus = turn.format_score * format_weight
        reasoning_bonus = turn.reasoning_score * reasoning_weight
        
        # Compute action quality bonus
        action_bonus = 0.0
        if turn.action_type in ["buy", "sell", "open_perp", "close_perp"]:
            action_bonus = 0.1 * action_weight  # Reward for active trading
        elif turn.action_type == "wait":
            action_bonus = 0.05 * action_weight  # Smaller reward for waiting
        else:
            action_bonus = -0.1 * action_weight  # Penalty for invalid actions
        
        # Combine
        turn.reward = (
            raw_reward * pnl_weight +
            format_bonus +
            reasoning_bonus +
            action_bonus
        )


def compute_episode_return(
    turns: List[TurnData],
    gamma: float = 0.99,
) -> float:
    """
    Compute total discounted return for an episode.
    
    Args:
        turns: Episode turns
        gamma: Discount factor
    
    Returns:
        Discounted return
    """
    if not turns:
        return 0.0
    
    total = 0.0
    discount = 1.0
    
    for turn in turns:
        total += discount * turn.reward
        discount *= gamma
    
    return total


def normalize_episode_rewards(
    episodes: List[List[TurnData]],
) -> None:
    """
    Normalize rewards across episodes.
    
    Useful for reducing variance in training.
    
    Args:
        episodes: List of episodes to normalize
    """
    all_rewards = []
    for episode in episodes:
        for turn in episode:
            all_rewards.append(turn.reward)
    
    if not all_rewards or len(all_rewards) < 2:
        return
    
    mean = sum(all_rewards) / len(all_rewards)
    variance = sum((r - mean) ** 2 for r in all_rewards) / len(all_rewards)
    std = max(variance ** 0.5, 1e-8)
    
    for episode in episodes:
        for turn in episode:
            turn.reward = (turn.reward - mean) / std


# =============================================================================
# Episode Collectors
# =============================================================================


class EpisodeCollector:
    """
    Utility for collecting episodes with consistent structure.
    
    Provides helper methods for episode management during rollouts.
    """
    
    def __init__(self, max_episodes: int = 1000):
        self.max_episodes = max_episodes
        self.episodes: List[EpisodeBuffer] = []
        self._current_episode: Optional[EpisodeBuffer] = None
    
    def start_episode(
        self,
        scenario_id: str,
        archetype: str = "trader",
    ) -> EpisodeBuffer:
        """Start a new episode"""
        import uuid
        
        episode_id = f"ep-{uuid.uuid4().hex[:8]}"
        episode = EpisodeBuffer(
            episode_id=episode_id,
            scenario_id=scenario_id,
            archetype=archetype,
        )
        
        self._current_episode = episode
        return episode
    
    def add_turn(self, turn: TurnData) -> None:
        """Add turn to current episode"""
        if self._current_episode is None:
            raise RuntimeError("No active episode. Call start_episode first.")
        
        self._current_episode.add_turn(turn)
        
        if turn.done:
            self._finalize_current()
    
    def _finalize_current(self) -> None:
        """Finalize and store current episode"""
        if self._current_episode is not None:
            self.episodes.append(self._current_episode)
            
            # Trim if too many
            if len(self.episodes) > self.max_episodes:
                self.episodes = self.episodes[-self.max_episodes:]
            
            self._current_episode = None
    
    def get_completed_episodes(self) -> List[EpisodeBuffer]:
        """Get all completed episodes"""
        return [e for e in self.episodes if e.completed]
    
    def get_successful_episodes(self) -> List[EpisodeBuffer]:
        """Get successful episodes"""
        return [e for e in self.episodes if e.completed and e.success]
    
    def clear(self) -> None:
        """Clear all episodes"""
        self.episodes = []
        self._current_episode = None
    
    def get_stats(self) -> Dict:
        """Get collector statistics"""
        completed = self.get_completed_episodes()
        successful = self.get_successful_episodes()
        
        return {
            "total_episodes": len(self.episodes),
            "completed_episodes": len(completed),
            "successful_episodes": len(successful),
            "success_rate": len(successful) / max(1, len(completed)),
            "avg_episode_length": (
                sum(e.episode_length for e in completed) / max(1, len(completed))
            ),
            "avg_reward": (
                sum(e.total_reward for e in completed) / max(1, len(completed))
            ),
        }

