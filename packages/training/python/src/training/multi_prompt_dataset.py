"""
Multi-Prompt Dataset Preparation

Prepares training data for EACH LLM call in a trajectory, not just the whole trajectory.

CRITICAL: PROMPT FORMAT CONSISTENCY
=====================================
For RL training to work correctly, the model MUST see identical prompts during
training as it saw during rollout. This module preserves EXACT prompts:

CANONICAL PROMPT FORMAT (from autonomous services):
1. system_prompt: The agent's personality/strategy (from userAgentConfigs.systemPrompt)
   - Contains: persona, trading strategy, behavioral guidelines
   - Example: "You are a degen trader who loves high risk plays..."

2. user_prompt: The full prompt with context and instructions (prompt param)
   - Contains: market data, portfolio state, output format spec
   - Example: "Current Balance: $10000\n\nAvailable Markets:\n...\n\nRespond in JSON..."

3. response: The exact LLM output (result.text)
   - Format varies by purpose:
     - action (trading): JSON {"action": "trade", "trade": {...}}
     - action (posting): Plain text content
     - reasoning: Plain text analysis
     - evaluation: JSON array of decisions
     - response: Plain text reply

PURPOSE CATEGORIES (for RLAIF reward attribution):
- 'action': Decisions that change state (trades, posts, actions)
- 'reasoning': Planning, analysis, thinking (no direct effect)
- 'evaluation': Assessing situations/options
- 'response': Social replies, DMs, comments

The trajectory logger stores these exact fields from callGroqDirect:
- systemPrompt <- params.system
- userPrompt <- params.prompt  
- response <- result.text

This module extracts them WITHOUT modification for training.
"""

import json
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Literal
from datetime import datetime

from ..models import (
    BabylonTrajectory,
    TrajectoryStep,
    LLMCall,
    AtroposScoredGroup,
)

logger = logging.getLogger(__name__)


PromptPurpose = Literal['action', 'reasoning', 'evaluation', 'response', 'other']


@dataclass
class PromptSample:
    """
    Single prompt sample for training.
    
    Each LLM call within a tick becomes a separate sample.
    Rewards are attributed based on:
    - Purpose type (reasoning, action, response, evaluation)
    - Whether this call led to a successful action
    - The overall tick/trajectory outcome
    """
    
    # Source identification
    trajectory_id: str
    step_number: int
    call_index: int  # Which LLM call in the step (0=first, 1=second, etc.)
    
    # The prompt content
    system_prompt: str
    user_prompt: str
    response: str
    
    # Metadata
    purpose: PromptPurpose
    action_type: str | None  # e.g., 'evaluate_trading_opportunity', 'execute_response'
    model: str
    temperature: float
    
    # Scoring - Multi-level rewards
    trajectory_score: float  # Overall trajectory score (from judge)
    step_reward: float  # Reward at this step (immediate)
    attributed_reward: float = 0.0  # Reward attributed to THIS specific call
    action_success: bool = False  # Was the resulting action successful
    led_to_action: bool = False  # Did this call contribute to an action
    
    # Context
    environment_context: dict = field(default_factory=dict)  # Env state at this step
    previous_actions: list[str] = field(default_factory=list)  # What came before
    
    def to_messages(self) -> list[dict]:
        """Convert to chat message format"""
        return [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": self.user_prompt},
            {"role": "assistant", "content": self.response},
        ]
    
    def get_weighted_score(self) -> float:
        """
        Calculate weighted score for this sample.
        
        Priority order:
        1. attributed_reward (if set) - most precise, from tick outcome
        2. step_reward + adjustments - step-level signal
        3. trajectory_score + adjustments - fallback to global
        """
        # If we have attributed reward, use it (already normalized for GRPO)
        if self.attributed_reward != 0.0:
            return max(0.0, min(1.0, 0.5 + self.attributed_reward))
        
        base_score = self.trajectory_score
        
        # Boost if this call led to successful action
        if self.led_to_action and self.action_success:
            base_score += 0.15
        elif self.led_to_action and not self.action_success:
            base_score -= 0.1
        
        # Boost successful actions
        if self.action_success:
            base_score += 0.1
        
        # Add step reward contribution
        base_score += self.step_reward * 0.2
        
        return max(0.0, min(1.0, base_score))


@dataclass
class DiversityMetrics:
    """Diversity metrics for a dataset"""
    unique_action_types: int = 0
    unique_trajectories: int = 0
    score_quartiles: list[float] = field(default_factory=list)  # [Q1, Q2, Q3]
    action_type_distribution: dict[str, int] = field(default_factory=dict)
    archetype_distribution: dict[str, int] = field(default_factory=dict)
    curriculum_distribution: dict[str, int] = field(default_factory=lambda: {"easy": 0, "medium": 0, "hard": 0})


@dataclass
class PromptDataset:
    """Dataset of prompt samples grouped by purpose"""
    
    purpose: PromptPurpose
    samples: list[PromptSample] = field(default_factory=list)
    
    # Statistics (calculated dynamically)
    avg_score: float = 0.0
    score_variance: float = 0.0
    
    # Diversity tracking
    _action_types: set[str] = field(default_factory=set)
    _trajectory_ids: set[str] = field(default_factory=set)
    _archetypes: dict[str, int] = field(default_factory=dict)
    
    def add_sample(self, sample: PromptSample) -> None:
        """Add a sample to the dataset"""
        self.samples.append(sample)
        
        # Track diversity
        if sample.action_type:
            self._action_types.add(sample.action_type)
        self._trajectory_ids.add(sample.trajectory_id)
        
        # Track archetype from trajectory_id (format: traj-agent-{archetype}-{n})
        parts = sample.trajectory_id.split("-")
        if len(parts) >= 3:
            archetype = parts[2] if len(parts) > 3 else "unknown"
            self._archetypes[archetype] = self._archetypes.get(archetype, 0) + 1
        
        self._update_stats()
    
    def _update_stats(self) -> None:
        """Update statistics"""
        if not self.samples:
            return
        scores = [s.get_weighted_score() for s in self.samples]
        self.avg_score = sum(scores) / len(scores)
        if len(scores) > 1:
            self.score_variance = sum((s - self.avg_score) ** 2 for s in scores) / len(scores)
    
    def get_diversity_metrics(self) -> DiversityMetrics:
        """Calculate diversity metrics for this dataset"""
        metrics = DiversityMetrics()
        
        if not self.samples:
            return metrics
        
        # Unique counts
        metrics.unique_action_types = len(self._action_types)
        metrics.unique_trajectories = len(self._trajectory_ids)
        
        # Action type distribution
        for sample in self.samples:
            if sample.action_type:
                metrics.action_type_distribution[sample.action_type] = \
                    metrics.action_type_distribution.get(sample.action_type, 0) + 1
        
        # Archetype distribution
        metrics.archetype_distribution = dict(self._archetypes)
        
        # Score quartiles
        scores = sorted(s.get_weighted_score() for s in self.samples)
        n = len(scores)
        if n >= 4:
            metrics.score_quartiles = [
                scores[n // 4],      # Q1
                scores[n // 2],      # Q2 (median)
                scores[3 * n // 4],  # Q3
            ]
        
        return metrics
    
    def is_diverse_enough(
        self,
        min_action_types: int = 2,
        min_trajectories: int = 3,
        min_score_variance: float = 0.01,
    ) -> tuple[bool, list[str]]:
        """
        Check if dataset has sufficient diversity for good training.
        
        Returns:
            (is_diverse, list of issues)
        """
        issues = []
        
        if len(self._action_types) < min_action_types:
            issues.append(f"Low action diversity: {len(self._action_types)} < {min_action_types}")
        
        if len(self._trajectory_ids) < min_trajectories:
            issues.append(f"Low trajectory diversity: {len(self._trajectory_ids)} < {min_trajectories}")
        
        if self.score_variance < min_score_variance:
            issues.append(f"Low score variance: {self.score_variance:.4f} < {min_score_variance}")
        
        return len(issues) == 0, issues
    
    def get_training_groups(
        self,
        group_size: int = 4,
        min_score_variance: float = 0.01,
    ) -> list[list[PromptSample]]:
        """
        Create training groups with score variance.
        
        Groups samples to ensure there's meaningful score difference for GRPO.
        """
        if len(self.samples) < group_size:
            return []
        
        # Sort by score
        sorted_samples = sorted(self.samples, key=lambda s: s.get_weighted_score())
        
        groups = []
        
        # Create groups with diverse scores
        n = len(sorted_samples)
        for i in range(0, n - group_size + 1, group_size // 2):  # Overlapping groups
            group = []
            
            # Pick from different score ranges
            step = n // group_size
            for j in range(group_size):
                idx = min(i + j * step, n - 1)
                group.append(sorted_samples[idx])
            
            # Verify score variance
            scores = [s.get_weighted_score() for s in group]
            variance = sum((s - sum(scores)/len(scores)) ** 2 for s in scores) / len(scores)
            
            if variance >= min_score_variance:
                groups.append(group)
        
        return groups


class MultiPromptDatasetBuilder:
    """
    Builds training datasets from trajectories with multi-prompt handling.
    
    This creates separate training data for each prompt type (reasoning, action, etc.)
    so the model learns from successful examples of each type.
    """
    
    def __init__(
        self,
        include_context: bool = True,
        max_context_length: int = 2000,
        min_response_length: int = 10,
    ):
        self.include_context = include_context
        self.max_context_length = max_context_length
        self.min_response_length = min_response_length
        
        # Datasets by purpose
        self.datasets: dict[PromptPurpose, PromptDataset] = {
            'action': PromptDataset(purpose='action'),
            'reasoning': PromptDataset(purpose='reasoning'),
            'evaluation': PromptDataset(purpose='evaluation'),
            'response': PromptDataset(purpose='response'),
        }
        
        self.total_trajectories = 0
        self.total_steps = 0
        self.total_samples = 0
    
    def add_trajectory(
        self,
        trajectory: BabylonTrajectory,
        trajectory_score: float,
    ) -> int:
        """
        Extract all prompt samples from a trajectory.
        
        Args:
            trajectory: The trajectory to process
            trajectory_score: Overall score for this trajectory (from judge)
            
        Returns:
            Number of samples extracted
        """
        samples_added = 0
        previous_actions: list[str] = []
        
        for step_idx, step in enumerate(trajectory.steps):
            # Extract environment context
            env_context = {
                "balance": step.environment_state.agent_balance,
                "pnl": step.environment_state.agent_pnl,
                "positions": step.environment_state.open_positions,
            }
            
            # Process each LLM call in this step
            for call_idx, llm_call in enumerate(step.llm_calls):
                sample = self._create_sample(
                    trajectory=trajectory,
                    step=step,
                    step_idx=step_idx,
                    llm_call=llm_call,
                    call_idx=call_idx,
                    trajectory_score=trajectory_score,
                    env_context=env_context,
                    previous_actions=previous_actions.copy(),
                )
                
                if sample:
                    purpose = sample.purpose
                    self.datasets[purpose].add_sample(sample)
                    samples_added += 1
            
            # Track action history
            if step.action:
                previous_actions.append(step.action.action_type)
                if len(previous_actions) > 5:
                    previous_actions.pop(0)
            
            self.total_steps += 1
        
        self.total_trajectories += 1
        self.total_samples += samples_added
        
        return samples_added
    
    def _create_sample(
        self,
        trajectory: BabylonTrajectory,
        step: TrajectoryStep,
        step_idx: int,
        llm_call: LLMCall,
        call_idx: int,
        trajectory_score: float,
        env_context: dict,
        previous_actions: list[str],
    ) -> PromptSample | None:
        """
        Create a prompt sample from an LLM call.
        
        CRITICAL FOR TRAINING: We preserve the EXACT prompts that were used during
        rollout. The model must see identical inputs during training as it saw
        during data collection, otherwise distribution shift will hurt performance.
        
        The prompts are stored in the trajectory logger exactly as they were
        passed to the LLM:
        - system_prompt: The agent's system prompt (personality, strategy)
        - user_prompt: The actual prompt with market data, instructions, etc.
        - response: The exact LLM output
        
        We do NOT modify these prompts in any way.
        """
        
        # Validate content - require minimum response length for quality
        if not llm_call.response or len(llm_call.response) < self.min_response_length:
            logger.debug(
                f"Skipping LLM call: response too short ({len(llm_call.response or '')} < {self.min_response_length})"
            )
            return None
        
        if not llm_call.user_prompt:
            logger.debug("Skipping LLM call: no user_prompt")
            return None
        
        # CRITICAL: Use EXACT prompts from rollout - no modifications!
        # This ensures training matches inference distribution
        system_prompt = llm_call.system_prompt or ""
        user_prompt = llm_call.user_prompt
        response = llm_call.response
        
        # Only truncate if absolutely necessary (very long prompts)
        # This is a safety measure, not a modification of normal prompts
        if len(system_prompt) > self.max_context_length:
            logger.warning(
                f"System prompt truncated from {len(system_prompt)} to {self.max_context_length} chars"
            )
            system_prompt = system_prompt[:self.max_context_length] + "..."
        
        # Determine if this LLM call led to an action
        # Action calls that directly produced the step's action get credit
        led_to_action = False
        if step.action and step.action.action_type != "wait":
            # The last 'action' purpose call in the step typically produces the action
            action_calls = [c for c in step.llm_calls if c.purpose == 'action']
            if action_calls and llm_call == action_calls[-1]:
                led_to_action = True
            # Also credit reasoning calls that preceded an action
            elif llm_call.purpose == 'reasoning' and action_calls:
                led_to_action = True
        
        # Calculate attributed reward for this specific call
        # This breaks down the global tick reward to individual LLM calls
        attributed_reward = self._calculate_attributed_reward(
            llm_call=llm_call,
            step=step,
            trajectory_score=trajectory_score,
            led_to_action=led_to_action,
            call_idx=call_idx,
            total_calls=len(step.llm_calls),
        )
        
        return PromptSample(
            trajectory_id=trajectory.trajectory_id,
            step_number=step_idx,
            call_index=call_idx,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            response=response,
            purpose=llm_call.purpose,
            action_type=llm_call.action_type,
            model=llm_call.model,
            temperature=llm_call.temperature,
            trajectory_score=trajectory_score,
            step_reward=step.reward,
            attributed_reward=attributed_reward,
            action_success=step.action.success if step.action else False,
            led_to_action=led_to_action,
            environment_context=env_context,
            previous_actions=previous_actions,
        )
    
    def _calculate_attributed_reward(
        self,
        llm_call: LLMCall,
        step: TrajectoryStep,
        trajectory_score: float,
        led_to_action: bool,
        call_idx: int,
        total_calls: int,
    ) -> float:
        """
        Attribute reward to a specific LLM call within a tick.
        
        The reward attribution strategy:
        - 'action' calls that led to successful actions: Get most of step reward
        - 'reasoning' calls: Get portion based on action success
        - 'evaluation' calls: Get small fixed reward for information gathering
        - 'response' calls: Based on whether they completed successfully
        
        This is CRITICAL for GRPO - we need meaningful reward differences
        between good and bad responses to learn from.
        """
        base_reward = 0.0
        
        # Start with trajectory-level signal
        traj_component = (trajectory_score - 0.5) * 0.3  # Normalize around 0
        
        # Add step-level signal
        step_component = step.reward * 0.4
        
        # Purpose-specific attribution
        if llm_call.purpose == 'action':
            if led_to_action:
                # Action calls that produced actions get most credit
                if step.action and step.action.success:
                    base_reward = step_component + traj_component + 0.2
                else:
                    base_reward = step_component + traj_component - 0.1
            else:
                # Action calls that didn't produce action (maybe skipped)
                base_reward = traj_component
                
        elif llm_call.purpose == 'reasoning':
            # Reasoning gets credit if it led to good actions
            if led_to_action and step.action and step.action.success:
                base_reward = step_component * 0.5 + traj_component + 0.1
            else:
                base_reward = traj_component * 0.5
                
        elif llm_call.purpose == 'evaluation':
            # Evaluation calls help with decision quality
            # Small positive reward for completing, slightly more if action succeeded
            if step.action and step.action.success:
                base_reward = 0.05 + traj_component * 0.3
            else:
                base_reward = traj_component * 0.3
                
        elif llm_call.purpose == 'response':
            # Response calls (social) - reward for engagement
            # Could be enhanced with actual engagement metrics
            base_reward = traj_component + 0.05 if step.action and step.action.success else traj_component
            
        else:  # 'other'
            base_reward = traj_component * 0.2
        
        # If multiple calls in a step, distribute reward (avoid double counting)
        if total_calls > 1:
            # Primary action call gets more, others get less
            if led_to_action and llm_call.purpose == 'action':
                base_reward *= 0.7
            else:
                base_reward *= 0.5
        
        return base_reward
    
    def get_statistics(self) -> dict:
        """Get dataset statistics"""
        stats = {
            "total_trajectories": self.total_trajectories,
            "total_steps": self.total_steps,
            "total_samples": self.total_samples,
            "by_purpose": {},
        }
        
        for purpose, dataset in self.datasets.items():
            stats["by_purpose"][purpose] = {
                "count": len(dataset.samples),
                "avg_score": dataset.avg_score,
                "score_variance": dataset.score_variance,
            }
        
        return stats
    
    def build_training_data(
        self,
        purpose: PromptPurpose | None = None,
        group_size: int = 4,
        tokenizer = None,
    ) -> list[AtroposScoredGroup]:
        """
        Build training data in Atropos format.
        
        Args:
            purpose: Specific purpose to build, or None for all
            group_size: Number of samples per group
            tokenizer: Tokenizer for encoding (optional)
            
        Returns:
            List of AtroposScoredGroups ready for training
        """
        scored_groups = []
        
        purposes_to_process = [purpose] if purpose else list(self.datasets.keys())
        
        for p in purposes_to_process:
            dataset = self.datasets[p]
            groups = dataset.get_training_groups(group_size=group_size)
            
            logger.info(f"Built {len(groups)} training groups for purpose '{p}'")
            
            for group in groups:
                scored_group = self._group_to_atropos(group, tokenizer)
                scored_groups.append(scored_group)
        
        return scored_groups
    
    def _group_to_atropos(
        self,
        group: list[PromptSample],
        tokenizer = None,
    ) -> AtroposScoredGroup:
        """Convert a group of samples to Atropos format"""
        
        tokens_list = []
        masks_list = []
        scores_list = []
        messages_list = []
        
        for sample in group:
            messages = sample.to_messages()
            messages_list.append(messages)
            
            score = sample.get_weighted_score()
            scores_list.append(score)
            
            if tokenizer:
                # Tokenize
                encoded = tokenizer.apply_chat_template(
                    messages,
                    tokenize=True,
                    return_dict=True,
                )
                tokens = encoded.get("input_ids", [])
                tokens_list.append(tokens)
                
                # Create mask (all tokens trainable for now)
                masks_list.append(tokens.copy())
            else:
                tokens_list.append([])
                masks_list.append([])
        
        # Normalize scores to mean 0
        mean_score = sum(scores_list) / len(scores_list)
        scores_list = [s - mean_score for s in scores_list]
        
        return AtroposScoredGroup(
            tokens=tokens_list,
            masks=masks_list,
            scores=scores_list,
            messages=messages_list,
        )
    
    def save_dataset(self, output_path: str, purpose: PromptPurpose | None = None) -> None:
        """Save dataset to JSON file"""
        data = {
            "metadata": {
                "created_at": datetime.now().isoformat(),
                "statistics": self.get_statistics(),
            },
            "samples": {},
        }
        
        purposes_to_save = [purpose] if purpose else list(self.datasets.keys())
        
        for p in purposes_to_save:
            dataset = self.datasets[p]
            data["samples"][p] = [
                {
                    "trajectory_id": s.trajectory_id,
                    "step_number": s.step_number,
                    "call_index": s.call_index,
                    "system_prompt": s.system_prompt,
                    "user_prompt": s.user_prompt,
                    "response": s.response,
                    "purpose": s.purpose,
                    "action_type": s.action_type,
                    "model": s.model,
                    "temperature": s.temperature,
                    # Scoring fields
                    "score": s.get_weighted_score(),
                    "trajectory_score": s.trajectory_score,
                    "step_reward": s.step_reward,
                    "attributed_reward": s.attributed_reward,
                    "action_success": s.action_success,
                    "led_to_action": s.led_to_action,
                }
                for s in dataset.samples
            ]
        
        with open(output_path, 'w') as f:
            json.dump(data, f, indent=2)
        
        logger.info(f"Saved dataset to {output_path}")


def prepare_multi_prompt_training_data(
    trajectories: list[BabylonTrajectory],
    scores: list[float],
    group_size: int = 4,
    tokenizer = None,
) -> dict[PromptPurpose, list[AtroposScoredGroup]]:
    """
    Convenience function to prepare training data from trajectories.
    
    Args:
        trajectories: List of trajectories to process
        scores: Score for each trajectory (same order)
        group_size: Number of samples per training group
        tokenizer: Tokenizer for encoding
        
    Returns:
        Dict mapping purpose to list of training groups
    """
    if len(trajectories) != len(scores):
        raise ValueError(f"Trajectory count ({len(trajectories)}) != score count ({len(scores)})")
    
    builder = MultiPromptDatasetBuilder()
    
    for traj, score in zip(trajectories, scores):
        builder.add_trajectory(traj, score)
    
    logger.info(f"Extracted {builder.total_samples} samples from {builder.total_trajectories} trajectories")
    
    result = {}
    for purpose in ['action', 'reasoning', 'evaluation', 'response']:
        groups = builder.build_training_data(purpose=purpose, group_size=group_size, tokenizer=tokenizer)
        if groups:
            result[purpose] = groups
    
    return result


class PromptTypeAnalyzer:
    """
    Analyzes which prompt types are most predictive of success.
    
    This helps understand which parts of agent reasoning to focus training on.
    """
    
    @staticmethod
    def analyze_correlation(
        trajectories: list[BabylonTrajectory],
        scores: list[float],
    ) -> dict:
        """
        Analyze correlation between prompt characteristics and trajectory scores.
        
        Returns insights about what makes prompts effective.
        """
        results = {
            "prompt_count_by_purpose": defaultdict(int),
            "avg_length_by_purpose": defaultdict(list),
            "high_score_characteristics": [],
            "low_score_characteristics": [],
        }
        
        high_score_threshold = 0.7
        low_score_threshold = 0.3
        
        for traj, score in zip(trajectories, scores):
            for step in traj.steps:
                for call in step.llm_calls:
                    results["prompt_count_by_purpose"][call.purpose] += 1
                    results["avg_length_by_purpose"][call.purpose].append(len(call.response))
                    
                    if score >= high_score_threshold:
                        results["high_score_characteristics"].append({
                            "purpose": call.purpose,
                            "response_length": len(call.response),
                            "has_reasoning": bool(call.reasoning),
                        })
                    elif score <= low_score_threshold:
                        results["low_score_characteristics"].append({
                            "purpose": call.purpose,
                            "response_length": len(call.response),
                            "has_reasoning": bool(call.reasoning),
                        })
        
        # Calculate averages
        for purpose, lengths in results["avg_length_by_purpose"].items():
            results["avg_length_by_purpose"][purpose] = sum(lengths) / len(lengths) if lengths else 0
        
        results["avg_length_by_purpose"] = dict(results["avg_length_by_purpose"])
        results["prompt_count_by_purpose"] = dict(results["prompt_count_by_purpose"])
        
        return results


def validate_training_sample(sample: PromptSample) -> tuple[bool, list[str]]:
    """
    Validate that a training sample has correct format for RL training.
    
    Checks:
    1. System prompt is not empty (agent personality)
    2. User prompt contains expected elements (context, instructions)
    3. Response is not empty and matches expected format
    4. Purpose is valid
    
    Returns:
        (is_valid, list of issues)
    """
    issues = []
    
    # Check system prompt
    if not sample.system_prompt:
        issues.append("Empty system_prompt - should contain agent personality")
    elif len(sample.system_prompt) < 50:
        issues.append(f"System prompt very short ({len(sample.system_prompt)} chars) - may be missing agent context")
    
    # Check user prompt
    if not sample.user_prompt:
        issues.append("Empty user_prompt - should contain context and instructions")
    elif len(sample.user_prompt) < 20:
        issues.append(f"User prompt very short ({len(sample.user_prompt)} chars)")
    
    # Check response format by purpose
    if not sample.response:
        issues.append("Empty response")
    else:
        if sample.purpose == 'action' and sample.action_type in ['evaluate_trading_opportunity', 'evaluate_a2a_trade']:
            # Trading actions should return JSON
            if not ('{' in sample.response and '}' in sample.response):
                issues.append("Trading action response should be JSON format")
        elif sample.purpose == 'evaluation':
            # Evaluation should typically be JSON or structured
            pass  # Can be varied
    
    # Validate purpose
    valid_purposes = ['action', 'reasoning', 'evaluation', 'response', 'other']
    if sample.purpose not in valid_purposes:
        issues.append(f"Invalid purpose '{sample.purpose}' - must be one of {valid_purposes}")
    
    return len(issues) == 0, issues


def validate_trajectory_for_training(trajectory: BabylonTrajectory) -> dict:
    """
    Validate that a trajectory has proper data for training.
    
    Returns a report with:
    - is_valid: Whether trajectory can be used for training
    - llm_call_count: Number of LLM calls
    - issues: List of problems found
    - sample_counts_by_purpose: Count of valid samples per purpose
    """
    report = {
        "trajectory_id": trajectory.trajectory_id,
        "is_valid": True,
        "llm_call_count": 0,
        "issues": [],
        "sample_counts_by_purpose": {},
    }
    
    for step in trajectory.steps:
        report["llm_call_count"] += len(step.llm_calls)
        
        for call in step.llm_calls:
            purpose = call.purpose
            if purpose not in report["sample_counts_by_purpose"]:
                report["sample_counts_by_purpose"][purpose] = {"valid": 0, "invalid": 0}
            
            # Create a temporary sample for validation
            temp_sample = PromptSample(
                trajectory_id=trajectory.trajectory_id,
                step_number=step.step_number,
                call_index=0,
                system_prompt=call.system_prompt,
                user_prompt=call.user_prompt,
                response=call.response,
                purpose=call.purpose,
                action_type=call.action_type,
                model=call.model,
                temperature=call.temperature,
                trajectory_score=0.0,
                step_reward=step.reward,
                action_success=step.action.success if step.action else False,
                environment_context={},
                previous_actions=[],
            )
            
            is_valid, issues = validate_training_sample(temp_sample)
            if is_valid:
                report["sample_counts_by_purpose"][purpose]["valid"] += 1
            else:
                report["sample_counts_by_purpose"][purpose]["invalid"] += 1
                report["issues"].extend(issues)
                report["is_valid"] = False
    
    if report["llm_call_count"] == 0:
        report["issues"].append("No LLM calls found in trajectory")
        report["is_valid"] = False
    
    return report

