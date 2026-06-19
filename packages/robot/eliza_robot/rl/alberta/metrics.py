"""Continual-learning metrics over a task x phase performance matrix.

Given ``T`` tasks trained sequentially, ``R[i, j]`` is the evaluated performance
on task ``j`` *after* finishing the training phase for task ``i`` (rows = phases
in training order, columns = tasks). ``baseline[j]`` is the performance on task
``j`` of the untrained (random-init) policy. From this we compute the standard
continual-learning metrics (Lopez-Paz & Ranzato 2017; Chaudhry et al. 2018),
which are the agreed currency for "learns without forgetting":

- **ACC** — final average performance: ``mean_j R[T-1, j]``. Higher is better.
- **BWT** — backward transfer: how learning later tasks changed earlier ones,
  ``mean_{j<T-1} (R[T-1, j] - R[j, j])``. Negative ⇒ catastrophic forgetting;
  near-zero or positive ⇒ retention.
- **Forgetting** — average drop from each task's best-ever to its final score,
  ``mean_{j<T-1} (max_{j<=l<T-1} R[l, j] - R[T-1, j])``. Lower is better.
- **FWT** — forward transfer: did earlier training help a task before it was
  trained, ``mean_{j>=1} (R[j-1, j] - baseline[j])``. Higher is better.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class ContinualMetrics:
    acc: float
    bwt: float
    forgetting: float
    fwt: float
    final_per_task: list[float] = field(default_factory=list)
    diagonal_per_task: list[float] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "acc": self.acc,
            "bwt": self.bwt,
            "forgetting": self.forgetting,
            "fwt": self.fwt,
            "final_per_task": self.final_per_task,
            "diagonal_per_task": self.diagonal_per_task,
        }


def compute_continual_metrics(
    matrix: np.ndarray,
    baseline: np.ndarray | None = None,
) -> ContinualMetrics:
    """Compute ACC / BWT / Forgetting / FWT from a ``(T, T)`` performance matrix.

    Args:
        matrix: ``R[i, j]`` = performance on task ``j`` after training phase ``i``.
        baseline: optional length-``T`` random-init performance per task (for FWT).
    """
    R = np.asarray(matrix, dtype=np.float64)
    if R.ndim != 2 or R.shape[0] != R.shape[1]:
        raise ValueError(f"matrix must be square (T, T); got {R.shape}")
    T = R.shape[0]

    final_row = R[T - 1]
    acc = float(np.mean(final_row))
    diagonal = np.array([R[j, j] for j in range(T)], dtype=np.float64)

    if T > 1:
        bwt = float(np.mean([R[T - 1, j] - R[j, j] for j in range(T - 1)]))
        forgetting = float(
            np.mean(
                [
                    max(0.0, float(np.max(R[j:T, j]) - R[T - 1, j]))
                    for j in range(T - 1)
                ]
            )
        )
    else:
        bwt = 0.0
        forgetting = 0.0

    if baseline is not None and T > 1:
        b = np.asarray(baseline, dtype=np.float64)
        fwt = float(np.mean([R[j - 1, j] - b[j] for j in range(1, T)]))
    else:
        fwt = 0.0

    return ContinualMetrics(
        acc=acc,
        bwt=bwt,
        forgetting=forgetting,
        fwt=fwt,
        final_per_task=[float(x) for x in final_row],
        diagonal_per_task=[float(x) for x in diagonal],
    )
