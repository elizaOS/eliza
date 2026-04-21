"""
MINT Benchmark - Multi-turn Interaction with Tools and Language Feedback

This benchmark evaluates LLMs' capabilities in handling complex tasks through
multi-turn interactions with tool use and natural language feedback.

Based on the ICLR 2024 paper: "MINT: Evaluating LLMs in Multi-turn Interaction
with Tools and Language Feedback" by Wang et al.

Categories:
- Reasoning: Mathematical and logical problems
- Coding: Programming challenges
- Decision Making: Sequential decision tasks
- Information Seeking: Knowledge retrieval tasks
"""

# Lazy imports to avoid circular dependencies
__all__ = [
    # Types
    "MINTCategory",
    "MINTConfig",
    "MINTMetrics",
    "MINTResult",
    "MINTTask",
    "MINTTrajectory",
    "Turn",
    "TurnType",
    # Components
    "MINTDataset",
    "PythonExecutor",
    "FeedbackGenerator",
    "MINTAgent",
    "MINTEvaluator",
    "MINTRunner",
    "MetricsCalculator",
    "MINTReporter",
]


def __getattr__(name: str):
    """Lazy import of benchmark components."""
    if name in (
        "MINTCategory", "MINTConfig", "MINTMetrics", "MINTResult",
        "MINTTask", "MINTTrajectory", "Turn", "TurnType",
    ):
        from benchmarks.mint import types
        return getattr(types, name)
    elif name == "MINTDataset":
        from benchmarks.mint.dataset import MINTDataset
        return MINTDataset
    elif name == "PythonExecutor":
        from benchmarks.mint.executor import PythonExecutor
        return PythonExecutor
    elif name == "FeedbackGenerator":
        from benchmarks.mint.feedback import FeedbackGenerator
        return FeedbackGenerator
    elif name == "MINTAgent":
        from benchmarks.mint.agent import MINTAgent
        return MINTAgent
    elif name == "MINTEvaluator":
        from benchmarks.mint.evaluator import MINTEvaluator
        return MINTEvaluator
    elif name == "MINTRunner":
        from benchmarks.mint.runner import MINTRunner
        return MINTRunner
    elif name == "MetricsCalculator":
        from benchmarks.mint.metrics import MetricsCalculator
        return MetricsCalculator
    elif name == "MINTReporter":
        from benchmarks.mint.reporting import MINTReporter
        return MINTReporter
    raise AttributeError(f"module 'benchmarks.mint' has no attribute '{name}'")
