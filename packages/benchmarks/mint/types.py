"""
MINT Benchmark Type Definitions

Defines all data classes and enums used by the MINT benchmark implementation.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class MINTCategory(str, Enum):
    """Task categories in MINT benchmark."""

    REASONING = "reasoning"
    CODING = "coding"
    DECISION_MAKING = "decision_making"
    INFORMATION_SEEKING = "information_seeking"


class TurnType(str, Enum):
    """Types of turns in a multi-turn interaction."""

    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"
    FEEDBACK = "feedback"


class EvaluationMetric(str, Enum):
    """Available evaluation metrics for MINT tasks."""

    EXACT_MATCH = "exact_match"
    NUMERIC = "numeric"
    CODE_OUTPUT = "code_output"
    SEMANTIC = "semantic"
    PARTIAL_MATCH = "partial_match"


@dataclass
class Turn:
    """Represents a single turn in a multi-turn interaction."""

    turn_type: TurnType
    content: str
    turn_number: int = 0
    tool_call: Optional[str] = None
    tool_result: Optional[str] = None
    tool_success: bool = True
    feedback: Optional[str] = None
    timestamp_ms: float = 0.0


@dataclass
class MINTTask:
    """A MINT benchmark task."""

    id: str
    category: MINTCategory
    description: str
    initial_prompt: str
    ground_truth: str
    max_turns: int = 5
    tools_allowed: list[str] = field(default_factory=lambda: ["python"])
    evaluation_metric: str = "exact_match"
    difficulty: str = "medium"  # easy, medium, hard
    subcategory: Optional[str] = None
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass
class MINTTrajectory:
    """Records the trajectory of solving a MINT task."""

    task_id: str
    turns: list[Turn] = field(default_factory=list)
    final_answer: Optional[str] = None
    success: bool = False
    num_tool_uses: int = 0
    num_feedback_turns: int = 0
    total_tokens: int = 0
    start_time_ms: float = 0.0
    end_time_ms: float = 0.0


@dataclass
class MINTResult:
    """Result of evaluating a single MINT task."""

    task_id: str
    category: MINTCategory
    trajectory: MINTTrajectory
    success: bool
    turns_used: int
    tool_uses: int
    feedback_turns: int
    latency_ms: float
    token_usage: int
    error: Optional[str] = None
    score: float = 0.0  # 0.0 to 1.0
    evaluation_details: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass
class MINTMetrics:
    """Comprehensive metrics from MINT benchmark evaluation."""

    # Overall metrics
    overall_success_rate: float
    total_tasks: int
    passed_tasks: int
    failed_tasks: int

    # Per-category metrics
    category_success_rates: dict[MINTCategory, float] = field(default_factory=dict)
    category_counts: dict[MINTCategory, int] = field(default_factory=dict)

    # Turn analysis
    avg_turns_to_success: float = 0.0
    avg_turns_to_failure: float = 0.0
    turn_efficiency: float = 0.0  # Success rate / avg turns

    # Tool analysis
    tool_usage_rate: float = 0.0
    tool_effectiveness: float = 0.0  # Improvement from tools
    avg_tool_uses_success: float = 0.0
    avg_tool_uses_failure: float = 0.0

    # Feedback analysis
    feedback_usage_rate: float = 0.0
    feedback_effectiveness: float = 0.0  # Improvement from feedback
    avg_feedback_turns_success: float = 0.0
    avg_feedback_turns_failure: float = 0.0

    # Multi-turn analysis
    multi_turn_gain: float = 0.0  # Improvement from multi-turn
    turn_1_success_rate: float = 0.0
    turn_3_success_rate: float = 0.0
    turn_5_success_rate: float = 0.0

    # Performance metrics
    avg_latency_ms: float = 0.0
    avg_tokens_per_task: float = 0.0
    total_tokens: int = 0
    total_duration_ms: float = 0.0


@dataclass
class MINTConfig:
    """Configuration for MINT benchmark runner."""

    # Paths
    data_path: str = "./data/mint"
    output_dir: str = "./benchmark_results/mint"

    # Execution settings
    max_tasks_per_category: Optional[int] = None
    timeout_per_task_ms: int = 120000  # 2 minutes per task
    max_turns: int = 5
    use_docker: bool = True
    code_timeout_seconds: int = 30

    # What to run
    categories: Optional[list[MINTCategory]] = None  # None = all categories
    enable_tools: bool = True
    enable_feedback: bool = True
    run_ablation: bool = True  # Run with different configs

    # Reporting
    save_detailed_logs: bool = True
    save_trajectories: bool = True
    generate_report: bool = True

    # Model settings
    feedback_model: str = "gpt-4"  # Model for feedback generation
    use_llm_feedback: bool = False  # If True, generate feedback via runtime model
    temperature: float = 0.0  # Temperature for deterministic results


@dataclass
class ConfigurationResult:
    """Results for a specific configuration (tools/feedback enabled/disabled)."""

    config_name: str
    enable_tools: bool
    enable_feedback: bool
    metrics: MINTMetrics
    results: list[MINTResult] = field(default_factory=list)


@dataclass
class MINTBenchmarkResults:
    """Full benchmark results with ablation study."""

    metadata: dict[str, str | int | float | bool | list[str] | dict[str, bool | int]]
    baseline_results: ConfigurationResult  # No tools, no feedback
    tools_only_results: Optional[ConfigurationResult] = None
    feedback_only_results: Optional[ConfigurationResult] = None
    full_results: Optional[ConfigurationResult] = None  # Tools + feedback
    comparison: dict[str, float] = field(default_factory=dict)
    summary: dict[str, str | list[str]] = field(default_factory=dict)


# Leaderboard reference scores from the MINT paper
LEADERBOARD_SCORES: dict[str, dict[str, float]] = {
    "gpt-4-0613": {
        "reasoning": 0.72,
        "coding": 0.68,
        "decision_making": 0.65,
        "information_seeking": 0.58,
        "overall": 0.66,
    },
    "gpt-3.5-turbo": {
        "reasoning": 0.45,
        "coding": 0.42,
        "decision_making": 0.38,
        "information_seeking": 0.35,
        "overall": 0.40,
    },
    "claude-2": {
        "reasoning": 0.68,
        "coding": 0.62,
        "decision_making": 0.60,
        "information_seeking": 0.52,
        "overall": 0.61,
    },
    "llama-2-70b": {
        "reasoning": 0.38,
        "coding": 0.32,
        "decision_making": 0.30,
        "information_seeking": 0.28,
        "overall": 0.32,
    },
}
