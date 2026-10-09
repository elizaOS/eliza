"""ElizaOS Context Benchmark - Evaluating LLM Context Retrieval Capabilities.

This benchmark suite evaluates how well LLMs retrieve and reason about information embedded
in long contexts, including:

- Needle-in-a-Haystack (NIAH): Finding specific information in large contexts
- Semantic NIAH: Retrieval without lexical overlap
- Multi-hop Reasoning: Connecting multiple pieces of information

Key features:
- Position-based analysis (detecting 'lost in the middle' effects)
- Context length scaling analysis
- Semantic similarity evaluation
- Comparison to published leaderboard scores
"""

from elizaos_context_bench.evaluators import (
    PositionAnalyzer,
    RetrievalEvaluator,
)
from elizaos_context_bench.generator import (
    ContextGenerator,
    create_benchmark_suite,
)
from elizaos_context_bench.reporting import (
    ContextBenchReporter,
    save_results,
)
from elizaos_context_bench.runner import (
    ContextBenchRunner,
    quick_test,
    run_eliza_benchmark,
)
from elizaos_context_bench.suites import (
    MultiHopBenchmarkSuite,
    NIAHBenchmarkSuite,
)
from elizaos_context_bench.types import (
    LEADERBOARD_SCORES,
    ContextBenchConfig,
    ContextBenchMetrics,
    ContextBenchResult,
    ContextBenchResults,
    ContextBenchTask,
    ContextBenchType,
    HaystackDomain,
    LengthAccuracy,
    NeedlePosition,
    NeedleType,
    PositionAccuracy,
)

__all__ = [
    # Types
    "ContextBenchConfig",
    "ContextBenchMetrics",
    "ContextBenchResult",
    "ContextBenchResults",
    "ContextBenchTask",
    "ContextBenchType",
    "HaystackDomain",
    "LengthAccuracy",
    "NeedlePosition",
    "NeedleType",
    "PositionAccuracy",
    # Constants
    "LEADERBOARD_SCORES",
    # Generator
    "ContextGenerator",
    "create_benchmark_suite",
    # Runner
    "ContextBenchRunner",
    "quick_test",
    "run_eliza_benchmark",
    # Reporting
    "ContextBenchReporter",
    "save_results",
    # Evaluators
    "PositionAnalyzer",
    "RetrievalEvaluator",
    # Suites
    "MultiHopBenchmarkSuite",
    "NIAHBenchmarkSuite",
]

__version__ = "0.1.0"
