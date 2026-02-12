"""
Tick Reward Attribution

A single agent tick may contain multiple LLM calls with different purposes:
1. REASONING - Analysis and planning (should I trade?)
2. ACTION - Decision making (what trade to make?)
3. RESPONSE - Communication (what to say?)
4. EVALUATION - Self-assessment (how did I do?)

The global tick reward needs to be attributed back to individual calls
to train each prompt type effectively.

This module implements credit assignment from tick outcomes to individual LLM calls.
"""

import logging
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


class CallPurpose(str, Enum):
    """Purpose categories for LLM calls within a tick"""
    REASONING = "reasoning"
    ACTION = "action"  
    RESPONSE = "response"
    EVALUATION = "evaluation"
    OTHER = "other"


@dataclass
class LLMCallRecord:
    """Record of a single LLM call within a tick"""
    call_index: int
    purpose: CallPurpose
    action_type: str | None  # e.g., 'evaluate_trading_opportunity', 'execute_response'
    
    # The actual prompts
    system_prompt: str
    user_prompt: str
    response: str
    
    # Model info
    model: str
    temperature: float
    max_tokens: int
    latency_ms: int
    
    # Outcome tracking
    led_to_action: bool = False  # Did this call lead to an action?
    action_success: bool | None = None  # If led to action, was it successful?
    
    # Attributed reward (calculated by TickRewardAttributor)
    attributed_reward: float = 0.0


@dataclass
class TickOutcome:
    """Outcome of a complete tick"""
    tick_number: int
    
    # Financial outcome
    pnl_delta: float  # Change in P&L this tick
    balance_delta: float  # Change in balance
    
    # Action outcomes
    trades_executed: int
    trades_successful: int
    trades_failed: int
    
    # Social outcomes (for response calls)
    posts_created: int
    responses_sent: int
    engagement_received: int  # likes, replies, etc.
    
    # Overall quality signals
    action_count: int
    wait_count: int  # Ticks where agent chose to wait
    error_count: int


@dataclass
class TickData:
    """Complete data for a single tick with multiple LLM calls"""
    tick_number: int
    timestamp: int
    agent_id: str
    
    # All LLM calls made during this tick
    llm_calls: list[LLMCallRecord] = field(default_factory=list)
    
    # Final outcome
    outcome: TickOutcome | None = None
    
    # Global tick reward (from environment or judge)
    global_reward: float = 0.0


class TickRewardAttributor:
    """
    Attributes global tick reward to individual LLM calls.
    
    The key insight is that different call types contribute differently:
    - REASONING calls set up the decision (credit if action succeeds)
    - ACTION calls make the decision (direct credit from outcome)
    - RESPONSE calls handle communication (credit from social metrics)
    - EVALUATION calls assess performance (credit from accuracy)
    """
    
    def __init__(
        self,
        reasoning_weight: float = 0.25,
        action_weight: float = 0.50,
        response_weight: float = 0.15,
        evaluation_weight: float = 0.10,
    ):
        """
        Initialize with weights for each call type.
        
        Args:
            reasoning_weight: Fraction of action reward attributed to reasoning
            action_weight: Fraction attributed to action decision
            response_weight: Fraction attributed to response generation
            evaluation_weight: Fraction attributed to self-evaluation
        """
        self.weights = {
            CallPurpose.REASONING: reasoning_weight,
            CallPurpose.ACTION: action_weight,
            CallPurpose.RESPONSE: response_weight,
            CallPurpose.EVALUATION: evaluation_weight,
            CallPurpose.OTHER: 0.0,
        }
        
        # Validate weights sum to ~1.0
        total = sum(self.weights.values())
        if abs(total - 1.0) > 0.01:
            logger.warning(f"Reward weights sum to {total}, normalizing...")
            for k in self.weights:
                self.weights[k] /= total
    
    def attribute_rewards(self, tick: TickData) -> list[LLMCallRecord]:
        """
        Attribute the global tick reward to individual LLM calls.
        
        The attribution strategy:
        1. Calculate base reward per call type
        2. Adjust based on call-specific outcomes
        3. Apply temporal credit (earlier calls that led to success get more)
        
        Returns:
            List of LLM calls with attributed_reward set
        """
        if not tick.llm_calls:
            return []
        
        if tick.outcome is None:
            # No outcome yet, can't attribute
            for call in tick.llm_calls:
                call.attributed_reward = 0.0
            return tick.llm_calls
        
        global_reward = tick.global_reward
        outcome = tick.outcome
        
        # Group calls by purpose
        calls_by_purpose: dict[CallPurpose, list[LLMCallRecord]] = {
            purpose: [] for purpose in CallPurpose
        }
        for call in tick.llm_calls:
            calls_by_purpose[call.purpose].append(call)
        
        # Calculate base reward pool for each purpose
        purpose_rewards: dict[CallPurpose, float] = {}
        
        for purpose, weight in self.weights.items():
            calls = calls_by_purpose[purpose]
            if not calls:
                continue
            
            # Base reward from global reward
            base_reward = global_reward * weight
            
            # Adjust based on purpose-specific outcomes
            if purpose == CallPurpose.ACTION:
                # Action calls get reward based on trade success
                if outcome.trades_executed > 0:
                    success_rate = outcome.trades_successful / outcome.trades_executed
                    base_reward *= (0.5 + 0.5 * success_rate)  # Scale by success
                    
                    # Bonus for P&L
                    pnl_bonus = min(1.0, max(-1.0, outcome.pnl_delta / 100.0))
                    base_reward += pnl_bonus * 0.2 * abs(global_reward)
            
            elif purpose == CallPurpose.RESPONSE:
                # Response calls get reward based on engagement
                if outcome.responses_sent > 0:
                    engagement_rate = min(1.0, outcome.engagement_received / (outcome.responses_sent * 5))
                    base_reward *= (0.5 + 0.5 * engagement_rate)
            
            elif purpose == CallPurpose.REASONING:
                # Reasoning calls share credit with action outcomes
                if outcome.trades_executed > 0:
                    success_rate = outcome.trades_successful / outcome.trades_executed
                    base_reward *= success_rate  # Reasoning credited by action success
            
            purpose_rewards[purpose] = base_reward
        
        # Distribute rewards to individual calls
        for purpose, calls in calls_by_purpose.items():
            if not calls:
                continue
            
            total_reward = purpose_rewards.get(purpose, 0.0)
            
            # Apply temporal credit: later calls in successful sequences get more
            for i, call in enumerate(calls):
                # Base share
                share = total_reward / len(calls)
                
                # Temporal adjustment
                if call.led_to_action and call.action_success:
                    # This call led to successful action - boost it
                    share *= 1.2
                elif call.led_to_action and call.action_success is False:
                    # This call led to failed action - reduce it
                    share *= 0.6
                
                call.attributed_reward = share
        
        return tick.llm_calls
    
    def attribute_batch(self, ticks: list[TickData]) -> list[TickData]:
        """
        Attribute rewards for a batch of ticks.
        
        Also applies relative normalization across the batch for GRPO.
        """
        # First pass: attribute individual rewards
        for tick in ticks:
            self.attribute_rewards(tick)
        
        # Second pass: normalize within purpose groups for GRPO
        # Group all calls by purpose across batch
        all_calls_by_purpose: dict[CallPurpose, list[LLMCallRecord]] = {
            purpose: [] for purpose in CallPurpose
        }
        
        for tick in ticks:
            for call in tick.llm_calls:
                all_calls_by_purpose[call.purpose].append(call)
        
        # Normalize each purpose group to mean 0 (for GRPO)
        for purpose, calls in all_calls_by_purpose.items():
            if len(calls) < 2:
                continue
            
            rewards = [c.attributed_reward for c in calls]
            mean_reward = sum(rewards) / len(rewards)
            
            for call in calls:
                call.attributed_reward -= mean_reward
        
        return ticks


def build_training_samples_from_tick(
    tick: TickData,
    trajectory_id: str,
    trajectory_score: float,
) -> list[dict]:
    """
    Build training samples from a tick with attributed rewards.
    
    Each LLM call becomes a separate training sample with:
    - The original prompt/response
    - Attributed reward from tick outcome
    - Context about what happened
    """
    samples = []
    
    for call in tick.llm_calls:
        sample = {
            "trajectory_id": trajectory_id,
            "tick_number": tick.tick_number,
            "call_index": call.call_index,
            "purpose": call.purpose.value,
            "action_type": call.action_type,
            
            # The actual training data
            "messages": [
                {"role": "system", "content": call.system_prompt},
                {"role": "user", "content": call.user_prompt},
                {"role": "assistant", "content": call.response},
            ],
            
            # Reward signals
            "tick_reward": tick.global_reward,
            "attributed_reward": call.attributed_reward,
            "trajectory_score": trajectory_score,
            
            # Outcome context
            "led_to_action": call.led_to_action,
            "action_success": call.action_success,
            
            # Model info for analysis
            "model": call.model,
            "temperature": call.temperature,
        }
        
        samples.append(sample)
    
    return samples


def group_samples_for_grpo(
    samples: list[dict],
    group_size: int = 4,
    min_variance: float = 0.01,
) -> list[list[dict]]:
    """
    Group samples by purpose for GRPO training.
    
    Returns groups where samples have the same purpose but
    different attributed rewards (for relative comparison).
    """
    # Group by purpose
    by_purpose: dict[str, list[dict]] = {}
    for sample in samples:
        purpose = sample["purpose"]
        if purpose not in by_purpose:
            by_purpose[purpose] = []
        by_purpose[purpose].append(sample)
    
    groups = []
    
    for purpose, purpose_samples in by_purpose.items():
        if len(purpose_samples) < group_size:
            continue
        
        # Sort by attributed reward
        sorted_samples = sorted(
            purpose_samples,
            key=lambda s: s["attributed_reward"]
        )
        
        # Create groups with variance
        n = len(sorted_samples)
        for i in range(0, n - group_size + 1, group_size // 2):
            group = []
            step = n // group_size
            
            for j in range(group_size):
                idx = min(i + j * step, n - 1)
                group.append(sorted_samples[idx])
            
            # Check variance
            rewards = [s["attributed_reward"] for s in group]
            mean_r = sum(rewards) / len(rewards)
            variance = sum((r - mean_r) ** 2 for r in rewards) / len(rewards)
            
            if variance >= min_variance:
                groups.append(group)
    
    return groups


# Example of how Eliza prompt structure maps to our training:
"""
ELIZA MESSAGE HANDLER (single tick, multiple outputs):

Input:
  <task>Generate dialog and actions for {{agentName}}</task>
  <providers>{{providers}}</providers>
  
Output:
  <response>
    <thought>Your thought here</thought>          <- PURPOSE: reasoning
    <actions>ACTION1,ACTION2</actions>            <- PURPOSE: action
    <providers>PROVIDER1,PROVIDER2</providers>    <- metadata
    <text>Your response text here</text>          <- PURPOSE: response
  </response>

In RL training, we break this into 3 training samples:
1. REASONING sample: Input -> <thought>...</thought>
   Reward: Attributed based on whether actions succeeded
   
2. ACTION sample: Input + thought context -> <actions>...</actions>
   Reward: Direct from action outcome (P&L, success)
   
3. RESPONSE sample: Input + thought + actions -> <text>...</text>
   Reward: From social engagement metrics

This allows the model to learn:
- Better reasoning that leads to good actions
- Better action selection given good reasoning
- Better responses given successful actions
"""

