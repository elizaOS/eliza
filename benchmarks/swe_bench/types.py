"""Type definitions for SWE-bench benchmark."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class SWEBenchVariant(Enum):
    """SWE-bench dataset variants."""

    FULL = "full"
    LITE = "lite"
    VERIFIED = "verified"


class PatchStatus(Enum):
    """Status of a generated patch."""

    NOT_GENERATED = "not_generated"
    GENERATED = "generated"
    APPLIED = "applied"
    TESTS_PASSED = "tests_passed"
    TESTS_FAILED = "tests_failed"
    APPLY_FAILED = "apply_failed"


@dataclass
class SWEBenchInstance:
    """A single SWE-bench task instance."""

    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    hints_text: str
    created_at: str
    patch: str  # Ground truth patch
    test_patch: str
    fail_to_pass: list[str]
    pass_to_pass: list[str]
    version: str = ""
    environment_setup_commit: str = ""

    def __post_init__(self) -> None:
        """Validate instance fields."""
        if not self.instance_id:
            raise ValueError("instance_id is required")
        if not self.repo:
            raise ValueError("repo is required")
        if not self.base_commit:
            raise ValueError("base_commit is required")


@dataclass
class CodeLocation:
    """A location in the codebase."""

    file_path: str
    start_line: int
    end_line: int
    content: str

    def __post_init__(self) -> None:
        """Validate location fields."""
        if self.start_line < 1:
            raise ValueError("start_line must be >= 1")
        if self.end_line < self.start_line:
            raise ValueError("end_line must be >= start_line")


@dataclass
class AgentStep:
    """A single step in the agent's trajectory."""

    step_number: int
    action: str
    action_input: dict[str, str | int | float | bool | None]
    observation: str
    thought: str = ""

    def __post_init__(self) -> None:
        """Validate step fields."""
        if self.step_number < 1:
            raise ValueError("step_number must be >= 1")


@dataclass
class AgentTrajectory:
    """Full trajectory of an agent solving an issue."""

    instance_id: str
    steps: list[AgentStep] = field(default_factory=list)
    files_viewed: list[str] = field(default_factory=list)
    files_edited: list[str] = field(default_factory=list)
    search_queries: list[str] = field(default_factory=list)
    total_tokens: int = 0


@dataclass
class SWEBenchResult:
    """Result of attempting to solve a SWE-bench instance."""

    instance_id: str
    generated_patch: str
    patch_status: PatchStatus
    tests_passed: list[str]
    tests_failed: list[str]
    success: bool
    duration_seconds: float
    tokens_used: int
    error: str | None = None
    trajectory: AgentTrajectory | None = None

    def __post_init__(self) -> None:
        """Validate result fields."""
        if self.duration_seconds < 0:
            raise ValueError("duration_seconds must be >= 0")
        if self.tokens_used < 0:
            raise ValueError("tokens_used must be >= 0")


@dataclass
class RepoStats:
    """Statistics for a repository."""

    total: int
    resolved: int
    resolve_rate: float


@dataclass
class SWEBenchReport:
    """Aggregated report for a benchmark run."""

    variant: str
    total_instances: int
    resolved: int
    unresolved: int
    resolve_rate: float
    apply_rate: float
    average_duration: float
    average_tokens: float
    results: list[SWEBenchResult]
    by_repo: dict[str, RepoStats] = field(default_factory=dict)
    errors: dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Validate report fields."""
        if self.total_instances < 0:
            raise ValueError("total_instances must be >= 0")
        if not 0 <= self.resolve_rate <= 1:
            raise ValueError("resolve_rate must be between 0 and 1")
        if not 0 <= self.apply_rate <= 1:
            raise ValueError("apply_rate must be between 0 and 1")


@dataclass
class SWEBenchConfig:
    """Configuration for running SWE-bench."""

    variant: SWEBenchVariant = SWEBenchVariant.LITE
    workspace_dir: str = "./swe-bench-workspace"
    output_dir: str = "./benchmark_results/swe-bench"
    max_steps: int = 30
    max_instances: int | None = None
    repo_filter: str | None = None
    use_docker_eval: bool = True
    timeout_seconds: int = 600
    model_name: str = "gpt-4"
    use_gold_patches: bool = False
    swebench_dataset_name: str | None = None
    swebench_namespace: str | None = None
    swebench_max_workers: int = 1
    swebench_instance_image_tag: str = "latest"
    swebench_env_image_tag: str = "latest"

    def __post_init__(self) -> None:
        """Validate config fields."""
        if self.max_steps < 1:
            raise ValueError("max_steps must be >= 1")
        if self.max_instances is not None and self.max_instances < 1:
            raise ValueError("max_instances must be >= 1 or None")
        if self.timeout_seconds < 1:
            raise ValueError("timeout_seconds must be >= 1")
        if self.swebench_max_workers < 1:
            raise ValueError("swebench_max_workers must be >= 1")


# Leaderboard data for comparison (as of late 2024/early 2025)
LEADERBOARD_SCORES: dict[str, dict[str, float]] = {
    "SWE-bench Lite": {
        "OpenHands + Claude 3.5 Sonnet": 53.0,
        "Agentless + GPT-4o": 33.2,
        "SWE-agent + GPT-4": 33.2,
        "AutoCodeRover + GPT-4o": 30.67,
        "Aider + Claude 3.5 Sonnet": 26.3,
        "Aider + GPT-4o": 18.3,
        "RAG + GPT-4": 6.67,
        "GPT-4 (no agent)": 1.74,
    },
    "SWE-bench Verified": {
        "OpenHands + Claude 3.5 Sonnet": 41.0,
        "Agentless + GPT-4o": 27.3,
        "SWE-agent + Claude 3.5 Sonnet": 33.6,
        "AutoCodeRover + GPT-4o": 25.7,
    },
}
