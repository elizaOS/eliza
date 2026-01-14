"""Core types for Context Benchmark.

Defines data structures for evaluating LLM context retrieval and reasoning
capabilities, including Needle-in-a-Haystack (NIAH) and multi-hop benchmarks.
"""

from dataclasses import dataclass, field
from enum import Enum


class ContextBenchType(str, Enum):
    """Types of context benchmarks."""

    NIAH_BASIC = "niah_basic"  # Basic needle retrieval
    NIAH_SEQUENTIAL = "niah_sequential"  # Sequential info extraction
    NIAH_SEMANTIC = "niah_semantic"  # No lexical overlap
    MULTI_HOP = "multi_hop"  # Multi-hop reasoning
    LONG_DOC_QA = "long_doc_qa"  # Long document Q&A
    RAG = "rag"  # Retrieval-augmented generation


class NeedlePosition(str, Enum):
    """Position of needle in haystack context."""

    START = "start"  # First 10% of context
    EARLY = "early"  # 10-30% of context
    MIDDLE = "middle"  # 40-60% of context
    LATE = "late"  # 70-90% of context
    END = "end"  # Last 10% of context
    RANDOM = "random"  # Random position


class NeedleType(str, Enum):
    """Types of needle content."""

    FACT = "fact"  # Simple factual statement
    NUMBER = "number"  # Numeric data
    DATE = "date"  # Date/time information
    NAME = "name"  # Named entity
    CODE = "code"  # Code snippet


class HaystackDomain(str, Enum):
    """Domain of haystack content."""

    GENERAL = "general"
    TECHNICAL = "technical"
    SCIENTIFIC = "scientific"
    NARRATIVE = "narrative"
    FINANCIAL = "financial"
    LEGAL = "legal"


@dataclass
class ContextBenchTask:
    """A single context benchmark task."""

    id: str
    bench_type: ContextBenchType
    context: str
    context_length: int  # In tokens (approximate)
    question: str
    needle: str
    needle_position: NeedlePosition
    expected_answer: str
    actual_position_pct: float = 0.0  # Actual position as percentage
    requires_reasoning: bool = False
    num_hops: int = 1
    needle_type: NeedleType = NeedleType.FACT
    haystack_domain: HaystackDomain = HaystackDomain.GENERAL
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass
class ContextBenchResult:
    """Result of running a single context benchmark task."""

    task_id: str
    bench_type: ContextBenchType
    context_length: int
    needle_position: NeedlePosition
    actual_position_pct: float
    predicted_answer: str
    expected_answer: str
    exact_match: bool
    semantic_similarity: float
    retrieval_success: bool
    latency_ms: float
    tokens_processed: int
    num_hops: int = 1
    error: str | None = None
    metrics: dict[str, float] = field(default_factory=dict)


@dataclass
class PositionAccuracy:
    """Accuracy metrics by needle position."""

    position: NeedlePosition
    total_tasks: int
    correct_tasks: int
    accuracy: float
    avg_semantic_similarity: float
    avg_latency_ms: float


@dataclass
class LengthAccuracy:
    """Accuracy metrics by context length."""

    context_length: int
    total_tasks: int
    correct_tasks: int
    accuracy: float
    avg_semantic_similarity: float
    avg_latency_ms: float


@dataclass
class ContextBenchMetrics:
    """Comprehensive metrics from context benchmark evaluation."""

    # Overall metrics
    total_tasks: int
    passed_tasks: int
    failed_tasks: int
    overall_accuracy: float
    avg_semantic_similarity: float

    # Position analysis
    position_accuracies: dict[NeedlePosition, PositionAccuracy] = field(
        default_factory=dict
    )
    lost_in_middle_score: float = 0.0  # How much worse is middle vs edges

    # Length analysis
    length_accuracies: dict[int, LengthAccuracy] = field(default_factory=dict)
    context_degradation_rate: float = 0.0  # Accuracy drop per doubling of context

    # By benchmark type
    type_accuracies: dict[ContextBenchType, float] = field(default_factory=dict)

    # Multi-hop analysis
    multi_hop_success_rates: dict[int, float] = field(
        default_factory=dict
    )  # By number of hops

    # Performance
    avg_latency_ms: float = 0.0
    avg_tokens_per_task: int = 0
    total_duration_ms: float = 0.0


@dataclass
class ContextBenchConfig:
    """Configuration for running context benchmarks."""

    # Paths
    data_path: str = "./data/context-bench"
    output_dir: str = "./benchmark_results/context-bench"

    # Context length settings
    context_lengths: list[int] = field(
        default_factory=lambda: [1024, 2048, 4096, 8192, 16384, 32768]
    )
    max_context_length: int = 32768

    # Position sweep settings
    positions: list[NeedlePosition] = field(
        default_factory=lambda: [
            NeedlePosition.START,
            NeedlePosition.EARLY,
            NeedlePosition.MIDDLE,
            NeedlePosition.LATE,
            NeedlePosition.END,
        ]
    )

    # Task settings
    tasks_per_position: int = 5  # Number of tasks per position-length combo
    multi_hop_depths: list[int] = field(
        default_factory=lambda: [1, 2, 3]
    )  # Number of reasoning hops

    # Benchmark types to run
    run_niah_basic: bool = True
    run_niah_semantic: bool = True
    run_multi_hop: bool = True
    run_long_doc_qa: bool = False  # Requires datasets

    # Evaluation settings
    semantic_threshold: float = 0.8  # Threshold for semantic match
    use_embeddings: bool = True
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"

    # Execution
    timeout_per_task_ms: int = 60000
    save_detailed_logs: bool = True
    generate_report: bool = True
    generate_heatmap: bool = True

    def __post_init__(self) -> None:
        """Validate configuration after initialization."""
        # Validate max context length first (so context length checks are meaningful)
        if self.max_context_length <= 0:
            raise ValueError(f"max_context_length must be positive, got {self.max_context_length}")

        # Validate context lengths
        if not self.context_lengths:
            raise ValueError("context_lengths cannot be empty")
        for length in self.context_lengths:
            if not isinstance(length, int) or length <= 0:
                raise ValueError(f"context_lengths must contain positive integers, got {length}")
            if length > self.max_context_length:
                raise ValueError(
                    f"context_length {length} exceeds max_context_length {self.max_context_length}"
                )

        # Validate positions
        if not self.positions:
            raise ValueError("positions cannot be empty")

        # Validate tasks per position
        if self.tasks_per_position <= 0:
            raise ValueError(f"tasks_per_position must be positive, got {self.tasks_per_position}")

        # Validate multi-hop depths
        for depth in self.multi_hop_depths:
            if not isinstance(depth, int) or depth < 1:
                raise ValueError(f"multi_hop_depths must contain positive integers >= 1, got {depth}")

        # Validate semantic threshold
        if not 0.0 <= self.semantic_threshold <= 1.0:
            raise ValueError(f"semantic_threshold must be between 0 and 1, got {self.semantic_threshold}")

        # Validate timeout
        if self.timeout_per_task_ms <= 0:
            raise ValueError(f"timeout_per_task_ms must be positive, got {self.timeout_per_task_ms}")


@dataclass
class ContextBenchResults:
    """Full benchmark results with all evaluations."""

    config: ContextBenchConfig
    metrics: ContextBenchMetrics
    results: list[ContextBenchResult]
    # 2D: positions x lengths (labels stored separately so reporting can't mislabel)
    position_heatmap: list[list[float]] | None = None
    position_heatmap_lengths: list[int] | None = None
    position_heatmap_positions: list[NeedlePosition] | None = None
    comparison_to_leaderboard: dict[str, dict[str, float]] = field(
        default_factory=dict
    )
    summary: dict[str, str | list[str]] = field(default_factory=dict)
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


# Leaderboard reference scores from NIAH papers and LongBench
LEADERBOARD_SCORES: dict[str, dict[str, float]] = {
    "gpt-4-turbo": {
        "niah_4k": 0.98,
        "niah_8k": 0.97,
        "niah_16k": 0.95,
        "niah_32k": 0.93,
        "niah_64k": 0.89,
        "niah_128k": 0.82,
        "lost_in_middle": 0.12,  # Lower is better
        "multi_hop_2": 0.88,
        "multi_hop_3": 0.72,
        "overall": 0.91,
    },
    "gpt-5": {
        "niah_4k": 0.99,
        "niah_8k": 0.98,
        "niah_16k": 0.97,
        "niah_32k": 0.95,
        "niah_64k": 0.92,
        "niah_128k": 0.87,
        "lost_in_middle": 0.08,
        "multi_hop_2": 0.91,
        "multi_hop_3": 0.78,
        "overall": 0.94,
    },
    "claude-3-opus": {
        "niah_4k": 0.99,
        "niah_8k": 0.98,
        "niah_16k": 0.97,
        "niah_32k": 0.96,
        "niah_64k": 0.94,
        "niah_128k": 0.90,
        "lost_in_middle": 0.05,
        "multi_hop_2": 0.92,
        "multi_hop_3": 0.81,
        "overall": 0.95,
    },
    "claude-3-sonnet": {
        "niah_4k": 0.98,
        "niah_8k": 0.96,
        "niah_16k": 0.94,
        "niah_32k": 0.90,
        "niah_64k": 0.85,
        "niah_128k": 0.78,
        "lost_in_middle": 0.15,
        "multi_hop_2": 0.85,
        "multi_hop_3": 0.68,
        "overall": 0.88,
    },
    "llama-3.1-70b": {
        "niah_4k": 0.95,
        "niah_8k": 0.92,
        "niah_16k": 0.88,
        "niah_32k": 0.82,
        "niah_64k": 0.75,
        "niah_128k": 0.65,
        "lost_in_middle": 0.22,
        "multi_hop_2": 0.78,
        "multi_hop_3": 0.55,
        "overall": 0.80,
    },
    "mistral-large": {
        "niah_4k": 0.94,
        "niah_8k": 0.90,
        "niah_16k": 0.85,
        "niah_32k": 0.78,
        "niah_64k": 0.70,
        "niah_128k": 0.60,
        "lost_in_middle": 0.25,
        "multi_hop_2": 0.75,
        "multi_hop_3": 0.52,
        "overall": 0.76,
    },
}

# Default haystack text samples for generating contexts
DEFAULT_HAYSTACK_PARAGRAPHS: list[str] = [
    "The development of artificial intelligence has been one of the most significant technological advances of the 21st century. Machine learning algorithms can now process vast amounts of data and make predictions with remarkable accuracy. Deep neural networks have revolutionized computer vision, natural language processing, and many other fields.",
    "Climate change represents one of the greatest challenges facing humanity today. Rising global temperatures are causing more frequent extreme weather events, melting ice caps, and rising sea levels. Scientists worldwide are working on solutions to reduce carbon emissions and mitigate the effects of climate change.",
    "The global economy has undergone significant transformations in recent decades. International trade has expanded dramatically, connecting markets across continents. Digital currencies and blockchain technology are reshaping how we think about money and financial transactions.",
    "Space exploration continues to push the boundaries of human knowledge. New missions to Mars and the outer planets are revealing unprecedented details about our solar system. Private companies are now playing an increasingly important role in developing space technology and services.",
    "Medical research has achieved remarkable breakthroughs in recent years. Gene therapy and personalized medicine are opening new possibilities for treating previously incurable diseases. Advances in biotechnology are helping us understand the fundamental mechanisms of life.",
    "The internet has transformed virtually every aspect of modern society. Social media platforms connect billions of people worldwide, while e-commerce has revolutionized retail. Cloud computing enables businesses to scale their operations with unprecedented flexibility.",
    "Renewable energy technologies are becoming increasingly cost-effective and widespread. Solar and wind power capacity continues to grow rapidly around the world. Battery storage technology is addressing the challenge of intermittent renewable energy generation.",
    "Education is evolving to meet the demands of the digital age. Online learning platforms have made quality education accessible to millions of people globally. New teaching methods emphasize critical thinking, creativity, and collaboration.",
    "Urban populations continue to grow, driving innovation in city planning and infrastructure. Smart city technologies are helping to manage traffic, reduce pollution, and improve public services. Sustainable urban development is becoming a priority for cities worldwide.",
    "Biodiversity loss poses a significant threat to ecosystems around the world. Conservation efforts are working to protect endangered species and their habitats. Understanding and preserving biodiversity is essential for maintaining the health of our planet.",
]

# Needle templates for generating test cases
NEEDLE_TEMPLATES: dict[NeedleType, list[str]] = {
    NeedleType.FACT: [
        "The secret code for the vault is {value}.",
        "The headquarters is located at {value}.",
        "The project's codename is {value}.",
        "The password to access the system is {value}.",
        "The meeting point has been set to {value}.",
    ],
    NeedleType.NUMBER: [
        "The total budget allocated was exactly ${value}.",
        "The experiment recorded a temperature of {value} degrees Celsius.",
        "The population count reached {value} individuals.",
        "The speed measured was {value} kilometers per hour.",
        "The compound's molecular weight is {value}.",
    ],
    NeedleType.DATE: [
        "The deadline for submission is {value}.",
        "The company was founded on {value}.",
        "The event is scheduled for {value}.",
        "The treaty was signed on {value}.",
        "The discovery was made on {value}.",
    ],
    NeedleType.NAME: [
        "The lead researcher is Dr. {value}.",
        "The CEO's name is {value}.",
        "The architect who designed it was {value}.",
        "The author of the report is {value}.",
        "The inventor was {value}.",
    ],
    NeedleType.CODE: [
        "The API endpoint is {value}.",
        "The function to call is {value}.",
        "The configuration key is {value}.",
        "The error code returned was {value}.",
        "The command to execute is {value}.",
    ],
}

# Question templates corresponding to needle types
QUESTION_TEMPLATES: dict[NeedleType, list[str]] = {
    NeedleType.FACT: [
        "What is the secret code for the vault?",
        "Where is the headquarters located?",
        "What is the project's codename?",
        "What is the password to access the system?",
        "What is the meeting point?",
    ],
    NeedleType.NUMBER: [
        "What was the total budget allocated?",
        "What temperature did the experiment record?",
        "What was the population count?",
        "What speed was measured?",
        "What is the compound's molecular weight?",
    ],
    NeedleType.DATE: [
        "What is the deadline for submission?",
        "When was the company founded?",
        "When is the event scheduled?",
        "When was the treaty signed?",
        "When was the discovery made?",
    ],
    NeedleType.NAME: [
        "Who is the lead researcher?",
        "What is the CEO's name?",
        "Who designed it?",
        "Who is the author of the report?",
        "Who was the inventor?",
    ],
    NeedleType.CODE: [
        "What is the API endpoint?",
        "What function should be called?",
        "What is the configuration key?",
        "What error code was returned?",
        "What command should be executed?",
    ],
}
