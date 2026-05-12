"""
BFCL Relevance Evaluator

Evaluates whether the model correctly identifies when no function applies
to a given query (relevance detection).
"""

from __future__ import annotations

import logging
from typing import Optional

from benchmarks.bfcl.types import FunctionCall

logger = logging.getLogger(__name__)


class RelevanceEvaluator:
    """
    Evaluate function relevance detection.

    Tests whether the model correctly:
    - Makes function calls when functions ARE relevant
    - Declines to call functions when they are NOT relevant
    """

    # Common phrases indicating the model declined to use functions
    DECLINE_INDICATORS = [
        "cannot",
        "can't",
        "unable to",
        "no function",
        "no available",
        "not applicable",
        "no matching",
        "don't have",
        "do not have",
        "not possible",
        "none of the",
        "irrelevant",
        "not relevant",
        "outside the scope",
        "beyond my capabilities",
    ]

    def __init__(
        self,
        require_explicit_decline: bool = False,
        decline_keywords: Optional[list[str]] = None,
    ):
        """
        Initialize relevance evaluator.

        Args:
            require_explicit_decline: If True, require explicit decline message
                                     for irrelevant queries
            decline_keywords: Custom keywords indicating function decline
        """
        self.require_explicit_decline = require_explicit_decline
        self.decline_keywords = decline_keywords or self.DECLINE_INDICATORS

    def evaluate(
        self,
        predicted_calls: list[FunctionCall],
        is_relevant: bool,
        response_text: Optional[str] = None,
    ) -> bool:
        """
        Check if model correctly identified relevance.

        Args:
            predicted_calls: Function calls made by the model
            is_relevant: True if functions ARE relevant to the query
            response_text: Optional raw response text for decline detection

        Returns:
            True if relevance detection is correct
        """
        made_calls = len(predicted_calls) > 0

        if is_relevant:
            # Functions are relevant - model should make calls
            return made_calls
        else:
            # Functions are NOT relevant - model should decline
            if made_calls:
                return False

            # If requiring explicit decline, check response text
            if self.require_explicit_decline and response_text:
                return self._has_decline_indicator(response_text)

            # No calls made = correct for irrelevant case
            return True

    def _has_decline_indicator(self, text: str) -> bool:
        """Check if response text contains decline indicators."""
        text_lower = text.lower()
        return any(indicator in text_lower for indicator in self.decline_keywords)

    def evaluate_with_confidence(
        self,
        predicted_calls: list[FunctionCall],
        is_relevant: bool,
        response_text: Optional[str] = None,
    ) -> tuple[bool, float, str]:
        """
        Evaluate relevance with confidence score and reasoning.

        Args:
            predicted_calls: Function calls made by the model
            is_relevant: True if functions ARE relevant to the query
            response_text: Optional raw response text

        Returns:
            Tuple of (correct, confidence, reasoning)
        """
        made_calls = len(predicted_calls) > 0
        correct = self.evaluate(predicted_calls, is_relevant, response_text)

        if is_relevant:
            if made_calls:
                confidence = 1.0
                reasoning = "Correctly made function calls for relevant query"
            else:
                confidence = 0.0
                reasoning = "Failed to make function calls for relevant query"
        else:
            if made_calls:
                confidence = 0.0
                reasoning = f"Incorrectly made {len(predicted_calls)} function call(s) for irrelevant query"
            else:
                # Check for explicit decline
                has_decline = (
                    response_text is not None and
                    self._has_decline_indicator(response_text)
                )
                if has_decline:
                    confidence = 1.0
                    reasoning = "Correctly declined with explicit explanation"
                else:
                    confidence = 0.8  # Correct but no explicit decline
                    reasoning = "Correctly made no calls, but no explicit decline"

        return correct, confidence, reasoning

    def get_decline_analysis(
        self,
        response_text: str,
    ) -> dict[str, bool | int | list[str]]:
        """
        Analyze response text for decline patterns.

        Args:
            response_text: The model's response text

        Returns:
            Dict with analysis results
        """
        text_lower = response_text.lower()
        found_indicators = [
            indicator
            for indicator in self.decline_keywords
            if indicator in text_lower
        ]

        return {
            "has_decline": len(found_indicators) > 0,
            "found_indicators": found_indicators,
            "response_length": len(response_text),
        }
