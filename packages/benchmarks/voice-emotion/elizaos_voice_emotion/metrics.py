"""Metric primitives for the voice-emotion bench.

The bench treats every classifier (acoustic Wav2Small, text Stage-1 LM,
text roberta-go-emotions) as an adapter under test and scores its output
against gold labels projected to the same 7-class `EXPRESSIVE_EMOTION_TAGS`
target. The TS runtime adapter
(`plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts`)
ships the same projection table; the test in
`tests/test_metrics.py` asserts the tuple matches byte-for-byte.

All metrics are computed in pure Python (numpy optional) so the smoke test
runs on the CI box without GPU or heavy deps.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Sequence
from typing import Literal

# 7-class target — must stay in sync with the TS adapter
# (`plugins/plugin-local-inference/src/services/voice/expressive-tags.ts`).
EXPRESSIVE_EMOTION_TAGS: tuple[str, ...] = (
    "happy",
    "sad",
    "angry",
    "nervous",
    "calm",
    "excited",
    "whisper",
)


EmotionLabel = Literal[
    "happy",
    "sad",
    "angry",
    "nervous",
    "calm",
    "excited",
    "whisper",
]


@dataclasses.dataclass(frozen=True)
class EmotionRead:
    """One classifier read. Adapters return one of these per utterance."""

    label: EmotionLabel | None
    """Best discrete label, or None when the classifier abstained."""
    confidence: float
    """Confidence in the best label, [0, 1]."""
    scores: dict[str, float]
    """Per-class soft scores aligned with `EXPRESSIVE_EMOTION_TAGS`."""
    vad: tuple[float, float, float] | None = None
    """Continuous V-A-D when the adapter is acoustic; None for text adapters."""
    latency_ms: float = 0.0
    """Wall-time the adapter spent. Used for the bench latency metric."""


def confusion_matrix(
    y_true: Sequence[str],
    y_pred: Sequence[str],
    labels: Sequence[str] = EXPRESSIVE_EMOTION_TAGS,
) -> list[list[int]]:
    """Return a square confusion matrix. `y_true[i]` is the gold label,
    `y_pred[i]` is the predicted label. Rows = true, columns = predicted.
    Predicted labels that fall outside `labels` (e.g. an adapter that
    abstained) are silently skipped — they are the abstention rate, which we
    track separately.
    """
    if len(y_true) != len(y_pred):
        raise ValueError(
            f"y_true ({len(y_true)}) and y_pred ({len(y_pred)}) lengths differ",
        )
    idx = {label: i for i, label in enumerate(labels)}
    n = len(labels)
    matrix = [[0 for _ in range(n)] for _ in range(n)]
    for true_label, pred_label in zip(y_true, y_pred, strict=True):
        ti = idx.get(true_label)
        pi = idx.get(pred_label)
        if ti is None or pi is None:
            continue
        matrix[ti][pi] += 1
    return matrix


def per_class_f1(
    y_true: Sequence[str],
    y_pred: Sequence[str],
    labels: Sequence[str] = EXPRESSIVE_EMOTION_TAGS,
) -> dict[str, float]:
    """Per-class F1, computed from the confusion matrix. A class with zero
    true positives and zero predictions returns F1=0 (cleanest semantic for
    "no signal").
    """
    matrix = confusion_matrix(y_true, y_pred, labels)
    out: dict[str, float] = {}
    for i, label in enumerate(labels):
        tp = matrix[i][i]
        fn = sum(matrix[i][j] for j in range(len(labels)) if j != i)
        fp = sum(matrix[j][i] for j in range(len(labels)) if j != i)
        denom_p = tp + fp
        denom_r = tp + fn
        precision = (tp / denom_p) if denom_p > 0 else 0.0
        recall = (tp / denom_r) if denom_r > 0 else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (
            precision + recall
        ) > 0 else 0.0
        out[label] = round(f1, 6)
    return out


def macro_f1(
    y_true: Sequence[str],
    y_pred: Sequence[str],
    labels: Sequence[str] = EXPRESSIVE_EMOTION_TAGS,
) -> float:
    """Macro F1 — unweighted mean of per-class F1. Standard metric for
    imbalanced classification (matches the gate the manifest validator
    enforces against `EMOTION_CLASSIFIER_MELD_F1_THRESHOLD`).
    """
    f1s = per_class_f1(y_true, y_pred, labels)
    if not f1s:
        return 0.0
    return round(sum(f1s.values()) / len(f1s), 6)
