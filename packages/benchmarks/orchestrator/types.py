from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

RunStatus = Literal[
    "queued",
    "running",
    "succeeded",
    "failed",
    "skipped",
    "incompatible",
]


@dataclass(frozen=True)
class RunRequest:
    benchmarks: tuple[str, ...]
    agent: str
    provider: str
    model: str
    extra_config: dict[str, Any]
    resume: bool = False
    rerun_failed: bool = False
    force: bool = False


@dataclass(frozen=True)
class ScoreSummary:
    score: float | None
    unit: str | None
    higher_is_better: bool | None
    metrics: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class LeaderboardComparison:
    benchmark_id: str
    high_score_label: str | None
    high_score_value: float | None
    delta_to_high_score: float | None


@dataclass(frozen=True)
class ExecutionContext:
    workspace_root: Path
    benchmarks_root: Path
    output_root: Path
    run_root: Path
    request: RunRequest
    run_group_id: str
    env: dict[str, str]
    repo_meta: dict[str, str | None]


CommandBuilder = Callable[[ExecutionContext, "BenchmarkAdapter"], list[str]]
ResultLocator = Callable[[ExecutionContext, "BenchmarkAdapter", Path], Path | None]
ScoreExtractor = Callable[[Path], ScoreSummary]
HistoricalLocator = Callable[[Path], list[Path]]
EnvBuilder = Callable[[ExecutionContext, "BenchmarkAdapter"], Mapping[str, str]]


@dataclass(frozen=True)
class BenchmarkAdapter:
    id: str
    directory: str
    description: str
    cwd: str
    command_builder: CommandBuilder
    result_locator: ResultLocator
    score_extractor: ScoreExtractor
    required_env: tuple[str, ...] = ()
    default_timeout_seconds: int = 3600
    default_extra_config: Mapping[str, Any] = field(default_factory=dict)
    env_overrides: Mapping[str, str] = field(default_factory=dict)
    env_builder: EnvBuilder | None = None
    historical_result_locator: HistoricalLocator | None = None
    capability_notes: str = ""


@dataclass(frozen=True)
class BenchmarkRunOutcome:
    benchmark_id: str
    run_id: str
    status: RunStatus
    attempt: int
    score: float | None
    unit: str | None
    higher_is_better: bool | None
    metrics: dict[str, Any]
    error: str | None
    result_json_path: str | None
    stdout_path: str
    stderr_path: str
    artifacts: list[str]
    comparison: LeaderboardComparison
    duration_seconds: float | None
    command: list[str]
    cwd: str


@dataclass(frozen=True)
class AdapterDiscovery:
    adapters: dict[str, BenchmarkAdapter]
    all_directories: tuple[str, ...]


@dataclass(frozen=True)
class ExistingRun:
    run_id: str
    signature: str
    status: RunStatus
    attempt: int
