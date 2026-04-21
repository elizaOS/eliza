"""
Orchestrated SWE-bench benchmark.

Tests whether an Eliza agent can correctly orchestrate coding tasks
through sub-agent providers (Claude Code, SWE-Agent, Eliza Code) and
compares orchestrated performance against direct execution.
"""

from .types import (
    OrchestratedBenchmarkConfig,
    OrchestratedBenchmarkReport,
    ProviderBenchmarkResult,
    ProviderType,
)
from .trace import RunTraceRecorder

try:
    from .runner import OrchestratedSWEBenchRunner
except ModuleNotFoundError:  # pragma: no cover - optional benchmark dependency
    OrchestratedSWEBenchRunner = None  # type: ignore[assignment]

__all__ = [
    "OrchestratedBenchmarkConfig",
    "OrchestratedBenchmarkReport",
    "ProviderBenchmarkResult",
    "ProviderType",
    "RunTraceRecorder",
]

if OrchestratedSWEBenchRunner is not None:
    __all__.append("OrchestratedSWEBenchRunner")
