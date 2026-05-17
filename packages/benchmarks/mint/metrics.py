"""
MINT Metrics Calculator

The canonical MINT headline metric is Turn-k success rate: the fraction of
tasks for which the agent had a *correct* answer at or before turn k. We
compute it from the per-turn cumulative success list stored on each
``MINTResult`` (see ``evaluator.MINTEvaluator._grade_per_turn``).

Per-subtask and per-task-type breakdowns are reported alongside.
"""

from __future__ import annotations

import logging
from typing import Optional

from benchmarks.mint.types import (
    ConfigurationResult,
    MINTMetrics,
    MINTResult,
    MINTSubtask,
    MINTTaskType,
    SUBTASK_TO_TASK_TYPE,
    LEADERBOARD_SCORES,
    PAPER_RESULTS_URL,
)

logger = logging.getLogger(__name__)


class MetricsCalculator:
    """Calculate comprehensive MINT benchmark metrics."""

    def calculate(
        self, results: list[MINTResult], max_turns: int = 5
    ) -> MINTMetrics:
        if not results:
            return MINTMetrics(
                overall_success_rate=0.0,
                total_tasks=0,
                passed_tasks=0,
                failed_tasks=0,
            )

        total = len(results)
        passed = sum(1 for r in results if r.success)
        failed = total - passed

        # ------------------------------------------------------------------
        # Per-subtask / per-task-type breakdowns
        # ------------------------------------------------------------------
        subtask_success_rates: dict[MINTSubtask, float] = {}
        subtask_counts: dict[MINTSubtask, int] = {}
        for st in MINTSubtask:
            st_results = [r for r in results if r.subtask == st]
            if st_results:
                ok = sum(1 for r in st_results if r.success)
                subtask_success_rates[st] = ok / len(st_results)
                subtask_counts[st] = len(st_results)

        task_type_success_rates: dict[MINTTaskType, float] = {}
        task_type_counts: dict[MINTTaskType, int] = {}
        for tt in MINTTaskType:
            tt_results = [
                r for r in results if SUBTASK_TO_TASK_TYPE[r.subtask] == tt
            ]
            if tt_results:
                ok = sum(1 for r in tt_results if r.success)
                task_type_success_rates[tt] = ok / len(tt_results)
                task_type_counts[tt] = len(tt_results)

        # ------------------------------------------------------------------
        # Turn analysis
        # ------------------------------------------------------------------
        successful = [r for r in results if r.success]
        failed_r = [r for r in results if not r.success]

        avg_turns_success = (
            sum(r.turns_used for r in successful) / len(successful)
            if successful
            else 0.0
        )
        avg_turns_failure = (
            sum(r.turns_used for r in failed_r) / len(failed_r)
            if failed_r
            else 0.0
        )

        # ------------------------------------------------------------------
        # Tool analysis
        # ------------------------------------------------------------------
        with_tools = [r for r in results if r.tool_uses > 0]
        without_tools = [r for r in results if r.tool_uses == 0]

        tool_usage_rate = len(with_tools) / total if total else 0.0
        tool_success_rate = (
            sum(1 for r in with_tools if r.success) / len(with_tools)
            if with_tools
            else 0.0
        )
        no_tool_success_rate = (
            sum(1 for r in without_tools if r.success) / len(without_tools)
            if without_tools
            else 0.0
        )
        tool_effectiveness = tool_success_rate - no_tool_success_rate

        avg_tool_uses_success = (
            sum(r.tool_uses for r in successful) / len(successful)
            if successful
            else 0.0
        )
        avg_tool_uses_failure = (
            sum(r.tool_uses for r in failed_r) / len(failed_r)
            if failed_r
            else 0.0
        )

        # ------------------------------------------------------------------
        # Feedback analysis
        # ------------------------------------------------------------------
        with_fb = [r for r in results if r.feedback_turns > 0]
        without_fb = [r for r in results if r.feedback_turns == 0]
        feedback_usage_rate = len(with_fb) / total if total else 0.0
        fb_success_rate = (
            sum(1 for r in with_fb if r.success) / len(with_fb)
            if with_fb
            else 0.0
        )
        no_fb_success_rate = (
            sum(1 for r in without_fb if r.success) / len(without_fb)
            if without_fb
            else 0.0
        )
        feedback_effectiveness = fb_success_rate - no_fb_success_rate

        avg_fb_success = (
            sum(r.feedback_turns for r in successful) / len(successful)
            if successful
            else 0.0
        )
        avg_fb_failure = (
            sum(r.feedback_turns for r in failed_r) / len(failed_r)
            if failed_r
            else 0.0
        )

        # ------------------------------------------------------------------
        # Turn-k success rates (the canonical paper metric)
        # ------------------------------------------------------------------
        per_turn = self._per_turn_success_rates(results, max_turns)

        def _at(k: int) -> float:
            return per_turn[k - 1] if k - 1 < len(per_turn) else 0.0

        turn_1 = _at(1)
        turn_2 = _at(2)
        turn_3 = _at(3)
        turn_4 = _at(4)
        turn_5 = _at(5)
        multi_turn_gain = turn_5 - turn_1

        # ------------------------------------------------------------------
        # Performance
        # ------------------------------------------------------------------
        avg_latency = sum(r.latency_ms for r in results) / total
        avg_tokens = sum(r.token_usage for r in results) / total
        total_tokens = sum(r.token_usage for r in results)
        total_duration = sum(r.latency_ms for r in results)

        overall_success_rate = passed / total
        avg_turns = sum(r.turns_used for r in results) / total
        turn_efficiency = (
            overall_success_rate / avg_turns if avg_turns > 0 else 0.0
        )

        return MINTMetrics(
            overall_success_rate=overall_success_rate,
            total_tasks=total,
            passed_tasks=passed,
            failed_tasks=failed,
            subtask_success_rates=subtask_success_rates,
            subtask_counts=subtask_counts,
            task_type_success_rates=task_type_success_rates,
            task_type_counts=task_type_counts,
            avg_turns_to_success=avg_turns_success,
            avg_turns_to_failure=avg_turns_failure,
            turn_efficiency=turn_efficiency,
            tool_usage_rate=tool_usage_rate,
            tool_effectiveness=tool_effectiveness,
            avg_tool_uses_success=avg_tool_uses_success,
            avg_tool_uses_failure=avg_tool_uses_failure,
            feedback_usage_rate=feedback_usage_rate,
            feedback_effectiveness=feedback_effectiveness,
            avg_feedback_turns_success=avg_fb_success,
            avg_feedback_turns_failure=avg_fb_failure,
            multi_turn_gain=multi_turn_gain,
            turn_1_success_rate=turn_1,
            turn_2_success_rate=turn_2,
            turn_3_success_rate=turn_3,
            turn_4_success_rate=turn_4,
            turn_5_success_rate=turn_5,
            per_turn_success_rates=per_turn,
            avg_latency_ms=avg_latency,
            avg_tokens_per_task=avg_tokens,
            total_tokens=total_tokens,
            total_duration_ms=total_duration,
        )

    def _per_turn_success_rates(
        self, results: list[MINTResult], max_turns: int
    ) -> list[float]:
        """Cumulative success rate at each turn 1..max_turns."""
        total = len(results)
        per_turn: list[float] = []
        for k in range(max_turns):
            ok = 0
            for r in results:
                flags = r.cumulative_success_per_turn
                if not flags:
                    # Backwards-compat: if the agent didn't populate per-turn
                    # data, treat the final success as turn-k success for
                    # k >= turns_used.
                    if r.success and r.turns_used <= k + 1:
                        ok += 1
                    continue
                # ``cumulative_success_per_turn[i]`` is True iff the agent had
                # a correct answer at or before turn i + 1. If the agent ran
                # for fewer than k turns, we extend with the last flag.
                if k < len(flags):
                    ok += int(flags[k])
                elif flags:
                    ok += int(flags[-1])
            per_turn.append(ok / total if total else 0.0)
        return per_turn

    # ----------------------------------------------------------------------
    # Comparison utilities (kept compatible with the previous API)
    # ----------------------------------------------------------------------
    def compare_configurations(
        self,
        baseline: MINTMetrics,
        with_tools: Optional[MINTMetrics] = None,
        with_feedback: Optional[MINTMetrics] = None,
        full: Optional[MINTMetrics] = None,
    ) -> dict[str, float]:
        comparison: dict[str, float] = {
            "baseline_success_rate": baseline.overall_success_rate,
        }
        if with_tools:
            comparison["tools_success_rate"] = with_tools.overall_success_rate
            comparison["tool_improvement"] = (
                with_tools.overall_success_rate - baseline.overall_success_rate
            )
        if with_feedback:
            comparison["feedback_success_rate"] = with_feedback.overall_success_rate
            comparison["feedback_improvement"] = (
                with_feedback.overall_success_rate - baseline.overall_success_rate
            )
        if full:
            comparison["full_success_rate"] = full.overall_success_rate
            comparison["combined_improvement"] = (
                full.overall_success_rate - baseline.overall_success_rate
            )
            if with_tools and with_feedback:
                individual = (
                    comparison.get("tool_improvement", 0.0)
                    + comparison.get("feedback_improvement", 0.0)
                )
                comparison["synergy"] = (
                    comparison["combined_improvement"] - individual
                )
        return comparison

    def compare_to_leaderboard(
        self,
        metrics: MINTMetrics,
        model_name: str = "elizaos",
    ) -> dict[str, dict[str, float]]:
        """Surface our scores next to the paper's per-subtask numbers.

        ``LEADERBOARD_SCORES`` is intentionally empty in this build (the
        previous numbers were apples-to-oranges with the rebuilt subtask
        taxonomy). When upstream-reported numbers are configured, this
        function returns a comparison; otherwise it just echoes our own
        scores plus a link to the paper's results table.
        """
        our: dict[str, float] = {
            "overall": metrics.overall_success_rate,
            "turn_1": metrics.turn_1_success_rate,
            "turn_3": metrics.turn_3_success_rate,
            "turn_5": metrics.turn_5_success_rate,
        }
        for st, rate in metrics.subtask_success_rates.items():
            our[st.value] = rate

        out: dict[str, dict[str, float]] = {model_name: our}
        if not LEADERBOARD_SCORES:
            out["_paper_results_url"] = {PAPER_RESULTS_URL: 0.0}
            return out

        for lb_model, lb_scores in LEADERBOARD_SCORES.items():
            diff: dict[str, float] = {}
            for key, ours in our.items():
                lb = lb_scores.get(key, 0.0)
                diff[key] = ours
                diff[f"{key}_vs_{lb_model}"] = ours - lb
            out[f"{model_name}_vs_{lb_model}"] = diff
        return out

    def calculate_configuration_result(
        self,
        results: list[MINTResult],
        config_name: str,
        enable_tools: bool,
        enable_feedback: bool,
    ) -> ConfigurationResult:
        metrics = self.calculate(results)
        return ConfigurationResult(
            config_name=config_name,
            enable_tools=enable_tools,
            enable_feedback=enable_feedback,
            metrics=metrics,
            results=results,
        )
