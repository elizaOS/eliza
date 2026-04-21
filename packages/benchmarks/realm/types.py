"""
REALM-Bench Type Definitions

Defines all data classes and enums used by the REALM benchmark implementation.
Based on the REALM-Bench paper: https://arxiv.org/abs/2412.13102
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class REALMCategory(str, Enum):
    """Task categories in REALM benchmark."""

    SEQUENTIAL = "sequential"
    REACTIVE = "reactive"
    COMPLEX = "complex"
    MULTI_AGENT = "multi_agent"
    TOOL_USE = "tool_use"
    REASONING = "reasoning"


class PlanStatus(str, Enum):
    """Status of a plan execution."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"


class ExecutionModel(str, Enum):
    """Plan execution model types."""

    SEQUENTIAL = "sequential"
    PARALLEL = "parallel"
    DAG = "dag"


@dataclass
class PlanningAction:
    """Represents an action in a plan."""

    name: str
    parameters: dict[str, str | int | float | bool | list[str] | dict[str, str]]
    description: Optional[str] = None


@dataclass
class PlanningStep:
    """A step in a plan execution."""

    step_number: int
    action: PlanningAction
    observation: str = ""
    success: bool = False
    error: Optional[str] = None
    duration_ms: float = 0.0


@dataclass
class PlanningTrajectory:
    """Records the trajectory of solving a REALM task."""

    task_id: str
    steps: list[PlanningStep] = field(default_factory=list)
    final_outcome: str = ""
    overall_success: bool = False
    duration_ms: float = 0.0
    tokens_used: int = 0
    plan_quality_score: float = 0.0
    adaptation_count: int = 0
    start_time_ms: float = 0.0
    end_time_ms: float = 0.0


@dataclass
class REALMTask:
    """A REALM benchmark task."""

    id: str
    name: str
    description: str
    goal: str
    category: REALMCategory
    requirements: list[str]
    constraints: dict[str, str | int | float | bool]
    expected_outcome: str
    available_tools: list[str]
    timeout_ms: int = 60000
    max_steps: int = 10
    difficulty: str = "medium"  # easy, medium, hard
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass
class REALMTestCase:
    """A test case for REALM benchmark."""

    task: REALMTask
    input: dict[str, str | dict[str, str]]
    expected: dict[str, list[str] | str | dict[str, int | list[str]]]


@dataclass
class REALMResultMetrics:
    """Metrics for a single REALM result."""

    planning_time: float = 0.0
    execution_time: float = 0.0
    plan_quality: float = 0.0
    goal_achievement: float = 0.0
    efficiency: float = 0.0


@dataclass
class REALMResultDetails:
    """Details for a single REALM result."""

    plan_adaptations: int = 0
    error_recoveries: int = 0
    tokens: int = 0
    duration: float = 0.0


@dataclass
class REALMResult:
    """Result of evaluating a single REALM task."""

    task_id: str
    category: REALMCategory
    trajectory: PlanningTrajectory
    success: bool
    steps_executed: int
    actions_performed: list[str]
    plan_generated: Optional[dict[str, str | list[dict[str, str]]]] = None
    duration_ms: float = 0.0
    token_usage: int = 0
    error: Optional[str] = None
    metrics: REALMResultMetrics = field(default_factory=REALMResultMetrics)
    details: REALMResultDetails = field(default_factory=REALMResultDetails)


@dataclass
class REALMMetrics:
    """Comprehensive metrics from REALM benchmark evaluation."""

    # Overall metrics
    overall_success_rate: float
    total_tasks: int
    passed_tasks: int
    failed_tasks: int

    # Per-category metrics
    category_success_rates: dict[REALMCategory, float] = field(default_factory=dict)
    category_counts: dict[REALMCategory, int] = field(default_factory=dict)

    # Planning metrics
    avg_plan_quality: float = 0.0
    avg_goal_achievement: float = 0.0
    avg_efficiency: float = 0.0

    # Execution metrics
    avg_steps_to_success: float = 0.0
    avg_steps_to_failure: float = 0.0
    avg_planning_time_ms: float = 0.0
    avg_execution_time_ms: float = 0.0

    # Adaptation metrics
    adaptation_rate: float = 0.0
    adaptation_success_rate: float = 0.0

    # Performance metrics
    avg_latency_ms: float = 0.0
    avg_tokens_per_task: float = 0.0
    total_tokens: int = 0
    total_duration_ms: float = 0.0


@dataclass
class REALMConfig:
    """Configuration for REALM benchmark runner."""

    # Paths
    data_path: str = "./data/realm"
    output_dir: str = "./benchmark_results/realm"

    # Execution settings
    max_tasks_per_category: Optional[int] = None
    timeout_per_task_ms: int = 120000  # 2 minutes per task
    max_steps: int = 15
    execution_model: ExecutionModel = ExecutionModel.DAG

    # What to run
    categories: Optional[list[REALMCategory]] = None  # None = all categories
    enable_adaptation: bool = True
    enable_multi_agent: bool = False

    # Reporting
    save_detailed_logs: bool = True
    save_trajectories: bool = True
    generate_report: bool = True

    # Model settings
    model_name: str = "gpt-4"
    temperature: float = 0.3


@dataclass
class REALMReport:
    """Full benchmark report."""

    metadata: dict[str, str | int | float | bool | dict[str, str | int | float | bool] | list[str]]
    metrics: REALMMetrics
    results: list[REALMResult]
    category_breakdown: dict[str, dict[str, float]]
    comparison_to_leaderboard: dict[str, dict[str, float]]
    summary: dict[str, str | int | list[str]]


# Leaderboard reference scores from the REALM-Bench paper (arXiv:2412.13102)
# These are approximate scores based on the paper's findings
LEADERBOARD_SCORES: dict[str, dict[str, float]] = {
    "GPT-4": {
        "sequential": 78.5,
        "reactive": 71.2,
        "complex": 65.3,
        "multi_agent": 58.7,
        "tool_use": 72.1,
        "reasoning": 69.8,
        "overall": 69.3,
    },
    "GPT-4-Turbo": {
        "sequential": 82.1,
        "reactive": 74.5,
        "complex": 68.9,
        "multi_agent": 62.3,
        "tool_use": 76.4,
        "reasoning": 73.2,
        "overall": 72.9,
    },
    "Claude-3-Opus": {
        "sequential": 76.2,
        "reactive": 69.8,
        "complex": 63.1,
        "multi_agent": 56.2,
        "tool_use": 70.5,
        "reasoning": 67.4,
        "overall": 67.2,
    },
    "Claude-3-Sonnet": {
        "sequential": 71.4,
        "reactive": 65.2,
        "complex": 58.7,
        "multi_agent": 51.8,
        "tool_use": 66.3,
        "reasoning": 62.9,
        "overall": 62.7,
    },
    "Gemini-Pro": {
        "sequential": 68.5,
        "reactive": 61.3,
        "complex": 54.2,
        "multi_agent": 47.6,
        "tool_use": 62.1,
        "reasoning": 58.4,
        "overall": 58.7,
    },
    "Llama-3-70B": {
        "sequential": 62.3,
        "reactive": 55.8,
        "complex": 48.4,
        "multi_agent": 42.1,
        "tool_use": 56.7,
        "reasoning": 52.3,
        "overall": 52.9,
    },
    "Mixtral-8x7B": {
        "sequential": 54.6,
        "reactive": 48.2,
        "complex": 41.5,
        "multi_agent": 35.8,
        "tool_use": 49.3,
        "reasoning": 45.1,
        "overall": 45.8,
    },
}
