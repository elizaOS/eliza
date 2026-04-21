"""
Answer evaluation for the Reasoning Gym.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from elizaos_atropos_reasoning.types import Answer, Problem

if TYPE_CHECKING:
    pass


def normalize_answer(answer: Answer) -> str:
    """
    Normalize an answer for comparison.
    
    Args:
        answer: The answer to normalize
        
    Returns:
        Normalized string representation
    """
    if isinstance(answer, bool):
        return "yes" if answer else "no"

    if isinstance(answer, (int, float)):
        # Handle numeric answers
        if isinstance(answer, float) and answer.is_integer():
            return str(int(answer))
        return str(answer)

    if isinstance(answer, list):
        return ", ".join(normalize_answer(a) for a in answer)

    # String answer - normalize
    text = str(answer).lower().strip()

    # Remove common prefixes
    prefixes = ["the answer is", "answer:", "solution:", "result:"]
    for prefix in prefixes:
        if text.startswith(prefix):
            text = text[len(prefix):].strip()

    # Normalize yes/no/true/false
    if text in ("yes", "true", "correct", "y"):
        return "yes"
    if text in ("no", "false", "incorrect", "n"):
        return "no"

    # Remove punctuation and extra whitespace
    text = re.sub(r"[^\w\s/]", "", text)
    text = " ".join(text.split())

    return text


def evaluate_answer(
    response: Answer,
    expected: Answer,
    problem: Problem | None = None,
) -> tuple[bool, str]:
    """
    Evaluate if a response matches the expected answer.
    
    Args:
        response: The given response
        expected: The expected answer
        problem: Optional problem for context-aware evaluation
        
    Returns:
        Tuple of (is_correct, feedback)
    """
    # Normalize both answers
    norm_response = normalize_answer(response)
    norm_expected = normalize_answer(expected)

    # Direct match
    if norm_response == norm_expected:
        return True, "Correct!"

    # Numeric comparison (handle floating point)
    try:
        resp_num = float(norm_response.replace(",", ""))
        exp_num = float(norm_expected.replace(",", ""))
        if abs(resp_num - exp_num) < 1e-6:
            return True, "Correct!"
    except (ValueError, AttributeError):
        pass

    # Fraction comparison
    if "/" in norm_response and "/" in norm_expected:
        try:
            r_parts = norm_response.split("/")
            e_parts = norm_expected.split("/")
            r_val = float(r_parts[0]) / float(r_parts[1])
            e_val = float(e_parts[0]) / float(e_parts[1])
            if abs(r_val - e_val) < 1e-6:
                return True, "Correct!"
        except (ValueError, IndexError):
            pass

    # Check for answer contained in response
    if norm_expected in norm_response:
        return True, "Correct! (Answer found in response)"

    # Partial credit for close answers
    if problem and problem.task_type.value == "math":
        try:
            resp_num = float(re.sub(r"[^\d.-]", "", norm_response))
            exp_num = float(re.sub(r"[^\d.-]", "", norm_expected))
            if abs(resp_num - exp_num) / max(abs(exp_num), 1) < 0.1:
                return False, f"Close! Expected {expected}, got {response}"
        except (ValueError, AttributeError):
            pass

    return False, f"Incorrect. Expected: {expected}"


def extract_answer_from_text(text: str) -> str:
    """
    Extract an answer from a longer text response.
    
    Args:
        text: The text containing an answer
        
    Returns:
        Extracted answer
    """
    text = text.strip()

    # Look for explicit answer markers
    patterns = [
        r"(?:the\s+)?answer\s+is[:\s]+(.+?)(?:\.|$)",
        r"(?:final\s+)?answer[:\s]+(.+?)(?:\.|$)",
        r"therefore[,:\s]+(.+?)(?:\.|$)",
        r"so[,:\s]+(.+?)(?:\.|$)",
        r"=\s*(.+?)(?:\.|$)",
    ]

    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1).strip()

    # If no pattern found, try to extract last number or last line
    numbers = re.findall(r"-?\d+(?:\.\d+)?(?:/\d+)?", text)
    if numbers:
        return numbers[-1]

    # Last non-empty line
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    if lines:
        return lines[-1]

    return text
