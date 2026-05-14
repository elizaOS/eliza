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
    """Test categories in BFCL benchmark.

    Mirrors the upstream BFCL v3/v4 category taxonomy from
    https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/bfcl_eval/constants/category_mapping.py
    """

    # Non-live single-turn
    SIMPLE = "simple"
    MULTIPLE = "multiple"
    PARALLEL = "parallel"
    PARALLEL_MULTIPLE = "parallel_multiple"
    RELEVANCE = "relevance"
    IRRELEVANCE = "irrelevance"
    REST_API = "rest_api"
    SQL = "sql"
    JAVA = "java"
    JAVASCRIPT = "javascript"

    # Live (user-contributed) single-turn
    LIVE_SIMPLE = "live_simple"
    LIVE_MULTIPLE = "live_multiple"
    LIVE_PARALLEL = "live_parallel"
    LIVE_PARALLEL_MULTIPLE = "live_parallel_multiple"
    LIVE_RELEVANCE = "live_relevance"
    LIVE_IRRELEVANCE = "live_irrelevance"

    # Multi-turn (stateful tool-use trajectories)
    MULTI_TURN_BASE = "multi_turn_base"
    MULTI_TURN_MISS_FUNC = "multi_turn_miss_func"
    MULTI_TURN_MISS_PARAM = "multi_turn_miss_param"
    MULTI_TURN_LONG_CONTEXT = "multi_turn_long_context"

    # Agentic (v4)
    WEB_SEARCH_BASE = "web_search_base"
    WEB_SEARCH_NO_SNIPPET = "web_search_no_snippet"
    MEMORY_KV = "memory_kv"
    MEMORY_VECTOR = "memory_vector"
    MEMORY_REC_SUM = "memory_rec_sum"

    # Non-scoring (v4)
    FORMAT_SENSITIVITY = "format_sensitivity"


# Convenience groupings (match upstream `category_mapping.py`)
NON_LIVE_CATEGORIES: list[BFCLCategory] = [
    BFCLCategory.SIMPLE,
    BFCLCategory.MULTIPLE,
    BFCLCategory.PARALLEL,
    BFCLCategory.PARALLEL_MULTIPLE,
    BFCLCategory.IRRELEVANCE,
    BFCLCategory.JAVA,
    BFCLCategory.JAVASCRIPT,
]

LIVE_CATEGORIES: list[BFCLCategory] = [
    BFCLCategory.LIVE_SIMPLE,
    BFCLCategory.LIVE_MULTIPLE,
    BFCLCategory.LIVE_PARALLEL,
    BFCLCategory.LIVE_PARALLEL_MULTIPLE,
    BFCLCategory.LIVE_RELEVANCE,
    BFCLCategory.LIVE_IRRELEVANCE,
]

MULTI_TURN_CATEGORIES: list[BFCLCategory] = [
    BFCLCategory.MULTI_TURN_BASE,
    BFCLCategory.MULTI_TURN_MISS_FUNC,
    BFCLCategory.MULTI_TURN_MISS_PARAM,
    BFCLCategory.MULTI_TURN_LONG_CONTEXT,
]

WEB_SEARCH_CATEGORIES: list[BFCLCategory] = [
    BFCLCategory.WEB_SEARCH_BASE,
    BFCLCategory.WEB_SEARCH_NO_SNIPPET,
]

MEMORY_CATEGORIES: list[BFCLCategory] = [
    BFCLCategory.MEMORY_KV,
    BFCLCategory.MEMORY_VECTOR,
    BFCLCategory.MEMORY_REC_SUM,
]

AGENTIC_CATEGORIES: list[BFCLCategory] = WEB_SEARCH_CATEGORIES + MEMORY_CATEGORIES

# Categories that require network/external services to evaluate executably.
# These are marked SKIPPED_NO_CREDENTIALS (and excluded from the accuracy
# denominator) unless the runner is started with `enable_network=True`.
NETWORK_REQUIRED_CATEGORIES: set[BFCLCategory] = {
    BFCLCategory.REST_API,
    BFCLCategory.WEB_SEARCH_BASE,
    BFCLCategory.WEB_SEARCH_NO_SNIPPET,
}


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
    MULTI_TURN = "multi_turn"
    AGENTIC = "agentic"


class TestStatus(str, Enum):
    """Status of a single test case run.

    Anything starting with ``skipped_`` is excluded from the accuracy denominator
    (with a logged warning) and surfaced in a dedicated bucket in the run summary.
    """
    # Tell pytest not to try to collect this enum as a test class.
    __test__ = False

    PASSED = "passed"
    FAILED = "failed"
    SKIPPED_NO_CREDENTIALS = "skipped_no_credentials"
    SKIPPED_NO_GROUND_TRUTH = "skipped_no_ground_truth"
    SKIPPED_UNSUPPORTED = "skipped_unsupported"
    ERROR = "error"


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
    """A single BFCL benchmark test case.

    For single-turn categories, ``question`` is the flattened user prompt.
    For multi-turn categories, ``turns`` carries each conversational round
    (list of message dicts), and ``initial_config`` / ``involved_classes``
    drive the stateful tool runtime.
    """

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
    # Multi-turn / agentic fields
    turns: Optional[list[list[dict[str, str]]]] = None
    initial_config: Optional[dict[str, object]] = None
    involved_classes: Optional[list[str]] = None
    excluded_function: Optional[list[str]] = None
    # Multi-turn ground truth: per-turn list of upstream-style call strings.
    multi_turn_ground_truth: Optional[list[list[str]]] = None


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
    # Status drives whether this test counts toward the accuracy denominator.
    # Skipped buckets are reported separately in the run summary.
    status: TestStatus = TestStatus.PASSED

    def __post_init__(self) -> None:
        """Validate result after initialization."""
        if self.latency_ms < 0:
            raise ValueError("latency_ms must be non-negative")

    @property
    def is_skipped(self) -> bool:
        return self.status.value.startswith("skipped_")


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
    skipped_tests: int = 0  # Excluded from accuracy denominator
    skipped_by_reason: dict[str, int] = field(default_factory=dict)

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
    version: str = "v3"  # BFCL version ("v3" or "v4")
    sample_seed: int = 0

    # Reporting
    save_detailed_logs: bool = True
    save_raw_responses: bool = True
    generate_report: bool = True
    compare_baselines: bool = True

    # Model settings
    temperature: float = 0.0  # Temperature for deterministic results

    # Network-gated categories (REST API, web_search) only run when the user
    # explicitly opts in. Otherwise they're marked SKIPPED_NO_CREDENTIALS and
    # excluded from the accuracy denominator.
    enable_network: bool = False

    # Multi-turn loop limit. Each conversational "turn" in a multi_turn_*
    # entry may itself require several agent steps to satisfy.
    max_multi_turn_steps: int = 20


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
    "claude-opus-4-7": BaselineScore(
        model_name="Claude Opus 4.7",
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
    "claude-sonnet-4-6": BaselineScore(
        model_name="Claude Sonnet 4.6",
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
