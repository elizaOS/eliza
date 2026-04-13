"""Types for orchestrated GAIA benchmark execution."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from elizaos_gaia.types import GAIAConfig, GAIAResult


class ProviderType(str, Enum):
    """Supported provider identifiers for GAIA orchestrator matrix."""

    CLAUDE_CODE = "claude-code"
    SWE_AGENT = "swe-agent"
    CODEX = "codex"


class ExecutionMode(str, Enum):
    """Control-plane mode for question execution."""

    ORCHESTRATED = "orchestrated"
    DIRECT_SHELL = "direct_shell"


@dataclass
class ProviderQuestionResult:
    """Result for one provider on one GAIA question."""

    provider: ProviderType
    task_id: str
    gaia_result: GAIAResult
    control_plane_mode: ExecutionMode = ExecutionMode.ORCHESTRATED
    orchestration_time_ms: float = 0.0
    provider_execution_time_ms: float = 0.0
    delegation_successful: bool = False
    task_description_generated: str = ""
    declared_capabilities: list[str] = field(default_factory=list)
    observed_capabilities: list[str] = field(default_factory=list)
    capability_violations: list[str] = field(default_factory=list)
    trace_file: str | None = None


@dataclass
class ProviderSummary:
    """Summary for one provider/mode bucket."""

    provider: ProviderType
    mode: ExecutionMode
    total_questions: int = 0
    correct_answers: int = 0
    accuracy: float = 0.0
    avg_latency_ms: float = 0.0
    avg_tokens: float = 0.0
    delegation_success_rate: float = 0.0
    capability_compliance_rate: float = 0.0


@dataclass
class OrchestratedGAIAReport:
    """Top-level orchestrated GAIA report."""

    config: GAIAConfig
    by_provider: dict[str, list[ProviderQuestionResult]] = field(default_factory=dict)
    matrix_results: dict[str, dict[str, list[ProviderQuestionResult]]] = field(
        default_factory=dict
    )
    provider_summaries: dict[str, ProviderSummary] = field(default_factory=dict)
    overall_accuracy: float = 0.0

    def compute_summaries(self) -> None:
        total = 0
        correct = 0
        self.provider_summaries = {}
        for provider_key, results in self.by_provider.items():
            if not results:
                continue
            provider = results[0].provider
            mode = results[0].control_plane_mode
            count = len(results)
            provider_correct = sum(1 for r in results if r.gaia_result.is_correct)
            provider_latency = sum(r.gaia_result.latency_ms for r in results) / count
            provider_tokens = sum(r.gaia_result.token_usage for r in results) / count
            delegated = sum(1 for r in results if r.delegation_successful)
            compliant = sum(1 for r in results if not r.capability_violations)
            self.provider_summaries[provider_key] = ProviderSummary(
                provider=provider,
                mode=mode,
                total_questions=count,
                correct_answers=provider_correct,
                accuracy=provider_correct / count if count > 0 else 0.0,
                avg_latency_ms=provider_latency,
                avg_tokens=provider_tokens,
                delegation_success_rate=delegated / count if count > 0 else 0.0,
                capability_compliance_rate=compliant / count if count > 0 else 0.0,
            )
            total += count
            correct += provider_correct

        self.overall_accuracy = (correct / total) if total > 0 else 0.0
