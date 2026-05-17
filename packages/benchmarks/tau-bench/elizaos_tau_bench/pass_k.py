"""pass^k metric from the tau-bench paper.

Unlike pass@k (probability *at least one* of k attempts succeeds),
pass^k = probability that *all* k independent attempts succeed.

We use the unbiased estimator from the paper:

    pass^k = E_task [ C(c, k) / C(n, k) ]

where n is the total number of trials run for a task and c is the number
that succeeded. This matches Sierra's reference implementation:

    https://github.com/sierra-research/tau-bench/blob/.../tau_bench/run.py
"""

from __future__ import annotations

from math import comb
from typing import Iterable

from elizaos_tau_bench.types import TaskRunResult


def _pass_hat_k_for_task(num_successes: int, num_trials: int, k: int) -> float:
    if k > num_trials:
        return 0.0
    if k <= 0:
        return 1.0
    denom = comb(num_trials, k)
    if denom == 0:
        return 0.0
    return comb(num_successes, k) / denom


def calculate_pass_hat_k(results: Iterable[TaskRunResult], k: int) -> tuple[float, int]:
    """Return (pass^k, num_tasks).

    Results are grouped by (domain, task_id); each task contributes one
    pass^k score and the mean is returned.
    """
    grouped: dict[tuple[str, int], list[TaskRunResult]] = {}
    for r in results:
        grouped.setdefault((r.domain, r.task_id), []).append(r)

    if not grouped:
        return 0.0, 0

    per_task = []
    for trials in grouped.values():
        n = len(trials)
        c = sum(1 for t in trials if t.success)
        per_task.append(_pass_hat_k_for_task(c, n, k))

    return sum(per_task) / len(per_task), len(per_task)


__all__ = ["calculate_pass_hat_k"]
