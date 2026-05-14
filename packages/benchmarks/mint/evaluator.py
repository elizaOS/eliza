"""
MINT Evaluator

Evaluates agent answers against ground truth using metrics that mirror the
upstream MINT graders:

    * ``exact_match``     : normalized string equality (with light fallback).
    * ``numeric``         : floats within 2% relative tolerance.
    * ``code_test``       : run candidate code + test suite via the upstream
                            ``check_correctness`` sandbox (HumanEval / MBPP).
    * ``partial_match``   : substring / token overlap (HotpotQA).
    * ``semantic``        : Jaccard token overlap.
    * ``multiple_choice`` : MMLU letter-or-content match (upstream
                            ``MultipleChoiceTask.success``).
    * ``theoremqa``       : the TheoremQA grader (numbers / lists / bool).
"""

from __future__ import annotations

import logging
import re
from typing import Optional

from benchmarks.mint.types import (
    MINTTask,
    MINTTrajectory,
    MINTResult,
)

logger = logging.getLogger(__name__)


class MINTEvaluator:
    """Evaluate MINT task solutions."""

    NUMBER_PATTERN = r"-?\d+(?:\.\d+)?"

    def __init__(self, strict: bool = False) -> None:
        self.strict = strict

    # ------------------------------------------------------------------
    # Trajectory-level entry point
    # ------------------------------------------------------------------
    def evaluate_trajectory(
        self,
        task: MINTTask,
        trajectory: MINTTrajectory,
    ) -> MINTResult:
        predicted = trajectory.final_answer or ""
        success, score, details = self.evaluate(
            predicted=predicted,
            expected=task.ground_truth,
            metric=task.evaluation_metric,
            task=task,
        )

        latency_ms = max(0.0, trajectory.end_time_ms - trajectory.start_time_ms)
        assistant_turns = [t for t in trajectory.turns if t.turn_type.value == "assistant"]

        # Per-turn cumulative success. The trajectory already records each
        # proposed answer; we re-grade each one so the evaluator stays the
        # single source of truth for "is this correct".
        per_turn = self._grade_per_turn(task, trajectory)

        return MINTResult(
            task_id=task.id,
            subtask=task.subtask,
            trajectory=trajectory,
            success=success,
            turns_used=len(assistant_turns),
            tool_uses=trajectory.num_tool_uses,
            feedback_turns=trajectory.num_feedback_turns,
            latency_ms=latency_ms,
            token_usage=trajectory.total_tokens,
            score=score,
            evaluation_details=details,
            cumulative_success_per_turn=per_turn,
        )

    def _grade_per_turn(
        self, task: MINTTask, trajectory: MINTTrajectory
    ) -> list[bool]:
        """Cumulative success flags, one entry per assistant turn."""
        flags: list[bool] = []
        any_correct = False
        for answer in trajectory.per_turn_answers:
            if answer is None or any_correct:
                flags.append(any_correct)
                continue
            ok, _, _ = self.evaluate(
                predicted=answer,
                expected=task.ground_truth,
                metric=task.evaluation_metric,
                task=task,
            )
            any_correct = any_correct or ok
            flags.append(any_correct)
        return flags

    # ------------------------------------------------------------------
    # Single-answer entry point
    # ------------------------------------------------------------------
    def evaluate(
        self,
        predicted: str,
        expected: str,
        metric: str = "exact_match",
        task: Optional[MINTTask] = None,
    ) -> tuple[bool, float, dict[str, str | int | float | bool]]:
        details: dict[str, str | int | float | bool] = {
            "metric": metric,
            "predicted": str(predicted)[:200],
            "expected": str(expected)[:200],
        }

        if not predicted:
            details["error"] = "No answer provided"
            return False, 0.0, details

        if metric == "exact_match":
            success, score = self._exact_match(predicted, expected)
        elif metric == "numeric":
            success, score = self._numeric_match(predicted, expected)
        elif metric in {"code_test", "code_output"}:
            success, score = self._code_test_match(predicted, expected, task)
        elif metric == "partial_match":
            success, score = self._partial_match(predicted, expected)
        elif metric == "semantic":
            success, score = self._semantic_match(predicted, expected)
        elif metric == "multiple_choice":
            success, score = self._multiple_choice_match(predicted, expected)
        elif metric == "theoremqa":
            success, score = self._theoremqa_match(predicted, expected, task)
        else:
            logger.warning(
                "[MINTEvaluator] Unknown metric %s; falling back to exact_match",
                metric,
            )
            success, score = self._exact_match(predicted, expected)

        details["success"] = success
        details["score"] = score
        return success, score, details

    # ------------------------------------------------------------------
    # Metric implementations
    # ------------------------------------------------------------------
    def _exact_match(self, predicted: str, expected: str) -> tuple[bool, float]:
        pred = self._normalize(predicted)
        exp = self._normalize(expected)
        if pred == exp:
            return True, 1.0
        return False, self._string_similarity(pred, exp)

    def _numeric_match(
        self,
        predicted: str,
        expected: str,
        tolerance: float = 0.02,
    ) -> tuple[bool, float]:
        try:
            pred_nums = re.findall(self.NUMBER_PATTERN, predicted)
            exp_nums = re.findall(self.NUMBER_PATTERN, expected)
            if not pred_nums:
                return False, 0.0
            if not exp_nums:
                return self._exact_match(predicted, expected)

            pred_num = float(pred_nums[-1])
            exp_num = float(exp_nums[-1])
            if self.strict:
                tolerance = 0.0
            if pred_num == exp_num:
                return True, 1.0
            if not self.strict and round(pred_num, 2) == round(exp_num, 2):
                return True, 1.0
            if exp_num == 0:
                return (abs(pred_num) < tolerance, max(0.0, 1 - abs(pred_num)))
            rel = abs(pred_num - exp_num) / abs(exp_num)
            if rel <= tolerance:
                return True, 1.0
            return False, max(0.0, 1 - rel)
        except (ValueError, IndexError, ZeroDivisionError):
            return self._exact_match(predicted, expected)

    def _code_test_match(
        self,
        predicted: str,
        expected: str,
        task: Optional[MINTTask],
    ) -> tuple[bool, float]:
        """Execute candidate code against the upstream test suite.

        ``expected`` is the test code (HumanEval / MBPP convention); we
        delegate to the upstream sandbox so we keep parity with the paper.
        """
        try:
            from benchmarks.mint.upstream.mint.utils.exec import check_correctness
        except Exception as exc:  # ImportError or signal-unsupported on Win.
            logger.warning(
                "[MINTEvaluator] Upstream exec sandbox unavailable (%s); "
                "falling back to exact match on the candidate code.",
                exc,
            )
            return self._exact_match(predicted, expected)

        candidate = self._extract_code_block(predicted)

        # MBPP packs its tests differently — upstream pulls them from the
        # task's ``test_list`` rather than the reference field. We respect
        # whichever lives on the task metadata if present.
        test_code = expected
        if task is not None and "test_list" in task.metadata:
            import json as _json

            try:
                test_code = "\n".join(_json.loads(task.metadata["test_list"]))
            except Exception:
                test_code = expected

        try:
            result = check_correctness(
                solution_code=candidate,
                test_code=test_code,
                timeout=10,
            )
            return bool(result.get("success")), 1.0 if result.get("success") else 0.0
        except Exception as exc:
            logger.warning("[MINTEvaluator] check_correctness raised %s", exc)
            return self._exact_match(predicted, expected)

    def _partial_match(self, predicted: str, expected: str) -> tuple[bool, float]:
        pred = self._normalize(predicted)
        exp = self._normalize(expected)
        if not pred or not exp:
            return False, 0.0
        if exp in pred or pred in exp:
            return True, 1.0
        pred_tokens = set(pred.split(","))
        exp_tokens = set(exp.split(","))
        if pred_tokens and exp_tokens:
            overlap = len(pred_tokens & exp_tokens)
            union = len(pred_tokens | exp_tokens)
            if union and overlap / union >= 0.8:
                return True, overlap / union
        sim = self._string_similarity(pred, exp)
        return sim >= 0.9, sim

    def _semantic_match(self, predicted: str, expected: str) -> tuple[bool, float]:
        pred = set(self._normalize(predicted).split())
        exp = set(self._normalize(expected).split())
        if not exp:
            return False, 0.0
        union = len(pred | exp)
        if union == 0:
            return False, 0.0
        sim = len(pred & exp) / union
        return sim >= 0.7, sim

    def _multiple_choice_match(
        self, predicted: str, expected: str
    ) -> tuple[bool, float]:
        """Letter-or-content match for MMLU-style tasks."""
        pred = predicted.lower().strip()
        exp = expected.lower().strip()
        if not pred:
            return False, 0.0

        # Match letter answers like "a)", "(b)", "answer: c"
        for letter in "abcdefghijklmnopqrstuvwxyz":
            if (
                pred == letter
                or re.search(rf"\b{letter}\b\s*\)", pred)
                or pred.endswith(f" {letter}")
                or pred.startswith(f"{letter})")
                or f"answer: {letter}" in pred
                or f"answer is {letter}" in pred
            ):
                return (letter == exp, 1.0 if letter == exp else 0.0)
        # Fallback: substring containment.
        if exp in pred:
            return True, 1.0
        return False, 0.0

    def _theoremqa_match(
        self,
        predicted: str,
        expected: str,
        task: Optional[MINTTask],
    ) -> tuple[bool, float]:
        """Defer to the upstream TheoremQA grader when possible."""
        try:
            from benchmarks.mint.upstream.mint.tasks.reasoning import TheoremqaTask
        except Exception as exc:
            logger.warning(
                "[MINTEvaluator] TheoremQA grader unavailable (%s)", exc
            )
            return self._numeric_match(predicted, expected)

        answer_type = "float"
        if task is not None and task.metadata.get("answer_type"):
            answer_type = str(task.metadata["answer_type"])

        try:
            # Upstream TheoremqaTask wants the reference as the typed object,
            # not a string. We attempt to JSON-parse the stored reference.
            import json as _json

            try:
                ref = _json.loads(expected)
            except Exception:
                ref = expected
            grader = TheoremqaTask(
                id=task.id if task else "theoremqa",
                prompt=task.initial_prompt if task else "",
                reference=ref,
                answer_type=answer_type,
            )
            ok = bool(grader.success(predicted))
            return ok, 1.0 if ok else 0.0
        except Exception as exc:
            logger.warning("[MINTEvaluator] TheoremQA grader raised %s", exc)
            return self._numeric_match(predicted, expected)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _normalize(self, text: str) -> str:
        if not text:
            return ""
        out = str(text).strip().lower()
        out = re.sub(r"[.,!?;:]+$", "", out)
        out = re.sub(r"\s+", " ", out)
        for prefix in ("the answer is", "answer:", "result:", "therefore", "thus"):
            if out.startswith(prefix):
                out = out[len(prefix):].strip()
        return out

    def _string_similarity(self, a: str, b: str) -> float:
        if not a or not b:
            return 0.0
        if a == b:
            return 1.0
        matches = sum(1 for i, c in enumerate(a) if i < len(b) and b[i] == c)
        return matches / max(len(a), len(b))

    def _extract_code_block(self, text: str) -> str:
        """Pull the first fenced code block out of an LLM response, else return text."""
        match = re.search(r"```(?:python)?\s*(.*?)```", text, flags=re.DOTALL | re.IGNORECASE)
        if match:
            return match.group(1).strip()
        return text.strip()


class BatchEvaluator:
    """Evaluate multiple trajectories and aggregate results."""

    def __init__(self, evaluator: Optional[MINTEvaluator] = None) -> None:
        self.evaluator = evaluator or MINTEvaluator()

    def evaluate_batch(
        self,
        tasks: list[MINTTask],
        trajectories: list[MINTTrajectory],
    ) -> list[MINTResult]:
        return [
            self.evaluator.evaluate_trajectory(task, traj)
            for task, traj in zip(tasks, trajectories)
        ]

    def aggregate_results(self, results: list[MINTResult]) -> dict[str, float | int]:
        if not results:
            return {
                "total": 0,
                "passed": 0,
                "failed": 0,
                "success_rate": 0.0,
                "avg_score": 0.0,
                "avg_turns": 0.0,
                "avg_tool_uses": 0.0,
            }
        total = len(results)
        passed = sum(1 for r in results if r.success)
        return {
            "total": total,
            "passed": passed,
            "failed": total - passed,
            "success_rate": passed / total if total else 0.0,
            "avg_score": sum(r.score for r in results) / total,
            "avg_turns": sum(r.turns_used for r in results) / total,
            "avg_tool_uses": sum(r.tool_uses for r in results) / total,
            "avg_feedback_turns": sum(r.feedback_turns for r in results) / total,
            "avg_latency_ms": sum(r.latency_ms for r in results) / total,
        }
