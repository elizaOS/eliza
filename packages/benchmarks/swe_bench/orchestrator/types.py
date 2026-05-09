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


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class TaskUserStatus(str, Enum):
    OPEN = "open"
    PAUSED = "paused"
    CANCELLED = "cancelled"


@dataclass
class OrchestratedBenchmarkConfig:
    variant: SWEBenchVariant = SWEBenchVariant.LITE
    workspace_dir: str = "./swe-bench-workspace"
    output_dir: str = "./benchmark_results/swe-bench"
    providers: list[ProviderType] = field(default_factory=lambda: [ProviderType.SWE_AGENT])
    allow_task_description_fallback: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class OrchestratedTaskMetadata:
    status: TaskStatus
    progress: int
    output: list[str]
    steps: list[dict[str, Any]]
    working_directory: str
    provider_id: str
    provider_label: str
    sub_agent_type: str
    user_status: TaskUserStatus
    user_status_updated_at: int
    files_created: list[str]
    files_modified: list[str]
    created_at: int


@dataclass
class OrchestratedTask:
    id: str
    name: str
    description: str
    tags: list[str]
    metadata: OrchestratedTaskMetadata


@dataclass
class ProviderTaskExecutionContext:
    runtime_agent_id: str
    working_directory: str
    append_output: Any
    update_progress: Any
    update_step: Any
    is_cancelled: Any
    is_paused: Any
