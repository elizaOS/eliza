"""
RLM (Recursive Language Model) Benchmark Suite.

This benchmark evaluates RLM's performance on long-context tasks as described
in the paper "Recursive Language Models: Training LLMs to Process Arbitrarily
Long Inputs" (arXiv:2512.24601).

Benchmarks included:
- S-NIAH (Streaming NIAH): Needle-in-a-haystack with streaming contexts
- OOLONG: Long document retrieval and reasoning
- OOLONG-Pairs: Paired document comparison tasks
- RLM Strategy Analysis: Evaluating emergent RLM patterns

Execution modes:
- stub: Fast heuristic-based mock (for testing)
- rlm: Direct RLM plugin inference (bypasses Eliza runtime)
- eliza: Full Eliza agent loop (Provider -> Model -> Action -> Evaluator)
- custom: Custom LLM query function

Reference:
    - Paper: https://arxiv.org/abs/2512.24601
    - Table 1: S-NIAH results at 100M+ tokens
    - Table 2: OOLONG benchmark comparisons
    - Figure 3: Cost vs accuracy tradeoffs
"""

from .types import (
    RLMBenchConfig,
    RLMBenchMetrics,
    RLMBenchResult,
    RLMBenchResults,
    RLMBenchTask,
    RLMBenchType,
    RLMStrategyMetrics,
)
from .runner import RLMBenchRunner, run_eliza_benchmark, setup_eliza_runner
from .generator import RLMBenchGenerator
from .evaluator import RLMBenchEvaluator
from .reporting import RLMBenchReporter, save_results

__all__ = [
    # Types
    "RLMBenchConfig",
    "RLMBenchMetrics",
    "RLMBenchResult",
    "RLMBenchResults",
    "RLMBenchTask",
    "RLMBenchType",
    "RLMStrategyMetrics",
    # Runner
    "RLMBenchRunner",
    "run_eliza_benchmark",
    "setup_eliza_runner",
    # Generator
    "RLMBenchGenerator",
    # Evaluator
    "RLMBenchEvaluator",
    # Reporting
    "RLMBenchReporter",
    "save_results",
]
