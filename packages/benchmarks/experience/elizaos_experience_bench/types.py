"""Types for the experience benchmark."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class BenchmarkSuite(str, Enum):
    """Available benchmark suites."""

    RETRIEVAL = "retrieval"
    RERANKING = "reranking"
    LEARNING_CYCLE = "learning_cycle"
    CROSS_DOMAIN = "cross_domain"
    SCALE = "scale"
    HARD_CASES = "hard_cases"
    ELIZA_AGENT = "eliza_agent"


class BenchmarkMode(str, Enum):
    """Benchmark execution mode."""

    DIRECT = "direct"  # Direct ExperienceService testing (existing behavior)
    ELIZA_AGENT = "eliza_agent"  # Full Eliza agent loop testing


@dataclass
class BenchmarkConfig:
    """Configuration for experience benchmark runs."""

    # Number of synthetic experiences to generate
    num_experiences: int = 1000
    # Domains to generate experiences across
    domains: list[str] = field(
        default_factory=lambda: [
            "coding", "shell", "network", "database", "security",
            "ai", "devops", "testing", "documentation", "performance",
        ]
    )
    # Experience types to generate
    experience_types: list[str] = field(
        default_factory=lambda: [
            "success", "failure", "discovery", "correction",
            "learning", "hypothesis", "validation", "warning",
        ]
    )
    # Number of retrieval queries to test
    num_retrieval_queries: int = 100
    # Top-k values for precision/recall
    top_k_values: list[int] = field(default_factory=lambda: [1, 3, 5, 10])
    # Number of learning cycle scenarios
    num_learning_cycles: int = 20
    # Seed for reproducibility
    seed: int = 42
    # Which suites to run
    suites: list[BenchmarkSuite] = field(
        default_factory=lambda: list(BenchmarkSuite)
    )


@dataclass
class RetrievalMetrics:
    """Metrics for retrieval quality."""

    precision_at_k: dict[int, float] = field(default_factory=dict)
    recall_at_k: dict[int, float] = field(default_factory=dict)
    mean_reciprocal_rank: float = 0.0
    # Fraction of queries where at least one relevant result appeared in top-k
    hit_rate_at_k: dict[int, float] = field(default_factory=dict)


@dataclass
class RerankingMetrics:
    """Metrics for reranking correctness."""

    # Does similarity always dominate? (relevant beats irrelevant)
    similarity_dominance_rate: float = 0.0
    # Do quality signals break ties? (high-quality beats low-quality at same similarity)
    quality_tiebreak_rate: float = 0.0
    # Are truly irrelevant items filtered out?
    noise_rejection_rate: float = 0.0
    # Detailed failure cases
    failures: list[str] = field(default_factory=list)


@dataclass
class LearningCycleMetrics:
    """Metrics for the learn-then-apply cycle."""

    # How often the agent retrieves a relevant past experience when facing a similar problem
    experience_recall_rate: float = 0.0
    # How often the retrieved experience is the correct/useful one
    experience_precision_rate: float = 0.0
    # How many cycles completed successfully end-to-end
    cycle_success_rate: float = 0.0
    # Detailed per-cycle results
    cycle_results: list[dict[str, object]] = field(default_factory=list)


@dataclass
class ScaleMetrics:
    """Metrics for scale and performance."""

    # Query latency at different experience counts (count -> avg ms)
    query_latency_ms: dict[int, float] = field(default_factory=dict)
    # Memory usage estimates
    memory_bytes: dict[int, int] = field(default_factory=dict)


@dataclass
class HardCaseCategoryMetrics:
    """Metrics for a single category of hard cases."""

    category: str
    tier: str
    requires_embeddings: bool
    total: int
    passed: int
    rate: float
    failures: list[str] = field(default_factory=list)


@dataclass
class HardCaseMetrics:
    """Metrics for the hard case benchmark suite."""

    categories: list[HardCaseCategoryMetrics] = field(default_factory=list)
    jaccard_total: int = 0
    jaccard_passed: int = 0
    jaccard_rate: float = 0.0
    semantic_total: int = 0
    semantic_passed: int = 0
    semantic_rate: float = 0.0


@dataclass
class ElizaAgentMetrics:
    """Metrics from the Eliza agent experience benchmark."""

    # Phase 1: Learning
    learning_success_rate: float = 0.0
    total_experiences_recorded: int = 0
    total_experiences_in_service: int = 0
    avg_learning_latency_ms: float = 0.0

    # Phase 2: Agent-mediated retrieval
    agent_recall_rate: float = 0.0
    agent_keyword_incorporation_rate: float = 0.0
    avg_retrieval_latency_ms: float = 0.0

    # Phase 3: Direct service comparison
    direct_recall_rate: float = 0.0
    direct_mrr: float = 0.0


@dataclass
class BenchmarkResult:
    """Combined benchmark results."""

    config: BenchmarkConfig
    retrieval: RetrievalMetrics | None = None
    reranking: RerankingMetrics | None = None
    learning_cycle: LearningCycleMetrics | None = None
    hard_cases: HardCaseMetrics | None = None
    scale: ScaleMetrics | None = None
    eliza_agent: ElizaAgentMetrics | None = None
    total_experiences: int = 0
    total_queries: int = 0
