"""
BFCL AST Evaluator

Evaluates the Abstract Syntax Tree (structural) correctness of function calls.
Compares predicted function calls against expected calls with flexible matching.
"""

from __future__ import annotations

import logging
import math
from typing import Optional

from benchmarks.bfcl.types import ArgumentValue, FunctionCall, ResultDetails

logger = logging.getLogger(__name__)


class ASTEvaluator:
    """
    Evaluate function call AST correctness.

    Handles:
    - Function name matching
    - Argument name matching
    - Type coercion (string "1" vs int 1)
    - Optional parameter handling
    - Argument ordering (order-independent)
    """

    def __init__(
        self,
        strict_type_matching: bool = False,
        ignore_extra_args: bool = False,
        case_sensitive_names: bool = False,
    ):
        """
        Initialize AST evaluator.

        Args:
            strict_type_matching: If True, types must match exactly
            ignore_extra_args: If True, extra predicted arguments are ignored
            case_sensitive_names: If True, function/arg names are case-sensitive
        """
        self.strict_type_matching = strict_type_matching
        self.ignore_extra_args = ignore_extra_args
        self.case_sensitive_names = case_sensitive_names

    def evaluate(
        self,
        predicted: list[FunctionCall],
        expected: list[FunctionCall],
    ) -> bool:
        """
        Compare predicted and expected function calls.

        For parallel calls, order doesn't matter.
        For single calls, direct comparison.

        Args:
            predicted: List of predicted function calls
            expected: List of expected function calls

        Returns:
            True if AST matches, False otherwise
        """
        if len(predicted) != len(expected):
            return False

        if len(predicted) == 0:
            return True

        if len(predicted) == 1:
            return self._calls_match(predicted[0], expected[0])

        # For multiple calls, try to match each predicted to an expected
        return self._match_parallel_calls(predicted, expected)

    def _match_parallel_calls(
        self,
        predicted: list[FunctionCall],
        expected: list[FunctionCall],
    ) -> bool:
        """Match parallel calls (order-independent)."""
        expected_used = [False] * len(expected)

        for pred_call in predicted:
            found = False
            for i, exp_call in enumerate(expected):
                if not expected_used[i] and self._calls_match(pred_call, exp_call):
                    expected_used[i] = True
                    found = True
                    break
            if not found:
                return False

        return all(expected_used)

    def _calls_match(
        self,
        predicted: FunctionCall,
        expected: FunctionCall,
    ) -> bool:
        """Check if two function calls match."""
        # Compare function names
        pred_name = predicted.name
        exp_name = expected.name
        if not self.case_sensitive_names:
            pred_name = pred_name.lower().replace("_", "")
            exp_name = exp_name.lower().replace("_", "")

        if pred_name != exp_name:
            return False

        # Compare arguments
        pred_args = predicted.arguments
        exp_args = expected.arguments
        if not self.case_sensitive_names:
            pred_args = {k.lower(): v for k, v in pred_args.items()}
            exp_args = {k.lower(): v for k, v in exp_args.items()}

        return self._arguments_match(pred_args, exp_args)

    def _arguments_match(
        self,
        predicted: dict[str, ArgumentValue],
        expected: dict[str, ArgumentValue],
    ) -> bool:
        """Check if argument dictionaries match."""
        pred_keys = set(predicted.keys())
        exp_keys = set(expected.keys())

        if not self.case_sensitive_names:
            pred_keys = {k.lower() for k in pred_keys}
            exp_keys = {k.lower() for k in exp_keys}
            predicted = {k.lower(): v for k, v in predicted.items()}
            expected = {k.lower(): v for k, v in expected.items()}

        # Check for missing expected keys
        missing_keys = exp_keys - pred_keys
        if missing_keys:
            return False

        # Check for extra keys (if not ignoring)
        if not self.ignore_extra_args:
            extra_keys = pred_keys - exp_keys
            if extra_keys:
                return False

        # Compare values for expected keys
        for key in exp_keys:
            if not self._values_match(predicted.get(key), expected.get(key)):
                return False

        return True

    def _values_match(
        self,
        predicted: object,
        expected: object,
    ) -> bool:
        """Check if two values match (with type coercion if not strict)."""
        if predicted is None and expected is None:
            return True

        if predicted is None or expected is None:
            return False

        # Direct equality
        if predicted == expected:
            return True

        # Type coercion (if not strict)
        if not self.strict_type_matching:
            # Try numeric comparison
            pred_num = self._try_parse_number(predicted)
            exp_num = self._try_parse_number(expected)
            if pred_num is not None and exp_num is not None:
                if isinstance(pred_num, float) or isinstance(exp_num, float):
                    return math.isclose(pred_num, exp_num, rel_tol=1e-9)
                return pred_num == exp_num

            # Try boolean comparison
            pred_bool = self._try_parse_bool(predicted)
            exp_bool = self._try_parse_bool(expected)
            if pred_bool is not None and exp_bool is not None:
                return pred_bool == exp_bool

            # String comparison (case-insensitive for enums/identifiers)
            if isinstance(predicted, str) and isinstance(expected, str):
                if predicted.lower() == expected.lower():
                    return True
                # Normalize mathematical notation (^ vs ** for exponents)
                pred_norm = self._normalize_math_notation(predicted)
                exp_norm = self._normalize_math_notation(expected)
                if pred_norm == exp_norm:
                    return True

        # List comparison
        if isinstance(predicted, list) and isinstance(expected, list):
            if len(predicted) != len(expected):
                return False
            return all(
                self._values_match(p, e)
                for p, e in zip(predicted, expected, strict=True)
            )

        # Dict comparison
        if isinstance(predicted, dict) and isinstance(expected, dict):
            return self._arguments_match(predicted, expected)

        return False

    def _normalize_math_notation(self, value: str) -> str:
        """
        Normalize mathematical notation for comparison.
        
        Handles common notation differences:
        - ^ vs ** for exponentiation
        - Whitespace normalization
        """
        # Normalize exponentiation: 3x^2 -> 3x**2
        result = value.replace("^", "**")
        # Normalize whitespace
        result = " ".join(result.split())
        return result.lower()

    def _try_parse_number(self, value: object) -> Optional[int | float]:
        """Try to parse a value as a number."""
        if isinstance(value, int | float):
            return value
        if isinstance(value, str):
            try:
                if "." in value:
                    return float(value)
                return int(value)
            except ValueError:
                pass
        return None

    def _try_parse_bool(self, value: object) -> Optional[bool]:
        """Try to parse a value as a boolean."""
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            if value.lower() in ("true", "1", "yes"):
                return True
            if value.lower() in ("false", "0", "no"):
                return False
        return None

    def get_match_details(
        self,
        predicted: list[FunctionCall],
        expected: list[FunctionCall],
    ) -> ResultDetails:
        """Get detailed information about the match/mismatch."""
        details: ResultDetails = {
            "predicted_count": len(predicted),
            "expected_count": len(expected),
            "overall_match": self.evaluate(predicted, expected),
        }

        if len(predicted) != len(expected):
            details["mismatch_reason"] = "count_mismatch"
            return details

        mismatches: list[str] = []
        for i, (pred, exp) in enumerate(zip(predicted, expected, strict=True)):
            if not self._calls_match(pred, exp):
                if pred.name.lower() != exp.name.lower():
                    mismatches.append(
                        f"Call {i}: name mismatch ('{pred.name}' vs '{exp.name}')"
                    )
                else:
                    # Find argument mismatches
                    for key in set(pred.arguments.keys()) | set(exp.arguments.keys()):
                        pred_val = pred.arguments.get(key)
                        exp_val = exp.arguments.get(key)
                        if not self._values_match(pred_val, exp_val):
                            mismatches.append(
                                f"Call {i}, arg '{key}': "
                                f"'{pred_val}' vs '{exp_val}'"
                            )

        details["mismatches"] = mismatches
        return details
