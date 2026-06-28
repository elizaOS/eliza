"""Shared utilities for perception detectors."""

from __future__ import annotations

import numpy as np


def cosine_similarity(a: np.ndarray | None, b: np.ndarray | None) -> float:
    """Cosine similarity between two embedding vectors.

    Returns 0.0 if either input is None or has near-zero norm.
    """
    if a is None or b is None:
        return 0.0
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na < 1e-8 or nb < 1e-8:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def bbox_iou(a: np.ndarray, b: np.ndarray) -> float:
    """IoU between two bounding boxes [x1, y1, x2, y2]."""
    x1 = max(a[0], b[0])
    y1 = max(a[1], b[1])
    x2 = min(a[2], b[2])
    y2 = min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0
