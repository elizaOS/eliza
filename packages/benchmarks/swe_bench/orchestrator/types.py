"""Types for SWE-bench orchestrated smoke runs."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from benchmarks.swe_bench.types import SWEBenchVariant


class ProviderType(str, Enum):
    SWE_AGENT = "swe-agent"
    ELIZA_CODE = "eliza-code"
    CLAUDE_CODE = "claude-code"
    CODEX = "codex"


@dataclass
class OrchestratedBenchmarkConfig:
    variant: SWEBenchVariant = SWEBenchVariant.LITE
    workspace_dir: str = "./swe-bench-workspace"
    output_dir: str = "./benchmark_results/swe-bench"
    providers: list[ProviderType] = field(default_factory=lambda: [ProviderType.SWE_AGENT])
    allow_task_description_fallback: bool = False
    extra: dict[str, Any] = field(default_factory=dict)
