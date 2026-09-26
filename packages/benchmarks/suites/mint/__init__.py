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
        }
    if name in types_attrs:
        from . import types
        return getattr(types, name)
    component_map = {
        "MINTDataset": (".dataset", "MINTDataset"),
        "PythonExecutor": (".executor", "PythonExecutor"),
        "MockExecutor": (".executor", "MockExecutor"),
        "FeedbackGenerator": (".feedback", "FeedbackGenerator"),
        "MINTAgent": (".agent", "MINTAgent"),
        "MINTEvaluator": (".evaluator", "MINTEvaluator"),
        "MINTRunner": (".runner", "MINTRunner"),
        "MetricsCalculator": (".metrics", "MetricsCalculator"),
        "MINTReporter": (".reporting", "MINTReporter"),
    }
    if name in component_map:
        module_name, attr = component_map[name]
        import importlib
        return getattr(importlib.import_module(module_name, __package__), attr)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
