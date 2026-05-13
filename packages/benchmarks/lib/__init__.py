"""
Shared library modules for the elizaOS benchmarks package.

Exposes:

  - :class:`ResultsStore` — store benchmark run history in a local SQLite db.
  - :class:`BaseBenchmarkClient` — shared scaffolding (retry, cost, telemetry,
    concurrency) that the hermes / openclaw / eliza adapter clients all
    subclass. See ``base_benchmark_client.py``.
"""

from .base_benchmark_client import (
    CEREBRAS_GPT_OSS_120B_PRICING,
    MAX_ATTEMPTS,
    BaseBenchmarkClient,
    ModelPricing,
    RetryExhaustedError,
    TurnTelemetry,
    backoff_seconds,
    compute_cost_usd,
    is_retryable_status,
    parse_retry_after,
)
from .results_store import (
    BenchmarkRun,
    ComparisonResult,
    ResultsStore,
    default_db_path,
)

__all__ = [
    "BaseBenchmarkClient",
    "BenchmarkRun",
    "CEREBRAS_GPT_OSS_120B_PRICING",
    "ComparisonResult",
    "MAX_ATTEMPTS",
    "ModelPricing",
    "ResultsStore",
    "RetryExhaustedError",
    "TurnTelemetry",
    "backoff_seconds",
    "compute_cost_usd",
    "default_db_path",
    "is_retryable_status",
    "parse_retry_after",
]
