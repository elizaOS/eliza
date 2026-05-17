"""Loaders for the 165 official tau-bench tasks.

The upstream task lists live under ``elizaos_tau_bench.upstream.envs.{retail,airline}``
as Python modules of ``Task`` literals. We expose iterators that pair each task
with its (domain, index) so the runner doesn't need to know about Python
imports.

The four hand-written 'sample' tasks remain only for ``--use-sample-tasks``
smoke runs; they exercise the harness without needing an LLM.
"""

from __future__ import annotations

from typing import Iterator, Optional

from elizaos_tau_bench.types import DomainName, Task, TaskSplit


def _load_retail_tasks(split: TaskSplit) -> list[Task]:
    if split == "test":
        from elizaos_tau_bench.upstream.envs.retail.tasks_test import TASKS_TEST
        return list(TASKS_TEST)
    if split == "dev":
        from elizaos_tau_bench.upstream.envs.retail.tasks_dev import TASKS_DEV
        return list(TASKS_DEV)
    if split == "train":
        from elizaos_tau_bench.upstream.envs.retail.tasks_train import TASKS_TRAIN
        return list(TASKS_TRAIN)
    raise ValueError(f"Unknown retail split: {split}")


def _load_airline_tasks(split: TaskSplit) -> list[Task]:
    if split == "test":
        from elizaos_tau_bench.upstream.envs.airline.tasks_test import TASKS
        return list(TASKS)
    raise ValueError(f"Airline only has 'test' split (got {split!r})")


def load_domain_tasks(domain: DomainName, split: TaskSplit = "test") -> list[Task]:
    if domain == "retail":
        return _load_retail_tasks(split)
    if domain == "airline":
        return _load_airline_tasks(split)
    raise ValueError(f"Unknown domain: {domain}")


def task_count(domain: DomainName, split: TaskSplit = "test") -> int:
    return len(load_domain_tasks(domain, split))


def iter_tasks(
    domains: list[DomainName],
    split: TaskSplit = "test",
    task_ids: Optional[list[int]] = None,
    start_index: int = 0,
    end_index: int = -1,
    max_per_domain: Optional[int] = None,
) -> Iterator[tuple[DomainName, int, Task]]:
    """Yield (domain, task_index, Task) for each task to run.

    ``task_index`` is the index within the upstream list — passed directly to
    ``Env.reset(task_index=...)`` so reward calculations replay the ground
    truth actions correctly.
    """
    for domain in domains:
        tasks = load_domain_tasks(domain, split)
        if task_ids is not None:
            indices = [i for i in task_ids if 0 <= i < len(tasks)]
        else:
            end = len(tasks) if end_index < 0 else min(end_index, len(tasks))
            indices = list(range(start_index, end))
        if max_per_domain is not None:
            indices = indices[:max_per_domain]
        for idx in indices:
            yield domain, idx, tasks[idx]


# --- Sample tasks (smoke only) -------------------------------------------------
# Four tiny hand-written tasks for harness smoke tests when no LLM is available.
# These reuse real upstream Task ids so the env still works, but they are NOT
# part of the official benchmark and are gated behind --use-sample-tasks.

SAMPLE_TASKS: dict[DomainName, list[int]] = {
    "retail": [0, 1],
    "airline": [0, 1],
}


def iter_sample_tasks(
    domains: list[DomainName],
    split: TaskSplit = "test",
    task_ids: Optional[list[int]] = None,
    start_index: int = 0,
    end_index: int = -1,
    max_per_domain: Optional[int] = None,
) -> Iterator[tuple[DomainName, int, Task]]:
    for domain in domains:
        tasks = load_domain_tasks(domain, split)
        indices = [idx for idx in SAMPLE_TASKS.get(domain, []) if idx < len(tasks)]
        if task_ids is not None:
            selected = set(task_ids)
            indices = [idx for idx in indices if idx in selected]
        else:
            end = max(indices) + 1 if end_index < 0 and indices else end_index
            indices = [idx for idx in indices if start_index <= idx < end]
        if max_per_domain is not None:
            indices = indices[:max_per_domain]
        for idx in indices:
            if idx < len(tasks):
                yield domain, idx, tasks[idx]


__all__ = [
    "load_domain_tasks",
    "task_count",
    "iter_tasks",
    "iter_sample_tasks",
    "SAMPLE_TASKS",
]
