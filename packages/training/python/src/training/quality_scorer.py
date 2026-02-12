"""
Quality Scorer for GRPO Training

Provides unified quality scoring that integrates:
- Format validation (think tags, action JSON)
- Length penalties (response and thinking length)
- Reasoning quality (analysis depth)
- Action execution quality

This module is the main interface for computing quality scores
that feed into the reward function.
"""

import logging
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

from .format_validator import (
    validate_response_format,
    FormatValidationResult,
)
from .action_executor import (
    ActionExecutor,
    calculate_action_quality_bonus,
)
from .scenario_pool import Scenario

logger = logging.getLogger(__name__)


# =============================================================================
# Constants
# =============================================================================


# Length penalty thresholds
THINKING_TOO_SHORT = 30  # Chars below which heavy penalty applies
THINKING_MIN_GOOD = 100  # Minimum for "good" thinking
THINKING_IDEAL_MIN = 150  # Ideal minimum
THINKING_IDEAL_MAX = 400  # Ideal maximum
THINKING_MAX_GOOD = 600  # Maximum before mild penalty
THINKING_TOO_LONG = 1000  # Above this gets penalty

RESPONSE_TOO_SHORT = 50  # Chars below which heavy penalty
RESPONSE_IDEAL_MIN = 150  # Ideal minimum
RESPONSE_IDEAL_MAX = 600  # Ideal maximum
RESPONSE_MAX_GOOD = 1000  # Maximum before mild penalty
RESPONSE_TOO_LONG = 2000  # Above this gets penalty


# =============================================================================
# Quality Score Result
# =============================================================================


@dataclass
class QualityScore:
    """
    Complete quality score for a response.
    
    Combines format, reasoning, and execution quality into
    unified scores for reward calculation.
    """
    # Core scores (0-1 range)
    format_score: float = 0.0
    reasoning_score: float = 0.0
    execution_score: float = 0.0
    
    # Length penalty (-1 to 0)
    length_penalty: float = 0.0
    
    # Component details
    has_thinking: bool = False
    has_valid_action: bool = False
    action_type: Optional[str] = None
    action_pnl: float = 0.0
    
    # Lengths
    thinking_length: int = 0
    response_length: int = 0
    
    # Issues for debugging
    issues: list = None
    
    def __post_init__(self):
        if self.issues is None:
            self.issues = []
    
    @property
    def total_score(self) -> float:
        """
        Calculate total quality score.
        
        Weighted combination:
        - Format: 40%
        - Reasoning: 30%
        - Execution: 20%
        - Length penalty: 10%
        """
        base_score = (
            self.format_score * 0.40 +
            self.reasoning_score * 0.30 +
            self.execution_score * 0.20
        )
        
        # Length penalty applied as reduction
        final = base_score + (self.length_penalty * 0.10)
        
        return max(0.0, min(1.0, final))
    
    @property
    def combined_format_score(self) -> float:
        """
        Combined format and length score for reward inputs.
        
        Applies length penalty to format score.
        """
        return max(0.0, self.format_score + self.length_penalty * 0.5)
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for logging/serialization"""
        return {
            "total_score": round(self.total_score, 3),
            "format_score": round(self.format_score, 3),
            "reasoning_score": round(self.reasoning_score, 3),
            "execution_score": round(self.execution_score, 3),
            "length_penalty": round(self.length_penalty, 3),
            "has_thinking": self.has_thinking,
            "has_valid_action": self.has_valid_action,
            "action_type": self.action_type,
            "action_pnl": round(self.action_pnl, 2),
            "thinking_length": self.thinking_length,
            "response_length": self.response_length,
            "issues": self.issues[:5],  # Limit issues in output
        }


# =============================================================================
# Length Penalty Calculation
# =============================================================================


def calculate_thinking_length_penalty(length: int) -> float:
    """
    Calculate penalty based on thinking length.
    
    Returns value from -1.0 (heavy penalty) to 0.0 (no penalty).
    
    Penalty structure:
    - < 30 chars: -0.5 (too short for meaningful thought)
    - 30-100: -0.3 (minimal thinking)
    - 100-150: -0.1 (could be better)
    - 150-400: 0.0 (ideal range)
    - 400-600: 0.0 (still good)
    - 600-1000: -0.1 (getting verbose)
    - > 1000: -0.2 (too verbose)
    """
    if length < THINKING_TOO_SHORT:
        return -0.5
    elif length < THINKING_MIN_GOOD:
        return -0.3
    elif length < THINKING_IDEAL_MIN:
        return -0.1
    elif length <= THINKING_IDEAL_MAX:
        return 0.0  # Ideal range
    elif length <= THINKING_MAX_GOOD:
        return 0.0  # Still acceptable
    elif length <= THINKING_TOO_LONG:
        return -0.1
    else:
        return -0.2


def calculate_response_length_penalty(length: int) -> float:
    """
    Calculate penalty based on total response length.
    
    Returns value from -1.0 (heavy penalty) to 0.0 (no penalty).
    """
    if length < RESPONSE_TOO_SHORT:
        return -0.4
    elif length < RESPONSE_IDEAL_MIN:
        return -0.2
    elif length <= RESPONSE_IDEAL_MAX:
        return 0.0  # Ideal range
    elif length <= RESPONSE_MAX_GOOD:
        return 0.0  # Still acceptable
    elif length <= RESPONSE_TOO_LONG:
        return -0.1
    else:
        return -0.2


def calculate_combined_length_penalty(
    thinking_length: int,
    response_length: int,
) -> float:
    """
    Calculate combined length penalty.
    
    Considers both thinking and overall response length.
    """
    thinking_penalty = calculate_thinking_length_penalty(thinking_length)
    response_penalty = calculate_response_length_penalty(response_length)
    
    # Combine penalties (weighted average)
    combined = (thinking_penalty * 0.6 + response_penalty * 0.4)
    
    return max(-1.0, combined)


# =============================================================================
# Main Scoring Functions
# =============================================================================


def score_response(
    response: str,
    scenario: Optional[Scenario] = None,
    archetype: str = "trader",
    execute_action: bool = False,
) -> QualityScore:
    """
    Score a response for quality.
    
    Args:
        response: The model's response text
        scenario: Optional scenario for action execution
        archetype: Agent archetype for scoring adjustments
        execute_action: Whether to simulate action execution
    
    Returns:
        QualityScore with all quality metrics
    """
    result = QualityScore()
    result.response_length = len(response)
    
    # Get format validation
    format_result = validate_response_format(response)
    result.format_score = format_result.format_score
    result.reasoning_score = format_result.reasoning_score
    result.has_thinking = format_result.think_tags.is_properly_paired
    result.has_valid_action = format_result.action.is_valid
    result.action_type = format_result.action.action_type
    result.thinking_length = format_result.think_tags.thinking_length
    
    # Collect issues
    result.issues.extend(format_result.think_tags.issues)
    result.issues.extend(format_result.action.issues)
    result.issues.extend(format_result.reasoning.issues)
    
    # Calculate length penalty
    result.length_penalty = calculate_combined_length_penalty(
        result.thinking_length,
        result.response_length,
    )
    
    # Calculate execution score
    if execute_action and scenario and format_result.action.parsed_action:
        executor = ActionExecutor(scenario)
        action_result = executor.execute(format_result.action.parsed_action)
        
        bonus = calculate_action_quality_bonus(action_result)
        result.execution_score = 0.5 + bonus  # Center around 0.5
        result.action_pnl = action_result.pnl
    else:
        # Base execution score for valid action format
        if result.has_valid_action:
            result.execution_score = 0.5
            if result.action_type not in [None, "wait"]:
                result.execution_score = 0.6  # Bonus for active trading
        else:
            result.execution_score = 0.2
    
    return result


def score_response_for_reward(
    response: str,
    scenario: Optional[Scenario] = None,
    archetype: str = "trader",
) -> Tuple[float, float, Dict]:
    """
    Score response and return values for reward function.
    
    Returns:
        (format_score, reasoning_score, metrics_dict)
        
    format_score and reasoning_score are in [0, 1] range.
    """
    quality = score_response(
        response,
        scenario=scenario,
        archetype=archetype,
        execute_action=scenario is not None,
    )
    
    return (
        quality.combined_format_score,
        quality.reasoning_score,
        quality.to_dict(),
    )


def get_quality_bonus_for_archetype(
    quality: QualityScore,
    archetype: str,
) -> float:
    """
    Calculate archetype-specific quality bonus.
    
    Different archetypes prioritize different aspects:
    - Trader: Prioritizes valid actions and reasoning
    - Degen: Prioritizes action (any action is good)
    - Analyst: Prioritizes deep reasoning
    - Influencer: Prioritizes format and clarity
    """
    archetype_lower = archetype.lower()
    
    if archetype_lower == "degen":
        # Degens want action over reasoning
        bonus = 0.0
        if quality.has_valid_action:
            bonus += 0.2
        if quality.action_type not in [None, "wait"]:
            bonus += 0.2  # Extra for actual trades
        if quality.has_thinking:
            bonus += 0.1
        return bonus
    
    elif archetype_lower in ("analyst", "researcher"):
        # Analysts want deep reasoning
        bonus = quality.reasoning_score * 0.4
        if quality.thinking_length > THINKING_IDEAL_MIN:
            bonus += 0.1
        if quality.has_valid_action:
            bonus += 0.1
        return bonus
    
    elif archetype_lower in ("influencer", "social-butterfly"):
        # Influencers want clear, formatted responses
        bonus = quality.format_score * 0.3
        if quality.has_thinking:
            bonus += 0.1
        if quality.length_penalty > -0.2:  # Not too verbose
            bonus += 0.1
        return bonus
    
    else:  # Default (trader, etc.)
        # Balanced approach
        bonus = quality.total_score * 0.2
        if quality.has_valid_action and quality.has_thinking:
            bonus += 0.1
        return bonus


# =============================================================================
# Batch Scoring
# =============================================================================


def score_response_batch(
    responses: list,
    scenario: Optional[Scenario] = None,
    archetype: str = "trader",
) -> list:
    """
    Score a batch of responses.
    
    Returns list of QualityScore objects.
    """
    return [
        score_response(r, scenario, archetype, execute_action=False)
        for r in responses
    ]


def get_relative_quality_scores(scores: list) -> list:
    """
    Convert absolute scores to relative scores.
    
    Centers scores around mean for GRPO training.
    """
    if not scores:
        return []
    
    total_scores = [s.total_score for s in scores]
    mean = sum(total_scores) / len(total_scores)
    
    return [s - mean for s in total_scores]

