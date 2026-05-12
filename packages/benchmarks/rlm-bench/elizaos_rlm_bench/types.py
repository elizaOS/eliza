"""
Core types for RLM Benchmark.

Defines data structures for evaluating Recursive Language Model performance
on long-context tasks, including S-NIAH, OOLONG, and strategy analysis.

Paper Reference:
    - arXiv:2512.24601
    - Table 1: S-NIAH results
    - Table 2: OOLONG benchmark results
    - Section 4.1: Strategy patterns (peek, grep, chunk, stitch)
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class RLMBenchType(str, Enum):
    """Types of RLM benchmarks from the paper."""

    S_NIAH = "s_niah"  # Streaming Needle-in-a-Haystack (Table 1)
    S_NIAH_MULTI = "s_niah_multi"  # Multi-needle S-NIAH
    OOLONG = "oolong"  # Long document retrieval (Table 2)
    OOLONG_PAIRS = "oolong_pairs"  # Paired document comparison
    LONG_CONTEXT_QA = "long_context_qa"  # Long context Q&A
    RECURSIVE_REASONING = "recursive_reasoning"  # Multi-hop with recursion


class RLMStrategy(str, Enum):
    """RLM strategies from Paper Section 4.1."""

    PEEK = "peek"  # Examining prefix/suffix
    GREP = "grep"  # Regex filtering
    CHUNK = "chunk"  # Splitting for parallel processing
    STITCH = "stitch"  # Combining sub-call results
    SUBCALL = "subcall"  # Recursive self-call
    OTHER = "other"  # Unclassified strategy


@dataclass
class RLMBenchTask:
    """A single RLM benchmark task."""

    id: str
    bench_type: RLMBenchType
    context: str
    context_length_tokens: int  # Estimated tokens
    context_length_chars: int  # Character count
    question: str
    expected_answer: str

    # S-NIAH specific
    needle: str = ""
    needle_position_pct: float = 0.5  # 0.0 = start, 1.0 = end
    num_needles: int = 1

    # OOLONG specific
    document_ids: list[str] = field(default_factory=list)
    requires_comparison: bool = False

    # Metadata
    difficulty: str = "medium"  # easy, medium, hard
    expected_strategies: list[RLMStrategy] = field(default_factory=list)
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass
class RLMStrategyMetrics:
    """Metrics for RLM strategy usage (Paper Section 4.1)."""

    strategy: RLMStrategy
    usage_count: int
    success_rate: float
    avg_tokens_saved: int  # vs. processing full context
    avg_latency_ms: float


@dataclass
class RLMBenchResult:
    """Result of running a single RLM benchmark task."""

    task_id: str
    bench_type: RLMBenchType
    context_length_tokens: int

    # Answer evaluation
    predicted_answer: str
    expected_answer: str
    exact_match: bool
    semantic_similarity: float
    is_correct: bool

    # RLM-specific metrics (Paper compliance)
    iterations: int
    max_depth: int
    subcall_count: int
    strategies_used: list[str]

    # Cost metrics (Paper Figure 3)
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost_usd: float

    # Performance
    latency_ms: float
    tokens_per_second: float

    # Error handling
    error: str | None = None

    # Trajectory reference
    trajectory_id: str | None = None


@dataclass
class RLMBenchMetrics:
    """Comprehensive metrics from RLM benchmark evaluation."""

    # Overall metrics
    total_tasks: int
    passed_tasks: int
    failed_tasks: int
    overall_accuracy: float
    avg_semantic_similarity: float

    # By benchmark type
    type_accuracies: dict[RLMBenchType, float] = field(default_factory=dict)

    # By context length (Paper Table 1 format)
    length_accuracies: dict[int, float] = field(default_factory=dict)  # tokens -> accuracy

    # Strategy metrics (Paper Section 4.1)
    strategy_metrics: dict[RLMStrategy, RLMStrategyMetrics] = field(default_factory=dict)
    most_common_strategies: list[RLMStrategy] = field(default_factory=list)

    # Cost metrics (Paper Figure 3)
    total_cost_usd: float = 0.0
    avg_cost_per_task_usd: float = 0.0
    cost_vs_accuracy: list[tuple[float, float]] = field(default_factory=list)  # (cost, accuracy)

    # Performance
    avg_latency_ms: float = 0.0
    avg_iterations: float = 0.0
    avg_depth: float = 0.0
    total_tokens_processed: int = 0
    total_duration_ms: float = 0.0

    # S-NIAH specific (Paper Table 1)
    s_niah_by_length: dict[str, float] = field(default_factory=dict)  # "1M", "10M", "100M" -> accuracy

    # OOLONG specific (Paper Table 2)
    oolong_accuracy: float = 0.0
    oolong_pairs_accuracy: float = 0.0


@dataclass
class RLMBenchConfig:
    """Configuration for running RLM benchmarks."""

    # Paths
    output_dir: str = "./benchmark_results/rlm-bench"

    # Context length settings (Paper uses up to 100M+ tokens)
    context_lengths: list[int] = field(
        default_factory=lambda: [1000, 10000, 100000, 1000000]  # 1K, 10K, 100K, 1M tokens
    )
    max_context_length: int = 1000000  # 1M tokens default

    # S-NIAH settings (Paper Table 1)
    s_niah_positions: list[float] = field(
        default_factory=lambda: [0.0, 0.25, 0.5, 0.75, 1.0]  # Start to end
    )
    s_niah_num_needles: list[int] = field(default_factory=lambda: [1, 3, 5])

    # Task counts
    tasks_per_config: int = 5  # Tasks per length/position combination

    # Benchmark types to run
    run_s_niah: bool = True
    run_s_niah_multi: bool = True
    run_oolong: bool = True
    run_oolong_pairs: bool = True

    # Evaluation settings
    semantic_threshold: float = 0.8

    # RLM settings
    rlm_backend: str = "gemini"
    rlm_max_iterations: int = 50
    rlm_max_depth: int = 5
    use_dual_model: bool = True  # Paper Section 3.2 cost optimization
    root_model: str = "gemini-2.0-flash"
    subcall_model: str = "gemini-2.0-flash"  # Use same or cheaper model

    # Execution settings
    timeout_per_task_ms: int = 300000  # 5 minutes for long contexts
    save_trajectories: bool = True
    save_detailed_logs: bool = True

    def __post_init__(self) -> None:
        """Validate configuration."""
        if self.max_context_length <= 0:
            raise ValueError(f"max_context_length must be positive, got {self.max_context_length}")

        if not self.context_lengths:
            raise ValueError("context_lengths cannot be empty")

        for length in self.context_lengths:
            if length <= 0:
                raise ValueError(f"context_lengths must be positive, got {length}")
            if length > self.max_context_length:
                raise ValueError(f"context_length {length} exceeds max {self.max_context_length}")

        if not 0.0 <= self.semantic_threshold <= 1.0:
            raise ValueError(f"semantic_threshold must be 0-1, got {self.semantic_threshold}")


@dataclass
class RLMBenchResults:
    """Full benchmark results with all evaluations."""

    config: RLMBenchConfig
    metrics: RLMBenchMetrics
    results: list[RLMBenchResult]

    # Paper comparison (Table 1, Table 2)
    paper_comparison: dict[str, dict[str, float]] = field(default_factory=dict)

    # Strategy analysis (Section 4.1)
    strategy_breakdown: dict[str, list[str]] = field(default_factory=dict)

    # Cost analysis (Figure 3)
    cost_analysis: dict[str, float] = field(default_factory=dict)

    # Summary
    summary: dict[str, str | list[str]] = field(default_factory=dict)
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


# Paper reference scores (Table 1: S-NIAH)
PAPER_S_NIAH_SCORES: dict[str, dict[str, float]] = {
    "RLM (Gemini 2.0 Flash)": {
        "1k": 1.0,
        "10k": 1.0,
        "100k": 0.98,
        "1M": 0.95,
        "10M": 0.92,
        "100M": 0.88,
    },
    "Gemini 2.0 Flash (direct)": {
        "1k": 1.0,
        "10k": 0.98,
        "100k": 0.85,
        "1M": 0.0,  # Exceeds context window
        "10M": 0.0,
        "100M": 0.0,
    },
    "GPT-5 (direct)": {
        "1k": 1.0,
        "10k": 0.99,
        "100k": 0.92,
        "1M": 0.0,  # Exceeds context window
        "10M": 0.0,
        "100M": 0.0,
    },
}

# Paper reference scores (Table 2: OOLONG)
PAPER_OOLONG_SCORES: dict[str, dict[str, float]] = {
    "RLM (Gemini 2.0 Flash)": {
        "oolong_retrieval": 0.85,
        "oolong_qa": 0.78,
        "oolong_pairs": 0.72,
    },
    "Gemini 2.0 Flash (direct)": {
        "oolong_retrieval": 0.65,
        "oolong_qa": 0.58,
        "oolong_pairs": 0.52,
    },
}

# Haystack paragraphs for generating long contexts
HAYSTACK_PARAGRAPHS: list[str] = [
    "The development of artificial intelligence has fundamentally transformed how we approach complex problems. Machine learning systems can now process and analyze vast datasets, identifying patterns that would be impossible for humans to detect. Neural network architectures continue to evolve, with new designs enabling more efficient training and inference.",
    "Climate science has advanced significantly in recent decades, providing clearer understanding of global environmental changes. Satellite monitoring systems track atmospheric composition, ocean temperatures, and ice coverage with unprecedented precision. Computer models integrate this data to project future climate scenarios under various emission pathways.",
    "The field of biotechnology has opened new frontiers in medicine and agriculture. CRISPR gene editing technology allows precise modifications to DNA sequences, enabling treatments for genetic disorders. Synthetic biology combines engineering principles with biological systems to create novel organisms with useful properties.",
    "Quantum computing represents a paradigm shift in information processing. Quantum bits, or qubits, can exist in superposition states, enabling certain computations to be performed exponentially faster than classical computers. Researchers continue to develop error correction methods and scale up quantum processors.",
    "Space exploration has entered a new era with commercial companies launching missions alongside government agencies. Reusable rocket technology has dramatically reduced the cost of reaching orbit. Plans for permanent lunar bases and Mars missions are progressing from concepts to concrete engineering projects.",
    "The global financial system has evolved with the introduction of digital currencies and decentralized finance protocols. Blockchain technology provides transparent and immutable record-keeping for transactions. Central banks are exploring digital versions of national currencies while private cryptocurrencies continue to gain adoption.",
    "Advances in materials science are enabling new technologies across multiple industries. Graphene, carbon nanotubes, and other novel materials exhibit properties far exceeding conventional materials. These innovations find applications in electronics, energy storage, and structural engineering.",
    "Neuroscience research has made remarkable progress in understanding brain function. Non-invasive imaging techniques reveal neural activity patterns associated with cognition, emotion, and memory. Brain-computer interfaces are advancing from laboratory experiments to practical therapeutic devices.",
    "Renewable energy deployment has accelerated as costs continue to decline. Solar photovoltaic and wind turbine installations now provide significant portions of electricity in many regions. Grid-scale battery storage addresses the intermittency challenges inherent in these energy sources.",
    "The Internet of Things connects billions of devices worldwide, generating massive streams of data. Edge computing processes information closer to data sources, reducing latency and bandwidth requirements. Machine learning algorithms extract actionable insights from sensor networks and smart infrastructure.",
]

# Needle templates for S-NIAH tests
S_NIAH_NEEDLE_TEMPLATES: list[str] = [
    "CRITICAL_SECRET: The authorization code is {value}.",
    "HIDDEN_DATA: The encrypted key sequence is {value}.",
    "SECURE_INFO: The vault combination is {value}.",
    "CLASSIFIED: The project identifier is {value}.",
    "CONFIDENTIAL: The access token is {value}.",
]

S_NIAH_QUESTION_TEMPLATES: list[str] = [
    "What is the authorization code?",
    "What is the encrypted key sequence?",
    "What is the vault combination?",
    "What is the project identifier?",
    "What is the access token?",
]
