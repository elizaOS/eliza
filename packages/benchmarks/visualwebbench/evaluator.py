"""Scoring stubs for VisualWebBench."""

from __future__ import annotations

import re
import string

from benchmarks.visualwebbench.types import (
    BBox,
    VisualWebBenchPrediction,
    VisualWebBenchResult,
    VisualWebBenchTask,
)


class VisualWebBenchEvaluator:
    """Evaluate exact, choice, and bbox-style VisualWebBench predictions."""

    def __init__(self, *, bbox_iou_threshold: float = 0.5) -> None:
        self.bbox_iou_threshold = bbox_iou_threshold

    def evaluate(
        self,
        task: VisualWebBenchTask,
        prediction: VisualWebBenchPrediction,
    ) -> VisualWebBenchResult:
        """Score one prediction."""
        if prediction.error:
            return VisualWebBenchResult(
                task_id=task.id,
                task_type=task.task_type,
                website=task.website,
                score_kind=task.score_kind,
                score=0.0,
                success=False,
                expected=task.answer,
                prediction=prediction,
                exact_match=False,
                choice_match=False,
                bbox_iou=None,
                latency_ms=prediction.latency_ms,
                error=prediction.error,
            )

        exact_match = False
        choice_match = False
        bbox_iou: float | None = None
        score = 0.0

        if task.score_kind == "exact":
            exact_match = self._score_exact(task.answer, prediction.answer_text)
            score = 1.0 if exact_match else 0.0
        elif task.score_kind == "choice":
            choice_match = self._score_choice(task, prediction)
            score = 1.0 if choice_match else 0.0
        else:
            choice_match = self._score_choice(task, prediction)
            expected_bbox = self._expected_bbox(task)
            if expected_bbox is not None and prediction.bbox is not None:
                bbox_iou = _bbox_iou(expected_bbox, prediction.bbox)
            elif choice_match:
                bbox_iou = 1.0
            score = 1.0 if choice_match or (bbox_iou or 0.0) >= self.bbox_iou_threshold else 0.0

        return VisualWebBenchResult(
            task_id=task.id,
            task_type=task.task_type,
            website=task.website,
            score_kind=task.score_kind,
            score=score,
            success=score >= 1.0,
            expected=task.answer,
            prediction=prediction,
            exact_match=exact_match,
            choice_match=choice_match,
            bbox_iou=bbox_iou,
            latency_ms=prediction.latency_ms,
            error=prediction.error,
        )

    def aggregate(self, results: list[VisualWebBenchResult]) -> dict[str, float]:
        """Compute headline aggregate metrics."""
        if not results:
            return {
                "overall_accuracy": 0.0,
                "exact_accuracy": 0.0,
                "choice_accuracy": 0.0,
                "bbox_accuracy": 0.0,
                "average_latency_ms": 0.0,
            }
        return {
            "overall_accuracy": sum(r.score for r in results) / len(results),
            "exact_accuracy": _mean(r.score for r in results if r.score_kind == "exact"),
            "choice_accuracy": _mean(r.score for r in results if r.score_kind == "choice"),
            "bbox_accuracy": _mean(r.score for r in results if r.score_kind == "bbox"),
            "average_latency_ms": sum(r.latency_ms for r in results) / len(results),
        }

    def _score_exact(self, expected: str | int | list[str] | BBox, predicted: str) -> bool:
        refs = expected if isinstance(expected, list) else [expected]
        pred_norm = _normalize_text(predicted)
        for ref in refs:
            ref_norm = _normalize_text(str(ref))
            if not ref_norm:
                continue
            if pred_norm == ref_norm:
                return True
            if len(ref_norm) >= 2 and ref_norm in pred_norm:
                return True
        return False

    def _score_choice(
        self,
        task: VisualWebBenchTask,
        prediction: VisualWebBenchPrediction,
    ) -> bool:
        if not isinstance(task.answer, int):
            return False
        if prediction.choice_index is not None:
            return prediction.choice_index == task.answer
        if not prediction.answer_text or not isinstance(task.options, list):
            return False
        options = task.options
        if task.answer < 0 or task.answer >= len(options):
            return False
        parsed_choice = _parse_choice_index(prediction.answer_text, len(options))
        if parsed_choice is not None:
            return parsed_choice == task.answer
        expected_option = options[task.answer]
        if not isinstance(expected_option, str):
            return False
        return _normalize_text(prediction.answer_text) == _normalize_text(expected_option)

    def _expected_bbox(self, task: VisualWebBenchTask) -> BBox | None:
        if isinstance(task.answer, tuple):
            return task.answer
        if isinstance(task.answer, int) and task.options:
            if 0 <= task.answer < len(task.options):
                selected = task.options[task.answer]
                if isinstance(selected, tuple):
                    return selected
        return task.bbox


def _normalize_text(value: str) -> str:
    value = value.strip().lower()
    value = value.translate(str.maketrans("", "", string.punctuation))
    value = re.sub(r"\s+", " ", value)
    return value


def _bbox_iou(a: BBox, b: BBox) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    inter_w = max(0.0, inter_x2 - inter_x1)
    inter_h = max(0.0, inter_y2 - inter_y1)
    intersection = inter_w * inter_h
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - intersection
    return intersection / union if union > 0 else 0.0


def _parse_choice_index(text: str, option_count: int) -> int | None:
    """Parse common model choice formats into a zero-based index."""
    normalized = text.strip()
    if not normalized:
        return None

    letter_pattern = re.compile(
        r"(?:^|[^A-Za-z0-9])(?:option|choice|answer)?\s*(?:is\s*)?[\(\[]?([A-Z])[\)\].:]?(?=$|[^A-Za-z0-9])",
        flags=re.IGNORECASE,
    )
    for letter_match in letter_pattern.finditer(normalized):
        index = ord(letter_match.group(1).upper()) - ord("A")
        if 0 <= index < option_count:
            return index

    number_pattern = re.compile(
        r"(?:^|[^A-Za-z0-9])(?:option|choice|answer|index)?\s*(?:is\s*)?[\(\[]?(\d+)[\)\].:]?(?=$|[^A-Za-z0-9])",
        flags=re.IGNORECASE,
    )
    for number_match in number_pattern.finditer(normalized):
        value = int(number_match.group(1))
        if value == 0:
            return 0 if option_count > 0 else None
        index = value - 1
        if 0 <= index < option_count:
            return index

    return None


def _mean(values: object) -> float:
    vals = list(values)  # type: ignore[arg-type]
    return sum(vals) / len(vals) if vals else 0.0
