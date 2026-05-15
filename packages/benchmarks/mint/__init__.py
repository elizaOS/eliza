"""
MINT Benchmark — ElizaOS port of the UIUC MINT benchmark.

Faithfully implements the multi-turn evaluation protocol from
Wang et al., ICLR 2024 (arXiv:2309.10691):

    - 8 subtasks (humaneval, mbpp, math, gsm8k, hotpotqa, mmlu, theoremqa,
      alfworld) loaded from upstream's sampled JSON files, lazy-fetched into
      a local cache when needed.
    - Multi-turn interaction (assistant -> tool -> feedback -> retry).
    - Turn-k success rate as the headline metric.
    - Optional GPT-4 language feedback using the upstream prompt template.

See ``upstream/README.md`` for vendoring + attribution.
"""

__all__ = [
    # Types (canonical names).
    "MINTSubtask",
    "MINTTaskType",
    "MINTConfig",
    "MINTMetrics",
    "MINTResult",
    "MINTTask",
    "MINTTrajectory",
    "Turn",
    "TurnType",
    "EvaluationMetric",
    "LEADERBOARD_SCORES",
    "PAPER_RESULTS_URL",
    "SUBTASK_TO_TASK_TYPE",
    # Back-compat alias.
    "MINTCategory",
    # Components.
    "MINTDataset",
    "PythonExecutor",
    "MockExecutor",
    "FeedbackGenerator",
    "MINTAgent",
    "MINTEvaluator",
    "MINTRunner",
    "MetricsCalculator",
    "MINTReporter",
]


def __getattr__(name: str):
    types_attrs = {
        "MINTSubtask",
        "MINTTaskType",
        "MINTConfig",
        "MINTMetrics",
        "MINTResult",
        "MINTTask",
        "MINTTrajectory",
        "Turn",
        "TurnType",
        "EvaluationMetric",
        "LEADERBOARD_SCORES",
        "PAPER_RESULTS_URL",
        "SUBTASK_TO_TASK_TYPE",
        "MINTCategory",
    }
    if name in types_attrs:
        from benchmarks.mint import types
        return getattr(types, name)
    component_map = {
        "MINTDataset": ("benchmarks.mint.dataset", "MINTDataset"),
        "PythonExecutor": ("benchmarks.mint.executor", "PythonExecutor"),
        "MockExecutor": ("benchmarks.mint.executor", "MockExecutor"),
        "FeedbackGenerator": ("benchmarks.mint.feedback", "FeedbackGenerator"),
        "MINTAgent": ("benchmarks.mint.agent", "MINTAgent"),
        "MINTEvaluator": ("benchmarks.mint.evaluator", "MINTEvaluator"),
        "MINTRunner": ("benchmarks.mint.runner", "MINTRunner"),
        "MetricsCalculator": ("benchmarks.mint.metrics", "MetricsCalculator"),
        "MINTReporter": ("benchmarks.mint.reporting", "MINTReporter"),
    }
    if name in component_map:
        module_name, attr = component_map[name]
        import importlib
        return getattr(importlib.import_module(module_name), attr)
    raise AttributeError(f"module 'benchmarks.mint' has no attribute {name!r}")
