"""Agent trust & security benchmark for ElizaOS."""

from elizaos_trust_bench.baselines import PerfectHandler, RandomHandler
from elizaos_trust_bench.corpus import TEST_CORPUS, get_corpus
from elizaos_trust_bench.runner import TrustBenchmarkRunner
from elizaos_trust_bench.scorer import score_results
from elizaos_trust_bench.types import (
    BenchmarkConfig,
    BenchmarkResult,
    CategoryScore,
    DetectionResult,
    Difficulty,
    ThreatCategory,
    TrustHandler,
    TrustTestCase,
)

# ElizaTrustHandler is optional — requires elizaos + elizaos-plugin-openai
try:
    from elizaos_trust_bench.eliza_handler import ElizaTrustHandler
except ImportError:
    ElizaTrustHandler = None  # type: ignore[misc, assignment]

__all__ = [
    "BenchmarkConfig",
    "BenchmarkResult",
    "CategoryScore",
    "DetectionResult",
    "Difficulty",
    "ElizaTrustHandler",
    "PerfectHandler",
    "RandomHandler",
    "TEST_CORPUS",
    "ThreatCategory",
    "TrustBenchmarkRunner",
    "TrustHandler",
    "TrustTestCase",
    "get_corpus",
    "score_results",
]
