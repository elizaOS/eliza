"""Per-subtask metrics for VisualWebBench.

Implements the seven scorers from ``VisualWebBench/utils/eval_utils.py``:

    web_caption    -> ROUGE-1/2/L (F1), headline = rouge_l / 100
    heading_ocr    -> ROUGE-1/2/L, headline = rouge_l / 100
    element_ocr    -> ROUGE-1/2/L, headline = rouge_l / 100
    webqa          -> per-sample max ROUGE-1 F1 over reference list (upstream
                      uses ROUGE-1 F1 with ``Rouge`` and calls it "F1")
    element_ground -> MCQ accuracy (letter parse)
    action_pred    -> MCQ accuracy
    action_ground  -> MCQ accuracy

All numeric outputs are 0-100 (upstream scale) in ``result.metrics``; the
``result.score`` field carries the 0-1 normalised headline used for the
overall accuracy aggregate.
"""

from __future__ import annotations

import re
from typing import Sequence

from benchmarks.visualwebbench.types import (
    VisualWebBenchPrediction,
    VisualWebBenchResult,
    VisualWebBenchTask,
    VisualWebBenchTaskType,
)


class VisualWebBenchEvaluator:
    """Score VisualWebBench predictions with upstream-equivalent metrics."""

    def __init__(self, *, bbox_iou_threshold: float = 0.5) -> None:
        self.bbox_iou_threshold = bbox_iou_threshold

    def evaluate(
        self,
        task: VisualWebBenchTask,
        prediction: VisualWebBenchPrediction,
    ) -> VisualWebBenchResult:
        """Score one prediction with its subtask-specific metric."""
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
                metrics={},
                latency_ms=prediction.latency_ms,
                error=prediction.error,
            )

        score, metrics = _score_for_task(task, prediction)
        # Headline success threshold: choice tasks succeed on a correct letter;
        # generative tasks succeed when the headline F1 / ROUGE-L >= 0.5.
        if task.score_kind == "choice":
            success = score >= 1.0
        else:
            success = score >= 0.5

        return VisualWebBenchResult(
            task_id=task.id,
            task_type=task.task_type,
            website=task.website,
            score_kind=task.score_kind,
            score=score,
            success=success,
            expected=task.answer,
            prediction=prediction,
            metrics=metrics,
            latency_ms=prediction.latency_ms,
            error=prediction.error,
        )

    def aggregate(
        self,
        results: Sequence[VisualWebBenchResult],
    ) -> dict[str, float]:
        """Headline aggregate: overall plus per-metric-family means.

        Means are computed on the 0-1 ``score`` field so they sit on a single
        scale. Per-subtask metric breakdowns (rouge_1/rouge_2/rouge_l/f1/
        accuracy) are surfaced separately in the report's ``by_task_type``.
        """
        if not results:
            return {
                "overall_accuracy": 0.0,
                "rouge_score": 0.0,
                "f1_score": 0.0,
                "choice_accuracy": 0.0,
                "average_latency_ms": 0.0,
            }
        return {
            "overall_accuracy": sum(r.score for r in results) / len(results),
            "rouge_score": _mean([r.score for r in results if r.score_kind == "rouge"]),
            "f1_score": _mean([r.score for r in results if r.score_kind == "f1"]),
            "choice_accuracy": _mean(
                [r.score for r in results if r.score_kind == "choice"]
            ),
            "average_latency_ms": sum(r.latency_ms for r in results) / len(results),
        }


# --------------------------------------------------------------------------- #
# Per-task scorers
# --------------------------------------------------------------------------- #


def _score_for_task(
    task: VisualWebBenchTask,
    prediction: VisualWebBenchPrediction,
) -> tuple[float, dict[str, float]]:
    """Dispatch to the right subtask scorer; return (headline_0_1, metrics)."""
    pred = (prediction.answer_text or "").strip()
    tt = task.task_type
    if tt in {
        VisualWebBenchTaskType.WEB_CAPTION,
        VisualWebBenchTaskType.HEADING_OCR,
        VisualWebBenchTaskType.ELEMENT_OCR,
    }:
        gold = str(task.answer) if not isinstance(task.answer, list) else (
            str(task.answer[0]) if task.answer else ""
        )
        metrics = _rouge_scores(pred or " ", gold or " ")
        return metrics["rouge_l"] / 100.0, metrics

    if tt is VisualWebBenchTaskType.WEBQA:
        if isinstance(task.answer, list):
            golds = [str(x) for x in task.answer]
        else:
            golds = [str(task.answer)]
        f1 = _webqa_f1(pred or " ", golds)
        return f1 / 100.0, {"f1": f1}

    # MCQ subtasks
    expected_index = task.answer if isinstance(task.answer, int) else -1
    chosen = _parse_choice_index(prediction, len(task.options) or 8)
    correct = chosen is not None and chosen == expected_index
    return (1.0 if correct else 0.0), {"accuracy": 100.0 if correct else 0.0}


# --------------------------------------------------------------------------- #
# ROUGE scorer — implemented locally to avoid pulling the heavy `rouge` PyPI
# package; uses the same lcs-F1 / ngram-F1 maths as `pyrouge`/upstream.
# --------------------------------------------------------------------------- #


def _rouge_scores(pred: str, gold: str) -> dict[str, float]:
    """Return ROUGE-1, ROUGE-2, ROUGE-L F1s on a 0-100 scale."""
    pred_tokens = _tokenize(pred)
    gold_tokens = _tokenize(gold)
    return {
        "rouge_1": _rouge_n_f1(pred_tokens, gold_tokens, n=1) * 100.0,
        "rouge_2": _rouge_n_f1(pred_tokens, gold_tokens, n=2) * 100.0,
        "rouge_l": _rouge_l_f1(pred_tokens, gold_tokens) * 100.0,
    }


def _tokenize(text: str) -> list[str]:
    # Match the upstream `Rouge` tokenizer behaviour: lowercase + word-ish
    # tokens (strip punctuation, split on whitespace).
    lowered = text.lower()
    return re.findall(r"[a-z0-9]+", lowered)


def _rouge_n_f1(pred: list[str], gold: list[str], *, n: int) -> float:
    if len(pred) < n or len(gold) < n:
        return 0.0
    pred_ngrams = _ngram_counts(pred, n)
    gold_ngrams = _ngram_counts(gold, n)
    overlap = 0
    for ngram, count in pred_ngrams.items():
        overlap += min(count, gold_ngrams.get(ngram, 0))
    pred_total = sum(pred_ngrams.values())
    gold_total = sum(gold_ngrams.values())
    if pred_total == 0 or gold_total == 0:
        return 0.0
    precision = overlap / pred_total
    recall = overlap / gold_total
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


def _ngram_counts(tokens: list[str], n: int) -> dict[tuple[str, ...], int]:
    counts: dict[tuple[str, ...], int] = {}
    for i in range(len(tokens) - n + 1):
        gram = tuple(tokens[i : i + n])
        counts[gram] = counts.get(gram, 0) + 1
    return counts


def _rouge_l_f1(pred: list[str], gold: list[str]) -> float:
    if not pred or not gold:
        return 0.0
    lcs = _lcs_length(pred, gold)
    if lcs == 0:
        return 0.0
    precision = lcs / len(pred)
    recall = lcs / len(gold)
    return 2 * precision * recall / (precision + recall)


def _lcs_length(a: list[str], b: list[str]) -> int:
    m, n = len(a), len(b)
    # 1D DP — O(m*n) time, O(min(m,n)) space.
    if m < n:
        a, b = b, a
        m, n = n, m
    prev = [0] * (n + 1)
    for i in range(1, m + 1):
        curr = [0] * (n + 1)
        for j in range(1, n + 1):
            if a[i - 1] == b[j - 1]:
                curr[j] = prev[j - 1] + 1
            else:
                curr[j] = max(prev[j], curr[j - 1])
        prev = curr
    return prev[n]


# --------------------------------------------------------------------------- #
# WebQA F1 — upstream uses Rouge-1 F1 across each reference and takes the max.
# --------------------------------------------------------------------------- #


def _webqa_f1(pred: str, gold_list: list[str]) -> float:
    best = 0.0
    for gold in gold_list:
        score = _rouge_n_f1(_tokenize(pred), _tokenize(gold), n=1) * 100.0
        if score > best:
            best = score
    return best


# --------------------------------------------------------------------------- #
# Multiple choice parsing — adapted from upstream `parse_multi_choice_response`.
# Returns a 0-based index (A=0, B=1, ...).
# --------------------------------------------------------------------------- #


def _parse_choice_index(
    prediction: VisualWebBenchPrediction,
    option_count: int,
) -> int | None:
    # Prefer an explicit structured choice_index if the agent supplied one.
    if prediction.choice_index is not None:
        idx = prediction.choice_index
        if 0 <= idx < max(option_count, 1):
            return idx
        return None

    response = (prediction.answer_text or "").strip()
    if not response:
        return None
    if len(response) == 1 and response.upper().isalpha():
        letter = response.upper()
        index = ord(letter) - ord("A")
        return index if 0 <= index < max(option_count, 1) else None
    match = re.match(r"^([A-Za-z])[\.\):]", response)
    if match:
        index = ord(match.group(1).upper()) - ord("A")
        return index if 0 <= index < max(option_count, 1) else None

    cleaned = response
    for char in [",", ".", "!", "?", ";", ":", "'", '"']:
        cleaned = cleaned.replace(char, "")
    cleaned = " " + cleaned + " "
    all_choices = [chr(ord("A") + i) for i in range(max(option_count, 1))]

    candidates: list[str] = []
    ans_with_brack = False
    for choice in all_choices:
        if f"({choice})" in cleaned:
            candidates.append(choice)
            ans_with_brack = True
    if not candidates:
        for choice in all_choices:
            if f" {choice} " in cleaned:
                candidates.append(choice)
    if not candidates:
        return None
    if len(candidates) == 1:
        return ord(candidates[0]) - ord("A")

    # Multiple matches — take the one that appears last in the response, which
    # is upstream's tie-break heuristic.
    indices: list[int] = []
    for can in candidates:
        token = f"({can})" if ans_with_brack else f" {can} "
        indices.append(cleaned.rfind(token))
    best = candidates[max(range(len(candidates)), key=lambda i: indices[i])]
    return ord(best) - ord("A")


def _mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)
