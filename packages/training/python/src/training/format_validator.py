"""
Format Validator for LLM Responses

Validates and scores response format quality for GRPO training.

Scoring dimensions:
1. Think Tag Validation - Proper use of <think>...</think> tags
2. Action JSON Validation - Valid JSON with required fields
3. Length Analysis - Appropriate response/thinking lengths
4. Structure Quality - Overall response organization

The scores feed into the reward function to encourage:
- Structured reasoning before action
- Valid, executable action format
- Appropriate verbosity (not too short, not too long)
"""

import json
import re
import logging
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# =============================================================================
# Constants
# =============================================================================


# Think tag patterns
THINK_TAG_OPEN = re.compile(r'<think>', re.IGNORECASE)
THINK_TAG_CLOSE = re.compile(r'</think>', re.IGNORECASE)
THINK_TAG_FULL = re.compile(r'<think>(.*?)</think>', re.IGNORECASE | re.DOTALL)

# Length thresholds
MIN_THINKING_LENGTH = 50  # Minimum chars for meaningful reasoning
IDEAL_THINKING_MIN = 100  # Ideal minimum
IDEAL_THINKING_MAX = 500  # Ideal maximum
MAX_THINKING_LENGTH = 1000  # Maximum before penalty

MIN_RESPONSE_LENGTH = 30  # Minimum viable response
IDEAL_RESPONSE_MIN = 100  # Ideal minimum
IDEAL_RESPONSE_MAX = 800  # Ideal maximum
MAX_RESPONSE_LENGTH = 2000  # Maximum before penalty

# Action validation
VALID_ACTION_TYPES = {
    "buy", "sell",
    "open_perp", "close_perp",
    "wait",
    "trade", "predict",
    "post", "create_post",
    "send_dm", "dm",
    "research", "analyze",
}

# Reasoning quality terms
ANALYSIS_TERMS = {
    "price", "volume", "trend", "momentum", "bullish", "bearish",
    "risk", "position", "market", "funding", "probability", "sentiment",
    "support", "resistance", "breakout", "consolidation",
}

DECISION_TERMS = {
    "because", "therefore", "since", "given", "considering",
    "based on", "due to", "hence", "thus", "consequently",
}

RISK_TERMS = {
    "risk", "downside", "stop", "loss", "careful", "conservative",
    "exposure", "hedge", "limit", "protect", "cautious",
}

NUMERICAL_PATTERN = re.compile(r'\d+\.?\d*%?')


# =============================================================================
# Validation Results
# =============================================================================


@dataclass
class ThinkTagResult:
    """Result of think tag validation"""
    has_open_tag: bool = False
    has_close_tag: bool = False
    is_properly_paired: bool = False
    thinking_content: str = ""
    thinking_length: int = 0
    tag_count: int = 0
    issues: List[str] = None
    
    def __post_init__(self):
        if self.issues is None:
            self.issues = []
    
    @property
    def is_valid(self) -> bool:
        return self.is_properly_paired and len(self.issues) == 0
    
    @property
    def score(self) -> float:
        """Calculate format score for think tags (0-1)"""
        if not self.has_open_tag and not self.has_close_tag:
            return 0.0  # No thinking at all
        
        if not self.is_properly_paired:
            return 0.2  # Has tags but malformed
        
        # Base score for proper tags
        score = 0.5
        
        # Length-based adjustments
        if self.thinking_length >= MIN_THINKING_LENGTH:
            score += 0.2
        if self.thinking_length >= IDEAL_THINKING_MIN:
            score += 0.15
        if self.thinking_length > MAX_THINKING_LENGTH:
            score -= 0.1  # Too verbose
        
        # Penalty for issues
        score -= len(self.issues) * 0.1
        
        return max(0.0, min(1.0, score))


@dataclass
class ActionValidationResult:
    """Result of action JSON validation"""
    has_action: bool = False
    is_valid_json: bool = False
    action_type: Optional[str] = None
    is_known_action: bool = False
    has_required_fields: bool = False
    raw_json: str = ""
    parsed_action: Optional[Dict] = None
    issues: List[str] = None
    
    def __post_init__(self):
        if self.issues is None:
            self.issues = []
    
    @property
    def is_valid(self) -> bool:
        return self.has_action and self.is_valid_json and self.is_known_action
    
    @property
    def score(self) -> float:
        """Calculate format score for action (0-1)"""
        if not self.has_action:
            return 0.0
        
        if not self.is_valid_json:
            return 0.2  # Attempted but failed
        
        score = 0.4  # Base for valid JSON
        
        if self.is_known_action:
            score += 0.3
        
        if self.has_required_fields:
            score += 0.2
        
        # Penalty for issues
        score -= len(self.issues) * 0.1
        
        return max(0.0, min(1.0, score))


@dataclass
class ReasoningQualityResult:
    """Result of reasoning quality analysis"""
    analysis_term_count: int = 0
    decision_term_count: int = 0
    risk_term_count: int = 0
    numerical_count: int = 0
    has_market_analysis: bool = False
    has_decision_justification: bool = False
    has_risk_consideration: bool = False
    issues: List[str] = None
    
    def __post_init__(self):
        if self.issues is None:
            self.issues = []
    
    @property
    def score(self) -> float:
        """Calculate reasoning quality score (0-1)"""
        score = 0.0
        
        # Analysis terms
        score += min(0.3, self.analysis_term_count * 0.03)
        
        # Decision justification
        if self.has_decision_justification:
            score += 0.2
        
        # Risk consideration
        if self.has_risk_consideration:
            score += 0.2
        
        # Numerical analysis
        if self.numerical_count > 2:
            score += 0.15
        elif self.numerical_count > 0:
            score += 0.1
        
        # Market-specific analysis
        if self.has_market_analysis:
            score += 0.15
        
        return max(0.0, min(1.0, score))


@dataclass
class LengthAnalysisResult:
    """Result of length analysis"""
    total_length: int = 0
    thinking_length: int = 0
    action_length: int = 0
    is_too_short: bool = False
    is_too_long: bool = False
    thinking_is_too_short: bool = False
    thinking_is_too_long: bool = False
    
    @property
    def score(self) -> float:
        """Calculate length appropriateness score (0-1)"""
        score = 1.0
        
        if self.is_too_short:
            score -= 0.4
        if self.is_too_long:
            score -= 0.2
        if self.thinking_is_too_short:
            score -= 0.2
        if self.thinking_is_too_long:
            score -= 0.1
        
        return max(0.0, score)


@dataclass
class FormatValidationResult:
    """Complete format validation result"""
    think_tags: ThinkTagResult
    action: ActionValidationResult
    reasoning: ReasoningQualityResult
    length: LengthAnalysisResult
    
    @property
    def format_score(self) -> float:
        """
        Calculate overall format score (0-1).
        
        Weighted combination:
        - Think tags: 35%
        - Action: 35%
        - Length: 15%
        - Reasoning structure: 15%
        """
        return (
            self.think_tags.score * 0.35 +
            self.action.score * 0.35 +
            self.length.score * 0.15 +
            self.reasoning.score * 0.15
        )
    
    @property
    def reasoning_score(self) -> float:
        """
        Calculate reasoning quality score (0-1).
        
        Based primarily on thinking content quality.
        """
        return self.reasoning.score
    
    @property
    def is_valid(self) -> bool:
        """Check if response has valid format"""
        return (
            self.think_tags.is_valid and
            self.action.is_valid and
            not self.length.is_too_short
        )
    
    def get_summary(self) -> Dict:
        """Get summary of validation results"""
        return {
            "format_score": round(self.format_score, 3),
            "reasoning_score": round(self.reasoning_score, 3),
            "think_tag_score": round(self.think_tags.score, 3),
            "action_score": round(self.action.score, 3),
            "length_score": round(self.length.score, 3),
            "has_thinking": self.think_tags.is_properly_paired,
            "has_valid_action": self.action.is_valid,
            "action_type": self.action.action_type,
            "thinking_length": self.think_tags.thinking_length,
            "total_length": self.length.total_length,
            "issues": (
                self.think_tags.issues +
                self.action.issues +
                self.reasoning.issues
            ),
        }


# =============================================================================
# Validators
# =============================================================================


def validate_think_tags(response: str) -> ThinkTagResult:
    """
    Validate think tag usage in response.
    
    Checks:
    - Presence of opening and closing tags
    - Proper pairing and nesting
    - Content between tags
    """
    result = ThinkTagResult()
    
    # Find all opening tags
    open_matches = list(THINK_TAG_OPEN.finditer(response))
    close_matches = list(THINK_TAG_CLOSE.finditer(response))
    
    result.has_open_tag = len(open_matches) > 0
    result.has_close_tag = len(close_matches) > 0
    result.tag_count = len(open_matches) + len(close_matches)
    
    # Check for mismatched counts
    if len(open_matches) != len(close_matches):
        result.issues.append(f"Mismatched tags: {len(open_matches)} open, {len(close_matches)} close")
    
    # Extract content using full pattern
    full_matches = THINK_TAG_FULL.findall(response)
    
    if full_matches:
        result.is_properly_paired = True
        result.thinking_content = "\n".join(full_matches)
        result.thinking_length = len(result.thinking_content.strip())
        
        # Check for empty thinking
        if result.thinking_length < 10:
            result.issues.append("Thinking content is too short")
    elif result.has_open_tag and result.has_close_tag:
        # Tags exist but content extraction failed
        result.issues.append("Tags found but content extraction failed")
    
    # Check for nested tags (not supported)
    if len(open_matches) > 1:
        result.issues.append("Multiple think tag pairs detected")
    
    # Check tag order
    if result.has_open_tag and result.has_close_tag:
        first_open = open_matches[0].start() if open_matches else 0
        first_close = close_matches[0].start() if close_matches else 0
        if first_close < first_open:
            result.issues.append("Closing tag before opening tag")
    
    return result


def validate_action_json(response: str) -> ActionValidationResult:
    """
    Validate action JSON in response.
    
    Extracts JSON and validates structure.
    """
    result = ActionValidationResult()
    
    # Try to extract JSON after </think> tag first
    json_text = response
    if "</think>" in response.lower():
        parts = response.lower().split("</think>")
        if len(parts) >= 2:
            # Use original case for JSON extraction
            think_end = response.lower().rfind("</think>") + len("</think>")
            json_text = response[think_end:].strip()
    
    # Find JSON object
    json_match = re.search(r'\{[^{}]*\}', json_text)
    if not json_match:
        # Try full response
        json_match = re.search(r'\{[^{}]*\}', response)
    
    if json_match:
        result.raw_json = json_match.group()
        result.has_action = True
        
        try:
            parsed = json.loads(result.raw_json)
            result.is_valid_json = True
            result.parsed_action = parsed
            
            # Check for action field
            action_type = parsed.get("action")
            if action_type:
                result.action_type = str(action_type).lower()
                result.is_known_action = result.action_type in VALID_ACTION_TYPES
                
                if not result.is_known_action:
                    result.issues.append(f"Unknown action type: {result.action_type}")
                
                # Check required fields
                result.has_required_fields = _check_action_fields(result.action_type, parsed)
                
                if not result.has_required_fields:
                    result.issues.append(f"Missing required fields for {result.action_type}")
            else:
                result.issues.append("JSON missing 'action' field")
        
        except json.JSONDecodeError as e:
            result.issues.append(f"JSON parse error: {str(e)[:50]}")
    else:
        result.issues.append("No JSON object found in response")
    
    return result


def _check_action_fields(action_type: str, parsed: Dict) -> bool:
    """Check if required fields are present for action type"""
    required_fields = {
        "buy": ["market", "amount"],
        "sell": ["market", "amount"],
        "open_perp": ["ticker", "size", "direction"],
        "close_perp": ["ticker", "size"],
        "wait": [],
        "trade": ["market"],
        "predict": ["market"],
        "post": ["content"],
        "create_post": ["content"],
        "send_dm": ["recipient"],
        "dm": ["recipient"],
        "research": [],
        "analyze": [],
    }
    
    fields_needed = required_fields.get(action_type, [])
    return all(field in parsed for field in fields_needed)


def analyze_reasoning_quality(thinking_content: str) -> ReasoningQualityResult:
    """
    Analyze quality of reasoning in thinking content.
    
    Checks for presence of analysis terms, justifications, and risk awareness.
    """
    result = ReasoningQualityResult()
    
    if not thinking_content:
        return result
    
    content_lower = thinking_content.lower()
    
    # Count analysis terms
    for term in ANALYSIS_TERMS:
        if term in content_lower:
            result.analysis_term_count += 1
    
    # Check decision terms
    for term in DECISION_TERMS:
        if term in content_lower:
            result.decision_term_count += 1
    result.has_decision_justification = result.decision_term_count > 0
    
    # Check risk terms
    for term in RISK_TERMS:
        if term in content_lower:
            result.risk_term_count += 1
    result.has_risk_consideration = result.risk_term_count > 0
    
    # Count numerical references
    numbers = NUMERICAL_PATTERN.findall(thinking_content)
    result.numerical_count = len(numbers)
    
    # Check for market-specific analysis
    market_terms = {"btc", "eth", "bitcoin", "ethereum", "crypto", "stock", "market"}
    result.has_market_analysis = any(term in content_lower for term in market_terms)
    
    # Quality issues
    if result.analysis_term_count < 2:
        result.issues.append("Limited market analysis vocabulary")
    
    if not result.has_decision_justification:
        result.issues.append("No decision justification phrases")
    
    return result


def analyze_length(
    response: str,
    thinking_content: str,
    action_json: str,
) -> LengthAnalysisResult:
    """
    Analyze response length characteristics.
    """
    result = LengthAnalysisResult()
    
    result.total_length = len(response)
    result.thinking_length = len(thinking_content)
    result.action_length = len(action_json)
    
    # Check total length
    result.is_too_short = result.total_length < MIN_RESPONSE_LENGTH
    result.is_too_long = result.total_length > MAX_RESPONSE_LENGTH
    
    # Check thinking length
    result.thinking_is_too_short = result.thinking_length < MIN_THINKING_LENGTH
    result.thinking_is_too_long = result.thinking_length > MAX_THINKING_LENGTH
    
    return result


# =============================================================================
# Main Validation Function
# =============================================================================


def validate_response_format(response: str) -> FormatValidationResult:
    """
    Validate complete response format.
    
    Performs all validation checks and returns comprehensive result.
    """
    # Validate think tags
    think_result = validate_think_tags(response)
    
    # Validate action JSON
    action_result = validate_action_json(response)
    
    # Analyze reasoning quality
    reasoning_result = analyze_reasoning_quality(think_result.thinking_content)
    
    # Analyze length
    length_result = analyze_length(
        response,
        think_result.thinking_content,
        action_result.raw_json,
    )
    
    return FormatValidationResult(
        think_tags=think_result,
        action=action_result,
        reasoning=reasoning_result,
        length=length_result,
    )


def get_format_and_reasoning_scores(response: str) -> Tuple[float, float]:
    """
    Convenience function to get format and reasoning scores.
    
    Returns:
        (format_score, reasoning_score) both in range [0, 1]
    """
    result = validate_response_format(response)
    return result.format_score, result.reasoning_score


def validate_for_training(response: str) -> Dict:
    """
    Validate response format for training reward calculation.
    
    Returns dict compatible with reward function inputs.
    """
    result = validate_response_format(response)
    summary = result.get_summary()
    
    return {
        "format_score": summary["format_score"],
        "reasoning_score": summary["reasoning_score"],
        "has_thinking": summary["has_thinking"],
        "has_valid_action": summary["has_valid_action"],
        "action_type": summary["action_type"],
        "thinking_length": summary["thinking_length"],
        "issues": summary["issues"],
    }


