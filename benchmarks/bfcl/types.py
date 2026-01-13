"""
BFCL Benchmark Type Definitions

Berkeley Function-Calling Leaderboard types for evaluating function-calling capabilities.
Based on the BFCL specification from UC Berkeley's Sky Computing Lab.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class BFCLCategory(str, Enum):
    """Test categories in BFCL benchmark."""

    SIMPLE = "simple"
    MULTIPLE = "multiple"
    PARALLEL = "parallel"
    PARALLEL_MULTIPLE = "parallel_multiple"
    RELEVANCE = "relevance"
    REST_API = "rest_api"
    SQL = "sql"
    JAVA = "java"
    JAVASCRIPT = "javascript"


class BFCLLanguage(str, Enum):
    """Programming languages supported by BFCL."""

    PYTHON = "python"
    JAVA = "java"
    JAVASCRIPT = "javascript"
    SQL = "sql"
    REST = "rest"


class EvaluationType(str, Enum):
    """Types of evaluation in BFCL."""

    AST = "ast"
    EXECUTION = "execution"
    RELEVANCE = "relevance"


@dataclass
class FunctionParameter:
    """A single parameter in a function definition."""

    name: str
    param_type: str
    description: str
    required: bool = True
    enum: Optional[list[str]] = None
    default: Optional[str | int | float | bool] = None
    items: Optional[dict[str, str]] = None  # For array types
    properties: Optional[dict[str, dict[str, str]]] = None  # For object types


@dataclass
class FunctionDefinition:
    """Definition of a function/tool available for calling."""

    name: str
    description: str
    parameters: dict[str, FunctionParameter]
    required_params: list[str] = field(default_factory=list)
    return_type: Optional[str] = None
    category: Optional[str] = None


# Type alias for valid argument values (recursive JSON-like structure)
ArgumentValue = str | int | float | bool | None | list["ArgumentValue"] | dict[str, "ArgumentValue"]


@dataclass
class FunctionCall:
    """A function call with its arguments."""

    name: str
    arguments: dict[str, ArgumentValue]

    def validate(self) -> bool:
        """Validate the function call has required fields."""
        return bool(self.name and isinstance(self.name, str))


@dataclass
class BFCLTestCase:
    """A single BFCL benchmark test case."""

    id: str
    category: BFCLCategory
    question: str
    functions: list[FunctionDefinition]
    expected_calls: list[FunctionCall]
    is_relevant: bool = True  # False for relevance detection tests
    language: BFCLLanguage = BFCLLanguage.PYTHON
    difficulty: str = "medium"
    ground_truth_output: Optional[str] = None  # For execution verification
    has_ground_truth: bool = True  # False if expected_calls is missing/unavailable
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


# Type alias for details dict that can contain lists
ResultDetails = dict[str, str | int | float | bool | list[str]]


@dataclass
class BFCLResult:
    """Result of evaluating a single BFCL test case."""

    test_case_id: str
    category: BFCLCategory
    predicted_calls: list[FunctionCall]
    expected_calls: list[FunctionCall]
    ast_match: bool
    exec_success: bool
    relevance_correct: bool
    latency_ms: float
    error: Optional[str] = None
    raw_response: Optional[str] = None
    details: ResultDetails = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Validate result after initialization."""
        if self.latency_ms < 0:
            raise ValueError("latency_ms must be non-negative")


@dataclass
class CategoryMetrics:
    """Metrics for a single category."""

    category: BFCLCategory
    total_tests: int
    ast_accuracy: float
    exec_accuracy: float
    relevance_accuracy: float
    avg_latency_ms: float


@dataclass
class BFCLMetrics:
    """Comprehensive metrics from BFCL benchmark evaluation."""

    # Overall metrics
    overall_score: float
    ast_accuracy: float
    exec_accuracy: float
    relevance_accuracy: float

    # Per-category breakdown
    category_metrics: dict[BFCLCategory, CategoryMetrics] = field(default_factory=dict)

    # Test counts
    total_tests: int = 0
    passed_tests: int = 0
    failed_tests: int = 0

    # Latency statistics
    latency_p50: float = 0.0
    latency_p95: float = 0.0
    latency_p99: float = 0.0
    avg_latency_ms: float = 0.0

    # Token usage (if available)
    total_tokens: int = 0
    avg_tokens_per_call: float = 0.0

    # Error analysis
    error_counts: dict[str, int] = field(default_factory=dict)


@dataclass
class BFCLConfig:
    """Configuration for BFCL benchmark runner."""

    # Paths
    data_path: str = "./data/bfcl"
    output_dir: str = "./benchmark_results/bfcl"
    cache_dir: str = "./cache/bfcl"

    # Execution settings
    max_tests_per_category: Optional[int] = None
    timeout_per_test_ms: int = 60000  # 1 minute per test
    batch_size: int = 10

    # What to run
    categories: Optional[list[BFCLCategory]] = None  # None = all categories
    run_ast_eval: bool = True
    run_exec_eval: bool = True
    run_relevance_eval: bool = True

    # Dataset settings
    use_huggingface: bool = True
    huggingface_dataset: str = "gorilla-llm/Berkeley-Function-Calling-Leaderboard"
    version: str = "v3"  # BFCL version

    # Reporting
    save_detailed_logs: bool = True
    save_raw_responses: bool = True
    generate_report: bool = True
    compare_baselines: bool = True

    # Model settings
    temperature: float = 0.0  # Temperature for deterministic results


@dataclass
class BaselineScore:
    """Reference score from the BFCL leaderboard."""

    model_name: str
    overall: float
    ast: float
    exec: float
    simple: float = 0.0
    multiple: float = 0.0
    parallel: float = 0.0
    parallel_multiple: float = 0.0
    relevance: float = 0.0
    rest_api: float = 0.0
    sql: float = 0.0
    java: float = 0.0
    javascript: float = 0.0


# Leaderboard reference scores (updated for BFCL v3 2025)
LEADERBOARD_SCORES: dict[str, BaselineScore] = {
    "gpt-4-turbo": BaselineScore(
        model_name="GPT-4 Turbo",
        overall=0.887,
        ast=0.912,
        exec=0.856,
        simple=0.95,
        multiple=0.91,
        parallel=0.88,
        parallel_multiple=0.84,
        relevance=0.92,
        rest_api=0.85,
        sql=0.88,
        java=0.86,
        javascript=0.87,
    ),
    "gpt-5": BaselineScore(
        model_name="GPT-4o",
        overall=0.891,
        ast=0.918,
        exec=0.862,
        simple=0.96,
        multiple=0.92,
        parallel=0.89,
        parallel_multiple=0.85,
        relevance=0.93,
        rest_api=0.86,
        sql=0.89,
        java=0.87,
        javascript=0.88,
    ),
    "claude-3-opus": BaselineScore(
        model_name="Claude 3 Opus",
        overall=0.852,
        ast=0.882,
        exec=0.821,
        simple=0.92,
        multiple=0.88,
        parallel=0.85,
        parallel_multiple=0.81,
        relevance=0.89,
        rest_api=0.82,
        sql=0.85,
        java=0.83,
        javascript=0.84,
    ),
    "claude-3-sonnet": BaselineScore(
        model_name="Claude 3 Sonnet",
        overall=0.823,
        ast=0.854,
        exec=0.792,
        simple=0.89,
        multiple=0.85,
        parallel=0.82,
        parallel_multiple=0.78,
        relevance=0.86,
        rest_api=0.79,
        sql=0.82,
        java=0.80,
        javascript=0.81,
    ),
    "gemini-1.5-pro": BaselineScore(
        model_name="Gemini 1.5 Pro",
        overall=0.845,
        ast=0.875,
        exec=0.815,
        simple=0.91,
        multiple=0.87,
        parallel=0.84,
        parallel_multiple=0.80,
        relevance=0.88,
        rest_api=0.81,
        sql=0.84,
        java=0.82,
        javascript=0.83,
    ),
    "qwen-2.5-72b": BaselineScore(
        model_name="Qwen 2.5 72B",
        overall=0.712,
        ast=0.752,
        exec=0.672,
        simple=0.78,
        multiple=0.74,
        parallel=0.71,
        parallel_multiple=0.67,
        relevance=0.75,
        rest_api=0.68,
        sql=0.71,
        java=0.69,
        javascript=0.70,
    ),
    "llama-3.1-70b": BaselineScore(
        model_name="Llama 3.1 70B",
        overall=0.685,
        ast=0.725,
        exec=0.645,
        simple=0.75,
        multiple=0.71,
        parallel=0.68,
        parallel_multiple=0.64,
        relevance=0.72,
        rest_api=0.65,
        sql=0.68,
        java=0.66,
        javascript=0.67,
    ),
    "mistral-large": BaselineScore(
        model_name="Mistral Large",
        overall=0.698,
        ast=0.738,
        exec=0.658,
        simple=0.76,
        multiple=0.72,
        parallel=0.69,
        parallel_multiple=0.65,
        relevance=0.73,
        rest_api=0.66,
        sql=0.69,
        java=0.67,
        javascript=0.68,
    ),
}


@dataclass
class BFCLBenchmarkResults:
    """Full BFCL benchmark results."""

    metadata: dict[str, str | int | float | bool]
    config: BFCLConfig
    metrics: BFCLMetrics
    results: list[BFCLResult]
    baseline_comparison: dict[str, float] = field(default_factory=dict)
    summary: dict[str, str | list[str]] = field(default_factory=dict)
    model_name: Optional[str] = None  # Which model was used for this run
    provider: Optional[str] = None  # Which provider was used
