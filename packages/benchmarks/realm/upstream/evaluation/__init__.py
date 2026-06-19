"""
REALM-Bench Evaluation Framework (vendored from upstream).

Only ``task_definitions`` is unconditionally exported here because it has
no third-party dependencies. ``metrics`` requires ``numpy``; ``evaluator``
requires ``pandas``/``matplotlib``/``seaborn``. Import them directly from
the submodules if you need the upstream evaluator pipelines.
"""

from .task_definitions import (
    TASK_DEFINITIONS,
    DisruptionType,
    TaskCategory,
    TaskConstraint,
    TaskDefinition,
    TaskGoal,
    TaskResult,
)

__all__ = [
    "TASK_DEFINITIONS",
    "TaskCategory",
    "TaskConstraint",
    "TaskDefinition",
    "TaskGoal",
    "TaskResult",
    "DisruptionType",
]
