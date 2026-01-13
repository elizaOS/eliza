"""
Core types for AgentBench benchmark.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol, TypedDict, Union, runtime_checkable
import re


class AgentBenchEnvironment(Enum):
    """The 8 distinct environments in AgentBench."""

    OS = "operating_system"
    DATABASE = "database"
    KNOWLEDGE_GRAPH = "knowledge_graph"
    CARD_GAME = "card_game"
    LATERAL_THINKING = "lateral_thinking"
    HOUSEHOLDING = "householding"  # ALFWorld
    WEB_SHOPPING = "web_shopping"  # WebShop
    WEB_BROWSING = "web_browsing"


class TaskDifficulty(Enum):
    """Task difficulty levels."""

    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"


# JSON-like value types (no Any)
JSONPrimitive = str | int | float | bool | None
JSONValue = JSONPrimitive | list["JSONValue"] | dict[str, "JSONValue"]


# Type definitions for structured data
class GenerateTextResult(Protocol):
    """Protocol for text generation result."""

    text: str


@runtime_checkable
class AgentRuntimeProtocol(Protocol):
    """Protocol defining the expected interface for an agent runtime."""

    async def generate_text(self, prompt: str) -> GenerateTextResult:
        """Generate text from a prompt."""
        ...


# Typed dictionaries for structured state data
class OSInitialState(TypedDict, total=False):
    """Initial state for OS environment tasks."""

    working_dir: str
    files: dict[str, str]


class DBColumnDef(TypedDict, total=False):
    """Database column definition."""

    name: str
    type: str
    primary_key: bool
    not_null: bool


class DBInitialState(TypedDict, total=False):
    """Initial state for database environment tasks."""

    schema: dict[str, list[DBColumnDef]]
    data: dict[str, list[dict[str, str | int | float | bool | None]]]


class WebShopInitialState(TypedDict, total=False):
    """Initial state for web shopping environment tasks."""

    budget: float
    products: list[dict[str, str | float | list[str] | dict[str, list[str]]]]


class KGInitialState(TypedDict, total=False):
    """Initial state for knowledge graph environment tasks."""

    entities: dict[str, dict[str, str | int]]
    relations: list[dict[str, str]]


class LateralThinkingInitialState(TypedDict, total=False):
    """Initial state for lateral thinking environment tasks."""

    puzzle_id: str


# Common structured types used across the benchmark
ObservationType = dict[str, JSONValue]

# Union type for task metadata
TaskMetadataType = dict[str, JSONValue]

# Type for step metadata (kept primitive for stable JSON logs)
StepMetadataType = dict[str, JSONPrimitive]


# Union type for all initial states
InitialStateType = Union[
    OSInitialState,
    DBInitialState,
    WebShopInitialState,
    KGInitialState,
    LateralThinkingInitialState,
    dict[str, JSONValue],
]


def _validate_positive_int(value: int, field_name: str) -> None:
    """Validate that an integer is positive."""
    if value <= 0:
        raise ValueError(f"{field_name} must be positive, got {value}")


def _validate_non_empty_string(value: str, field_name: str) -> None:
    """Validate that a string is non-empty."""
    if not value or not value.strip():
        raise ValueError(f"{field_name} must be non-empty")


def _validate_identifier(value: str, field_name: str) -> None:
    """Validate that a string is a valid identifier (no SQL injection risk)."""
    if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_-]*$", value):
        raise ValueError(f"{field_name} contains invalid characters: {value}")


@dataclass
class AgentBenchTask:
    """A single task in the AgentBench benchmark."""

    id: str
    environment: AgentBenchEnvironment
    description: str
    initial_state: InitialStateType
    goal: str
    max_steps: int
    timeout_ms: int = 60000
    difficulty: TaskDifficulty = TaskDifficulty.MEDIUM
    ground_truth: str | None = None
    hints: list[str] = field(default_factory=list)
    metadata: TaskMetadataType = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Validate task fields after initialization."""
        _validate_non_empty_string(self.id, "id")
        _validate_non_empty_string(self.description, "description")
        _validate_non_empty_string(self.goal, "goal")
        _validate_positive_int(self.max_steps, "max_steps")
        _validate_positive_int(self.timeout_ms, "timeout_ms")


@dataclass
class StepRecord:
    """Record of a single step in task execution."""

    step_number: int
    action: str
    observation: str
    reward: float
    timestamp_ms: float
    metadata: StepMetadataType = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Validate step record fields."""
        if self.step_number < 0:
            raise ValueError(f"step_number must be non-negative, got {self.step_number}")
        if self.timestamp_ms < 0:
            raise ValueError(f"timestamp_ms must be non-negative, got {self.timestamp_ms}")


# Type for result metrics
ResultMetricsType = dict[str, float]

# Type for result details (JSON-like)
ResultDetailsType = dict[str, JSONValue]


@dataclass
class AgentBenchResult:
    """Result of running a single AgentBench task."""

    task_id: str
    environment: AgentBenchEnvironment
    success: bool
    steps_taken: int
    actions: list[str]
    final_state: ObservationType
    duration_ms: float
    error: str | None = None
    metrics: ResultMetricsType = field(
        default_factory=lambda: {
            "planning_time_ms": 0.0,
            "execution_time_ms": 0.0,
            "tokens_used": 0.0,
            "reward": 0.0,
            "efficiency": 0.0,
        }
    )
    step_records: list[StepRecord] = field(default_factory=list)
    details: ResultDetailsType = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Validate result fields."""
        _validate_non_empty_string(self.task_id, "task_id")
        if self.steps_taken < 0:
            raise ValueError(f"steps_taken must be non-negative, got {self.steps_taken}")
        if self.duration_ms < 0:
            raise ValueError(f"duration_ms must be non-negative, got {self.duration_ms}")
        # Ensure metrics are present and finite-ish
        required_metric_keys = {"planning_time_ms", "execution_time_ms", "tokens_used", "reward", "efficiency"}
        missing = required_metric_keys - set(self.metrics.keys())
        if missing:
            raise ValueError(f"metrics missing required keys: {sorted(missing)}")


# Type for environment comparison data
ComparisonDataType = dict[str, float]

# Type for baseline comparison
BaselineComparisonType = dict[str, dict[str, ComparisonDataType]]

# Type for summary data
SummaryType = dict[str, str | list[str]]


@dataclass
class EnvironmentReport:
    """Report for a single environment."""

    environment: AgentBenchEnvironment
    total_tasks: int
    passed_tasks: int
    failed_tasks: int
    success_rate: float
    average_steps: float
    average_duration_ms: float
    average_reward: float
    results: list[AgentBenchResult]

    def __post_init__(self) -> None:
        """Validate environment report fields."""
        if self.total_tasks < 0:
            raise ValueError(f"total_tasks must be non-negative, got {self.total_tasks}")
        if self.passed_tasks < 0:
            raise ValueError(f"passed_tasks must be non-negative, got {self.passed_tasks}")
        if self.passed_tasks > self.total_tasks:
            raise ValueError(f"passed_tasks ({self.passed_tasks}) cannot exceed total_tasks ({self.total_tasks})")
        if not 0.0 <= self.success_rate <= 1.0:
            raise ValueError(f"success_rate must be between 0 and 1, got {self.success_rate}")


# Type for overall metrics with memory usage
OverallMetricsType = dict[str, float | dict[str, int]]


@dataclass
class AgentBenchReport:
    """Comprehensive report for all AgentBench environments."""

    total_tasks: int
    passed_tasks: int
    failed_tasks: int
    overall_success_rate: float
    average_duration_ms: float
    environment_reports: dict[AgentBenchEnvironment, EnvironmentReport]
    overall_metrics: OverallMetricsType = field(
        default_factory=lambda: {
            "total_tokens": 0.0,
            "average_tokens_per_task": 0.0,
            "average_steps_per_task": 0.0,
            "average_reward": 0.0,
            "efficiency_score": 0.0,
        }
    )
    comparison_to_baseline: BaselineComparisonType = field(
        default_factory=lambda: {
            "gpt4_comparison": {},
            "gpt35_comparison": {},
            "claude_comparison": {},
        }
    )
    summary: SummaryType = field(
        default_factory=lambda: {
            "status": "pending",
            "key_findings": [],
            "recommendations": [],
            "timestamp": "",
        }
    )

    def __post_init__(self) -> None:
        """Validate report fields."""
        if self.total_tasks < 0:
            raise ValueError(f"total_tasks must be non-negative, got {self.total_tasks}")
        if not 0.0 <= self.overall_success_rate <= 1.0:
            raise ValueError(f"overall_success_rate must be between 0 and 1, got {self.overall_success_rate}")
        if self.passed_tasks < 0 or self.failed_tasks < 0:
            raise ValueError("passed_tasks and failed_tasks must be non-negative")
        if self.passed_tasks + self.failed_tasks != self.total_tasks:
            raise ValueError(
                f"passed_tasks + failed_tasks must equal total_tasks "
                f"({self.passed_tasks} + {self.failed_tasks} != {self.total_tasks})"
            )
        if self.average_duration_ms < 0:
            raise ValueError(f"average_duration_ms must be non-negative, got {self.average_duration_ms}")


# Type for additional settings in environment config
AdditionalSettingsType = dict[str, str | int | float | bool]


@dataclass
class EnvironmentConfig:
    """Configuration for a specific environment."""

    enabled: bool = True
    max_tasks: int | None = None
    timeout_ms: int = 60000
    max_steps: int = 30
    docker_image: str | None = None
    additional_settings: AdditionalSettingsType = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Validate environment config fields."""
        if self.max_tasks is not None and self.max_tasks <= 0:
            raise ValueError(f"max_tasks must be positive if set, got {self.max_tasks}")
        _validate_positive_int(self.timeout_ms, "timeout_ms")
        _validate_positive_int(self.max_steps, "max_steps")


@dataclass
class AgentBenchConfig:
    """Configuration for running AgentBench."""

    # Environment configurations
    os_config: EnvironmentConfig = field(default_factory=EnvironmentConfig)
    db_config: EnvironmentConfig = field(default_factory=EnvironmentConfig)
    kg_config: EnvironmentConfig = field(default_factory=EnvironmentConfig)
    card_game_config: EnvironmentConfig = field(default_factory=EnvironmentConfig)
    lateral_thinking_config: EnvironmentConfig = field(default_factory=EnvironmentConfig)
    householding_config: EnvironmentConfig = field(default_factory=EnvironmentConfig)
    web_shopping_config: EnvironmentConfig = field(default_factory=EnvironmentConfig)
    web_browsing_config: EnvironmentConfig = field(default_factory=EnvironmentConfig)

    # General settings
    output_dir: str = "./agentbench_results"
    save_detailed_logs: bool = True
    enable_metrics: bool = True
    enable_memory_tracking: bool = True
    enable_baseline_comparison: bool = True
    use_docker: bool = True

    # Dataset paths
    dataset_path: str = "./datasets/agentbench"

    def get_env_config(self, env: AgentBenchEnvironment) -> EnvironmentConfig:
        """Get configuration for a specific environment."""
        config_map = {
            AgentBenchEnvironment.OS: self.os_config,
            AgentBenchEnvironment.DATABASE: self.db_config,
            AgentBenchEnvironment.KNOWLEDGE_GRAPH: self.kg_config,
            AgentBenchEnvironment.CARD_GAME: self.card_game_config,
            AgentBenchEnvironment.LATERAL_THINKING: self.lateral_thinking_config,
            AgentBenchEnvironment.HOUSEHOLDING: self.householding_config,
            AgentBenchEnvironment.WEB_SHOPPING: self.web_shopping_config,
            AgentBenchEnvironment.WEB_BROWSING: self.web_browsing_config,
        }
        return config_map[env]

    def get_enabled_environments(self) -> list[AgentBenchEnvironment]:
        """Get list of enabled environments."""
        return [env for env in AgentBenchEnvironment if self.get_env_config(env).enabled]


# GPT-4 baseline scores from the original paper
GPT4_BASELINE_SCORES: dict[AgentBenchEnvironment, float] = {
    AgentBenchEnvironment.OS: 0.421,
    AgentBenchEnvironment.DATABASE: 0.326,
    AgentBenchEnvironment.KNOWLEDGE_GRAPH: 0.584,
    AgentBenchEnvironment.CARD_GAME: 0.428,
    AgentBenchEnvironment.LATERAL_THINKING: 0.348,
    AgentBenchEnvironment.HOUSEHOLDING: 0.783,
    AgentBenchEnvironment.WEB_SHOPPING: 0.505,
    AgentBenchEnvironment.WEB_BROWSING: 0.493,
}

# GPT-3.5 baseline scores from the original paper
GPT35_BASELINE_SCORES: dict[AgentBenchEnvironment, float] = {
    AgentBenchEnvironment.OS: 0.360,
    AgentBenchEnvironment.DATABASE: 0.102,
    AgentBenchEnvironment.KNOWLEDGE_GRAPH: 0.164,
    AgentBenchEnvironment.CARD_GAME: 0.180,
    AgentBenchEnvironment.LATERAL_THINKING: 0.109,
    AgentBenchEnvironment.HOUSEHOLDING: 0.137,
    AgentBenchEnvironment.WEB_SHOPPING: 0.481,
    AgentBenchEnvironment.WEB_BROWSING: 0.150,
}

# Claude baseline scores (estimated)
CLAUDE_BASELINE_SCORES: dict[AgentBenchEnvironment, float] = {
    AgentBenchEnvironment.OS: 0.395,
    AgentBenchEnvironment.DATABASE: 0.298,
    AgentBenchEnvironment.KNOWLEDGE_GRAPH: 0.542,
    AgentBenchEnvironment.CARD_GAME: 0.391,
    AgentBenchEnvironment.LATERAL_THINKING: 0.312,
    AgentBenchEnvironment.HOUSEHOLDING: 0.721,
    AgentBenchEnvironment.WEB_SHOPPING: 0.489,
    AgentBenchEnvironment.WEB_BROWSING: 0.451,
}
