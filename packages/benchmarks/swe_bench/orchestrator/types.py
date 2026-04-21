"""
Types for the orchestrated SWE-bench benchmark.

Defines provider types, configuration, and reporting structures for
benchmarking orchestrated vs direct task execution.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from ..types import SWEBenchConfig, SWEBenchResult


class ProviderType(str, Enum):
    """Available sub-agent provider types for orchestrated execution."""

    CLAUDE_CODE = "claude-code"
    SWE_AGENT = "swe-agent"
    CODEX = "codex"
    ELIZA_CODE = "eliza-code"


class ExecutionMode(str, Enum):
    """Control-plane mode for provider execution."""

    ORCHESTRATED = "orchestrated"
    DIRECT_SHELL = "direct_shell"


@dataclass
class ProviderBenchmarkResult:
    """Benchmark results for a single provider on a single instance."""

    provider: ProviderType
    instance_id: str
    swe_result: SWEBenchResult

    # Orchestration-specific metrics
    control_plane_mode: ExecutionMode = ExecutionMode.ORCHESTRATED
    orchestration_time_seconds: float = 0.0
    task_description_generated: str = ""
    delegation_successful: bool = False
    provider_execution_time_seconds: float = 0.0
    declared_capabilities: list[str] = field(default_factory=list)
    observed_capabilities: list[str] = field(default_factory=list)
    capability_violations: list[str] = field(default_factory=list)

    # Comparison: was there a direct (non-orchestrated) result for same instance?
    direct_result: SWEBenchResult | None = None
    trace_file: str | None = None

    def improvement_over_direct(self) -> str:
        """Summarize whether orchestration improved over direct execution."""
        if self.direct_result is None:
            return "no_comparison"
        if self.swe_result.success and not self.direct_result.success:
            return "improvement"
        if not self.swe_result.success and self.direct_result.success:
            return "regression"
        if self.swe_result.success and self.direct_result.success:
            # Both succeeded - compare speed
            if self.swe_result.duration_seconds < self.direct_result.duration_seconds:
                return "faster"
            return "same_success"
        return "both_failed"


@dataclass
class OrchestratedBenchmarkConfig(SWEBenchConfig):
    """Configuration for orchestrated SWE-bench benchmark.

    Extends the base SWEBenchConfig with orchestration-specific settings.
    """

    # Which providers to benchmark
    providers: list[ProviderType] = field(
        default_factory=lambda: [
            ProviderType.CLAUDE_CODE,
            ProviderType.SWE_AGENT,
            ProviderType.CODEX,
        ]
    )

    # Control-plane mode:
    # - ORCHESTRATED: provider execution mediated by orchestrator service/task lifecycle
    # - DIRECT_SHELL: provider invoked directly without orchestrator lifecycle
    execution_mode: ExecutionMode = ExecutionMode.ORCHESTRATED

    # If True, run both execution modes for all providers and emit matrix output.
    matrix: bool = False

    # Whether to also run direct (non-orchestrated) baseline for comparison
    run_direct_baseline: bool = True

    # Max steps for the orchestrator agent to analyze and delegate
    orchestrator_max_steps: int = 5

    # Max steps for the sub-agent provider to execute
    provider_max_steps: int = 30

    # Anthropic API key for Claude Code provider
    anthropic_api_key: str | None = None

    # OpenAI API key for model providers
    openai_api_key: str | None = None

    # Model to use for the orchestrator agent
    orchestrator_model: str = "claude-sonnet-4-20250514"

    # Model to use for each provider (overrides per-provider defaults)
    provider_models: dict[str, str] = field(default_factory=dict)

    # If True, permit fallback to raw issue text when orchestration model fails.
    # Default False to avoid silent "fake orchestration" behavior.
    allow_task_description_fallback: bool = False

    # Save full execution trace (prompt/response/tool calls/outputs/events).
    save_full_trace: bool = True

    # Optional trace output directory. If None, uses "<output_dir>/traces".
    trace_dir: str | None = None

    # Capability contract
    required_capabilities: list[str] = field(default_factory=list)
    strict_capabilities: bool = False


@dataclass
class ProviderSummary:
    """Summary statistics for a single provider across all instances."""

    provider: ProviderType
    total_instances: int = 0
    resolved: int = 0
    resolve_rate: float = 0.0
    apply_rate: float = 0.0
    average_duration: float = 0.0
    average_tokens: float = 0.0
    delegation_success_rate: float = 0.0
    improvements_over_direct: int = 0
    regressions_from_direct: int = 0


@dataclass
class OrchestratedBenchmarkReport:
    """Full report for an orchestrated benchmark run."""

    config: OrchestratedBenchmarkConfig

    # Results grouped by provider
    by_provider: dict[str, list[ProviderBenchmarkResult]] = field(default_factory=dict)

    # Direct baseline results (if run_direct_baseline=True)
    direct_results: list[SWEBenchResult] = field(default_factory=list)

    # Per-provider summaries
    provider_summaries: dict[str, ProviderSummary] = field(default_factory=dict)

    # Optional matrix output indexed by execution mode then provider name.
    matrix_results: dict[str, dict[str, list[ProviderBenchmarkResult]]] = field(
        default_factory=dict
    )

    # Overall stats
    total_instances: int = 0
    total_provider_runs: int = 0

    def compute_summaries(self) -> None:
        """Compute summary statistics from results."""
        direct_map: dict[str, SWEBenchResult] = {}
        for dr in self.direct_results:
            direct_map[dr.instance_id] = dr

        for provider_key, results in self.by_provider.items():
            provider_type = ProviderType(provider_key)
            total = len(results)
            if total == 0:
                continue

            resolved = sum(1 for r in results if r.swe_result.success)
            applied = sum(
                1 for r in results if r.swe_result.generated_patch.strip()
            )
            delegated = sum(1 for r in results if r.delegation_successful)

            improvements = 0
            regressions = 0
            for r in results:
                # Attach direct result for comparison
                r.direct_result = direct_map.get(r.instance_id)
                delta = r.improvement_over_direct()
                if delta == "improvement":
                    improvements += 1
                elif delta == "regression":
                    regressions += 1

            self.provider_summaries[provider_key] = ProviderSummary(
                provider=provider_type,
                total_instances=total,
                resolved=resolved,
                resolve_rate=resolved / total if total > 0 else 0.0,
                apply_rate=applied / total if total > 0 else 0.0,
                average_duration=(
                    sum(r.swe_result.duration_seconds for r in results) / total
                ),
                average_tokens=(
                    sum(r.swe_result.tokens_used for r in results) / total
                ),
                delegation_success_rate=delegated / total if total > 0 else 0.0,
                improvements_over_direct=improvements,
                regressions_from_direct=regressions,
            )

        self.total_instances = max(
            len(results) for results in self.by_provider.values()
        ) if self.by_provider else 0
        self.total_provider_runs = sum(
            len(results) for results in self.by_provider.values()
        )
