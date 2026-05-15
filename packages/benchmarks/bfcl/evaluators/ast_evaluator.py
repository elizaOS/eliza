"""
BFCL AST Evaluator

Evaluates the Abstract Syntax Tree (structural) correctness of function calls.
Compares predicted function calls against expected calls with flexible matching.
"""

from __future__ import annotations

import ast
import json
import logging
import math
import re
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
        function_defs: list | None = None,
    ) -> bool:
        """
        Compare predicted and expected function calls.

        For parallel calls, order doesn't matter.
        For single calls, direct comparison.

        Args:
            predicted: List of predicted function calls
            expected: List of expected function calls
            function_defs: Optional list of FunctionDefinition objects used to
                prune expected arguments whose value matches the declared
                default when the model omitted them. Without this the matcher
                punishes models for following the schema's "optional means
                you may skip it" semantics.

        Returns:
            True if AST matches, False otherwise
        """
        defs_by_name = self._index_function_defs(function_defs)
        if len(predicted) != len(expected):
            return False

        if len(predicted) == 0:
            return True

        if len(predicted) == 1:
            return self._calls_match(predicted[0], expected[0], defs_by_name)

        # For multiple calls, try to match each predicted to an expected
        return self._match_parallel_calls(predicted, expected, defs_by_name)

    def _index_function_defs(self, function_defs: list | None) -> dict:
        if not function_defs:
            return {}
        index: dict = {}
        for fd in function_defs:
            name = getattr(fd, "name", None)
            if isinstance(name, str):
                index[name] = fd
        return index

    def _normalize_function_name(self, name: str) -> str:
        """Normalize provider-safe aliases for BFCL function names.

        Some OpenAI-compatible providers sanitize native tool names such as
        ``random.normalvariate`` into ``random_normalvariate`` because their
        tool-call API only accepts identifier-like names. Treat common
        namespace separators as non-semantic when case-sensitive matching is
        disabled.
        """
        return re.sub(r"[\W_]+", "", name.lower())

    def _match_parallel_calls(
        self,
        predicted: list[FunctionCall],
        expected: list[FunctionCall],
        defs_by_name: dict | None = None,
    ) -> bool:
        """Match parallel calls (order-independent)."""
        defs_by_name = defs_by_name or {}
        expected_used = [False] * len(expected)

        for pred_call in predicted:
            found = False
            for i, exp_call in enumerate(expected):
                if not expected_used[i] and self._calls_match(
                    pred_call, exp_call, defs_by_name
                ):
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
        defs_by_name: dict | None = None,
    ) -> bool:
        """Check if two function calls match."""
        # Compare function names
        pred_name = predicted.name
        exp_name = expected.name
        if not self.case_sensitive_names:
            pred_name = self._normalize_function_name(pred_name)
            exp_name = self._normalize_function_name(exp_name)

        if pred_name != exp_name:
            return False

        # Compare arguments
        pred_args = predicted.arguments
        exp_args = expected.arguments
        if not self.case_sensitive_names:
            pred_args = {k.lower(): v for k, v in pred_args.items()}
            exp_args = {k.lower(): v for k, v in exp_args.items()}

        # Drop expected args that match the declared default when the model
        # omitted them — BFCL ground truth often pins optional args to their
        # default value, but a model that follows the schema's "optional"
        # semantics by skipping them shouldn't be penalized.
        fdef = None
        if defs_by_name:
            fdef = defs_by_name.get(predicted.name) or defs_by_name.get(expected.name)
            if fdef is not None:
                exp_args = self._prune_default_optionals(exp_args, pred_args, fdef)

        param_defs = getattr(fdef, "parameters", None) if fdef is not None else None
        return self._arguments_match(pred_args, exp_args, param_defs)

    def _prune_default_optionals(
        self,
        expected: dict,
        predicted: dict,
        fdef,
    ) -> dict:
        """Remove expected args missing from predicted that match the default."""
        params = getattr(fdef, "parameters", None)
        required = set(getattr(fdef, "required_params", []) or [])
        if not isinstance(params, dict) or not params:
            return expected
        pruned: dict = {}
        for key, value in expected.items():
            if key in predicted or key in required:
                pruned[key] = value
                continue
            param = params.get(key)
            default = self._schema_default(param)
            if default is None:
                pruned[key] = value
                continue
            if self._expected_matches_default(value, default, param):
                continue  # Drop — model was right to skip this optional.
            pruned[key] = value
        return pruned

    def _arguments_match(
        self,
        predicted: dict[str, ArgumentValue],
        expected: dict[str, ArgumentValue],
        param_defs: dict | None = None,
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
            schema = param_defs.get(key) if isinstance(param_defs, dict) else None
            if not self._value_matches_with_schema(
                predicted.get(key),
                expected.get(key),
                schema,
            ):
                return False

        return True

    def _value_matches_with_schema(
        self,
        predicted: object,
        expected: object,
        schema: object | None,
    ) -> bool:
        """Match a single value using schema hints when available."""
        if self._schema_is_array_like(schema):
            return self._values_match(predicted, expected)

        if self._schema_type(schema) == "object" and isinstance(predicted, dict) and isinstance(expected, dict):
            return self._arguments_match(
                predicted,
                expected,
                self._schema_properties(schema),
            )

        if isinstance(expected, list) and not isinstance(predicted, list):
            return any(self._values_match(predicted, candidate) for candidate in expected)

        if isinstance(predicted, list) and not isinstance(expected, list):
            if len(predicted) == 1 and self._values_match(predicted[0], expected):
                return True

        return self._values_match(predicted, expected)

    def _schema_type(self, schema: object | None) -> Optional[str]:
        if schema is None:
            return None
        if isinstance(schema, dict):
            type_value = schema.get("type")
            return str(type_value).lower() if isinstance(type_value, str) else None
        type_value = getattr(schema, "param_type", None)
        return str(type_value).lower() if isinstance(type_value, str) else None

    def _schema_is_array_like(self, schema: object | None) -> bool:
        if schema is None:
            return False
        if isinstance(schema, dict):
            if schema.get("items") is not None:
                return True
            return self._schema_type(schema) in {"array", "list", "tuple"}
        return bool(getattr(schema, "items", None)) or self._schema_type(schema) in {"array", "list", "tuple"}

    def _schema_default(self, schema: object | None) -> object:
        if schema is None:
            return None
        if isinstance(schema, dict):
            return schema.get("default")
        return getattr(schema, "default", None)

    def _schema_properties(self, schema: object | None) -> dict[str, object] | None:
        if schema is None:
            return None
        if isinstance(schema, dict):
            props = schema.get("properties")
            return props if isinstance(props, dict) else None
        props = getattr(schema, "properties", None)
        return props if isinstance(props, dict) else None

    def _expected_matches_default(
        self,
        expected: object,
        default: object,
        schema: object | None,
    ) -> bool:
        if expected is None:
            return default is None
        if self._schema_is_array_like(schema):
            return self._values_match(expected, default)
        if isinstance(expected, list):
            return any(self._values_match(candidate, default) for candidate in expected)
        return self._values_match(expected, default)

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
                # SQL-condition quote tolerance: "Col = 'value'" vs "Col = value"
                if self._normalize_sql_condition(predicted) == self._normalize_sql_condition(expected):
                    return True

        # List comparison
        if isinstance(predicted, list) and isinstance(expected, list):
            if len(predicted) != len(expected):
                return False
            return all(
                self._values_match(p, e)
                for p, e in zip(predicted, expected, strict=True)
            )

        # BFCL nested-arguments singleton-list convention: each leaf value in
        # the possible_answer ground truth is wrapped in a list of acceptable
        # values, even inside nested objects. _parse_ground_truth_calls only
        # unwraps the top-level list. When the model emits a scalar that
        # matches the single allowed value, accept it. Mirror it for the
        # opposite direction so the matcher is symmetric.
        if not self.strict_type_matching:
            if isinstance(expected, list) and len(expected) == 1:
                if self._values_match(predicted, expected[0]):
                    return True
            if isinstance(predicted, list) and len(predicted) == 1:
                if self._values_match(predicted[0], expected):
                    return True

        # Stringified-list tolerance: the model sometimes emits a JSON-encoded
        # or Python-repr list when the schema wants an actual list. Try to
        # decode and re-compare. Common with Java argv parameters and SQL
        # column lists where the ground truth is list[str].
        if not self.strict_type_matching:
            if isinstance(predicted, str) and isinstance(expected, list):
                parsed = self._try_parse_stringified_list(predicted)
                if parsed is not None and self._values_match(parsed, expected):
                    return True
            if isinstance(expected, str) and isinstance(predicted, list):
                parsed = self._try_parse_stringified_list(expected)
                if parsed is not None and self._values_match(predicted, parsed):
                    return True

        # Comma-separated string vs list-of-strings tolerance — common when
        # the model returns SQL-style "a, b, c" for a parameter the schema
        # actually defines as list[str]. Only meaningful for primitive lists.
        if not self.strict_type_matching:
            if isinstance(predicted, str) and isinstance(expected, list):
                if self._delimited_string_matches_list(predicted, expected):
                    return True
            if isinstance(expected, str) and isinstance(predicted, list):
                if self._delimited_string_matches_list(expected, predicted):
                    return True

        # Dict comparison
        if isinstance(predicted, dict) and isinstance(expected, dict):
            return self._arguments_match(predicted, expected)

        return False

    def _normalize_sql_condition(self, value: str) -> str:
        """Normalize a SQL condition string for quote-insensitive comparison.

        Strips single/double quotes around scalar literals so that
        ``Col = 'foo'`` and ``Col = foo`` compare equal. Preserves operators
        and whitespace structure. Only meant for short SQL fragments — not a
        full SQL parser.
        """
        if not value:
            return ""
        normalized = value.replace("'", "").replace('"', "")
        return " ".join(normalized.split()).lower()

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

    def _delimited_string_matches_list(self, text: str, expected: list) -> bool:
        """Treat a delimited string as a flat list and compare element-wise.

        Accepts comma-separated, whitespace-separated, or space-after-comma
        variants. Only fires for primitive (non-nested) expected lists.
        """
        if any(isinstance(e, (list, dict)) for e in expected):
            return False
        for parts in (
            [p.strip().strip("'\"") for p in text.split(",") if p.strip()],
            text.split(),
        ):
            if len(parts) == len(expected) and all(
                self._values_match(p, e) for p, e in zip(parts, expected, strict=True)
            ):
                return True
        return False

    def _try_parse_stringified_list(self, value: str) -> Optional[list]:
        """Decode a string that wraps a Python/JSON list literal."""
        text = value.strip()
        if not (text.startswith("[") and text.endswith("]")):
            return None
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            try:
                parsed = ast.literal_eval(text)
            except (ValueError, SyntaxError):
                return None
        return parsed if isinstance(parsed, list) else None

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
        function_defs: list | None = None,
    ) -> ResultDetails:
        """Get detailed information about the match/mismatch."""
        defs_by_name = self._index_function_defs(function_defs)
        details: ResultDetails = {
            "predicted_count": len(predicted),
            "expected_count": len(expected),
            "overall_match": self.evaluate(predicted, expected, function_defs),
        }

        if len(predicted) != len(expected):
            details["mismatch_reason"] = "count_mismatch"
            return details

        mismatches: list[str] = []
        for i, (pred, exp) in enumerate(zip(predicted, expected, strict=True)):
            if not self._calls_match(pred, exp, defs_by_name):
                if self.case_sensitive_names:
                    names_match = pred.name == exp.name
                else:
                    names_match = (
                        self._normalize_function_name(pred.name)
                        == self._normalize_function_name(exp.name)
                    )
                if not names_match:
                    mismatches.append(
                        f"Call {i}: name mismatch ('{pred.name}' vs '{exp.name}')"
                    )
                else:
                    fdef = defs_by_name.get(pred.name) or defs_by_name.get(exp.name)
                    param_defs = getattr(fdef, "parameters", None) if fdef is not None else None
                    exp_args = exp.arguments
                    if fdef is not None:
                        exp_args = self._prune_default_optionals(
                            exp.arguments,
                            pred.arguments,
                            fdef,
                        )
                    for key in set(pred.arguments.keys()) | set(exp_args.keys()):
                        pred_val = pred.arguments.get(key)
                        exp_val = exp_args.get(key)
                        schema = param_defs.get(key) if isinstance(param_defs, dict) else None
                        if not self._value_matches_with_schema(pred_val, exp_val, schema):
                            mismatches.append(
                                f"Call {i}, arg '{key}': "
                                f"'{pred_val}' vs '{exp_val}'"
                            )

        details["mismatches"] = mismatches
        return details
