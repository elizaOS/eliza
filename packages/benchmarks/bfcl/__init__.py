"""
BFCL Benchmark - Berkeley Function-Calling Leaderboard

This benchmark evaluates LLMs' function-calling (tool use) capabilities
across multiple dimensions including AST correctness, execution success,
and relevance detection.

Based on the BFCL benchmark from UC Berkeley's Sky Computing Lab.

Key Features:
- Multi-language support: Python, Java, JavaScript, SQL, REST API
- Multiple evaluation types: AST, Execution, Relevance Detection
- Parallel and sequential function calling
- Leaderboard-compatible scoring

Usage:
    from benchmarks.bfcl import BFCLRunner, BFCLConfig

    config = BFCLConfig()
    runner = BFCLRunner(config)
    results = await runner.run()

    print(f"Overall Score: {results.metrics.overall_score:.2%}")

CLI Usage:
    python -m benchmarks.bfcl --help
    python -m benchmarks.bfcl run --sample 50
    python -m benchmarks.bfcl run --full

Resources:
- Leaderboard: https://gorilla.cs.berkeley.edu/leaderboard
- GitHub: https://github.com/ShishirPatil/gorilla
- Dataset: https://huggingface.co/datasets/gorilla-llm/Berkeley-Function-Calling-Leaderboard
"""

from benchmarks.bfcl.types import (
    ArgumentValue,
    BFCLCategory,
    BFCLConfig,
    BFCLLanguage,
    BFCLMetrics,
    BFCLResult,
    BFCLTestCase,
    BFCLBenchmarkResults,
    BaselineScore,
    CategoryMetrics,
    EvaluationType,
    FunctionCall,
    FunctionDefinition,
    FunctionParameter,
    ResultDetails,
    LEADERBOARD_SCORES,
)
from benchmarks.bfcl.dataset import BFCLDataset
from benchmarks.bfcl.parser import FunctionCallParser
from benchmarks.bfcl.plugin import (
    BFCLPluginFactory,
    FunctionCallCapture,
    create_function_action,
    generate_function_schema,
    generate_openai_tools_format,
    get_call_capture,
)
from benchmarks.bfcl.agent import BFCLAgent, MockBFCLAgent
from benchmarks.bfcl.evaluators import (
    ASTEvaluator,
    ExecutionEvaluator,
    RelevanceEvaluator,
)
from benchmarks.bfcl.runner import BFCLRunner, run_bfcl_benchmark
from benchmarks.bfcl.metrics import MetricsCalculator
from benchmarks.bfcl.reporting import BFCLReporter, print_results

__version__ = "1.0.0"

__all__ = [
    # Version
    "__version__",
    # Types
    "ArgumentValue",
    "BFCLCategory",
    "BFCLConfig",
    "BFCLLanguage",
    "BFCLMetrics",
    "BFCLResult",
    "BFCLTestCase",
    "BFCLBenchmarkResults",
    "BaselineScore",
    "CategoryMetrics",
    "EvaluationType",
    "FunctionCall",
    "FunctionDefinition",
    "FunctionParameter",
    "ResultDetails",
    "LEADERBOARD_SCORES",
    # Dataset
    "BFCLDataset",
    # Parser
    "FunctionCallParser",
    # Plugin
    "BFCLPluginFactory",
    "FunctionCallCapture",
    "create_function_action",
    "generate_function_schema",
    "generate_openai_tools_format",
    "get_call_capture",
    # Agent
    "BFCLAgent",
    "MockBFCLAgent",
    # Evaluators
    "ASTEvaluator",
    "ExecutionEvaluator",
    "RelevanceEvaluator",
    # Runner
    "BFCLRunner",
    "run_bfcl_benchmark",
    # Metrics
    "MetricsCalculator",
    # Reporting
    "BFCLReporter",
    "print_results",
]
