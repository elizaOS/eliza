"""
Evaluator for Tau-bench benchmark results.
"""

import logging
from typing import Any, Optional, Protocol, runtime_checkable

from elizaos_tau_bench.types import (
    TauBenchTask,
    TauBenchResult,
    ToolCall,
    ToolCallStatus,
    PassKMetrics,
)

logger = logging.getLogger(__name__)


@runtime_checkable
class IAgentRuntime(Protocol):
    """Protocol for ElizaOS agent runtime."""
    
    async def generate_text(
        self, input_text: str, options: dict[str, str]
    ) -> object:
        """Generate text from the LLM."""
        ...


class TauBenchEvaluator:
    """Evaluates agent performance on Tau-bench tasks."""

    def __init__(
        self, use_llm_judge: bool = False, runtime: Optional[IAgentRuntime] = None
    ) -> None:
        self.use_llm_judge = use_llm_judge
        self.runtime = runtime

    def evaluate_task(
        self,
        task: TauBenchTask,
        tool_calls_made: list[ToolCall],
        response: str,
        policy_violations: list[str],
        goal_achieved: bool,
        final_state: dict[str, Any],
        duration_ms: float,
        tokens_used: int = 0,
        trial_number: int = 1,
    ) -> TauBenchResult:
        """Evaluate agent performance on a single task."""

        # Evaluate tool call accuracy
        tool_metrics = self._evaluate_tool_calls(
            task.expected_tool_calls, tool_calls_made
        )

        # Evaluate response quality
        response_quality = self._evaluate_response(task.ground_truth_response, response)

        # Calculate policy compliance
        total_constraints = len(task.policy_constraints)
        policy_compliance = (
            1.0 - (len(policy_violations) / max(total_constraints, 1))
            if total_constraints > 0
            else 1.0
        )

        # Overall success determination
        #
        # Tau-bench style success should primarily reflect whether the agent actually
        # achieved the task goal while complying with policies. Tool-call matching
        # against a single "expected" sequence is not reliable for real LLM agents
        # (there can be many valid tool sequences), so we treat tool_accuracy and
        # response_quality as diagnostic metrics rather than hard gates.
        tool_execution_ok = all(tc.status == ToolCallStatus.CORRECT for tc in tool_calls_made)
        has_final_response = bool(response and response.strip())
        success = goal_achieved and policy_compliance >= 0.9 and tool_execution_ok and has_final_response

        return TauBenchResult(
            task_id=task.task_id,
            domain=task.domain,
            trial_number=trial_number,
            tool_calls_made=tool_calls_made,
            tool_call_accuracy=tool_metrics["tool_accuracy"],
            tool_selection_accuracy=tool_metrics["selection_accuracy"],
            parameter_accuracy=tool_metrics["parameter_accuracy"],
            response_generated=response,
            response_quality=response_quality,
            policy_violations=policy_violations,
            policy_compliance=policy_compliance,
            goal_achieved=goal_achieved,
            final_state=final_state,
            success=success,
            duration_ms=duration_ms,
            turns_used=len(tool_calls_made) + 1,
            tokens_used=tokens_used,
            metrics={
                "planning_time_ms": 0.0,
                "execution_time_ms": sum(tc.execution_time_ms for tc in tool_calls_made),
                "tool_invocation_count": float(len(tool_calls_made)),
                "correct_tool_count": float(tool_metrics["correct_count"]),
            },
        )

    def _evaluate_tool_calls(
        self, expected: list[ToolCall], actual: list[ToolCall]
    ) -> dict[str, float]:
        """Compare expected vs actual tool calls."""
        if not expected:
            # No expected calls - success if no unnecessary calls made
            return {
                "tool_accuracy": 1.0 if not actual else 0.8,
                "selection_accuracy": 1.0 if not actual else 0.8,
                "parameter_accuracy": 1.0,
                "correct_count": 0,
            }

        correct_selections = 0
        correct_params = 0
        matched_expected = set()

        for act in actual:
            for i, exp in enumerate(expected):
                if i in matched_expected:
                    continue

                if exp.tool_name == act.tool_name:
                    correct_selections += 1
                    matched_expected.add(i)

                    # Check parameters
                    if self._params_match(exp.arguments, act.arguments):
                        correct_params += 1
                    break

        # Calculate metrics
        selection_accuracy = correct_selections / len(expected) if expected else 1.0
        param_accuracy = correct_params / len(expected) if expected else 1.0

        # Penalize extra calls
        extra_calls = max(0, len(actual) - len(expected))
        extra_penalty = extra_calls * 0.1

        # Overall tool accuracy combines selection and parameter accuracy
        tool_accuracy = (selection_accuracy * 0.5 + param_accuracy * 0.5) - extra_penalty
        tool_accuracy = max(0.0, min(1.0, tool_accuracy))

        return {
            "tool_accuracy": tool_accuracy,
            "selection_accuracy": selection_accuracy,
            "parameter_accuracy": param_accuracy,
            "correct_count": correct_params,
        }

    def _params_match(self, expected: dict[str, Any], actual: dict[str, Any]) -> bool:
        """Check if parameters match (fuzzy comparison)."""
        for key, value in expected.items():
            if key not in actual:
                return False

            # String comparison (case-insensitive)
            exp_str = str(value).lower().strip()
            act_str = str(actual[key]).lower().strip()

            if exp_str != act_str:
                # Try numeric comparison
                try:
                    if float(value) != float(actual[key]):
                        return False
                except (ValueError, TypeError):
                    return False

        return True

    def _evaluate_response(self, expected: str, actual: str) -> float:
        """Evaluate response quality."""
        if not expected:
            # No ground truth - give partial credit for having a response
            return 0.7 if actual and len(actual) > 20 else 0.5

        if self.use_llm_judge and self.runtime:
            # Use LLM to judge response quality
            return self._llm_judge_response(expected, actual)

        # Simple overlap-based scoring
        expected_words = set(expected.lower().split())
        actual_words = set(actual.lower().split())

        if not expected_words:
            return 0.5

        # Calculate word overlap
        overlap = len(expected_words & actual_words)
        precision = overlap / len(actual_words) if actual_words else 0
        recall = overlap / len(expected_words)

        # F1 score
        if precision + recall == 0:
            return 0.3

        f1 = 2 * precision * recall / (precision + recall)

        # Also check for key phrases
        key_phrases = self._extract_key_phrases(expected)
        phrase_matches = sum(1 for phrase in key_phrases if phrase.lower() in actual.lower())
        phrase_score = phrase_matches / len(key_phrases) if key_phrases else 0.5

        # Combined score
        return min(1.0, f1 * 0.6 + phrase_score * 0.4)

    def _extract_key_phrases(self, text: str) -> list[str]:
        """Extract key phrases from text."""
        import re

        # Look for amounts, IDs, status words
        patterns = [
            r"\$[\d,]+\.?\d*",  # Dollar amounts
            r"[A-Z]{2,}-\d+",  # IDs like ORD-12345
            r"\b(confirmed|cancelled|processing|delivered|refund|success)\b",
        ]

        phrases = []
        for pattern in patterns:
            matches = re.findall(pattern, text, re.IGNORECASE)
            phrases.extend(matches)

        return phrases

    def _llm_judge_response(self, expected: str, actual: str) -> float:
        """Use LLM to judge response quality (async call wrapped)."""
        # This would call the runtime to get an LLM judgment
        # For now, fall back to simple comparison
        return self._evaluate_response(expected, actual)

    @staticmethod
    def calculate_pass_k(
        results: list[TauBenchResult], k_values: Optional[list[int]] = None
    ) -> dict[int, PassKMetrics]:
        """
        Calculate Pass^k metrics for a list of results.

        Pass^k measures the probability that a task is solved correctly
        in ALL of k independent trials. This is stricter than average
        success rate and measures consistency/reliability.
        """
        if k_values is None:
            k_values = [1, 2, 4, 8]

        metrics = {}
        for k in k_values:
            metrics[k] = PassKMetrics.calculate(results, k)

        return metrics

    @staticmethod
    def compare_to_leaderboard(
        results: list[TauBenchResult], leaderboard_scores: dict[str, dict[str, float]]
    ) -> dict[str, float]:
        """
        Compare results to leaderboard scores.

        Returns a dictionary mapping model names to the difference
        between our score and their score (positive = we're better).
        """
        from elizaos_tau_bench.types import TauDomain

        # Calculate our scores by domain
        our_scores: dict[str, float] = {}
        for domain in TauDomain:
            domain_results = [r for r in results if r.domain == domain]
            if domain_results:
                success_rate = sum(1 for r in domain_results if r.success) / len(domain_results)
                our_scores[domain.value] = success_rate

        # Compare to each model
        comparisons: dict[str, float] = {}
        for model, scores in leaderboard_scores.items():
            differences: list[float] = []
            for domain_name, our_score in our_scores.items():
                if domain_name in scores:
                    differences.append(our_score - scores[domain_name])

            if differences:
                comparisons[model] = sum(differences) / len(differences)

        return comparisons
