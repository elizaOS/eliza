"""
Core types for Tau-bench benchmark.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional, Union


class TauDomain(Enum):
    """The domains evaluated in Tau-bench."""
    RETAIL = "retail"
    AIRLINE = "airline"


class ToolCallStatus(Enum):
    """Status of a tool call evaluation."""
    CORRECT = "correct"
    WRONG_TOOL = "wrong_tool"
    WRONG_PARAMS = "wrong_params"
    MISSING_CALL = "missing_call"
    EXTRA_CALL = "extra_call"
    EXECUTION_ERROR = "execution_error"


class TaskDifficulty(Enum):
    """Task difficulty levels."""
    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"


@dataclass
class ToolDefinition:
    """Definition of a tool available to the agent."""
    name: str
    description: str
    parameters: dict[str, Any]
    returns: dict[str, Any] = field(default_factory=dict)
    examples: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary format for LLM prompts."""
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
            "returns": self.returns,
        }


# Type alias for tool call results (can be dict, list, str, or error)
ToolResult = Union[dict[str, Any], list[Any], str, None]


@dataclass
class ToolCall:
    """A single tool call made by the agent."""
    tool_name: str
    arguments: dict[str, Any]
    result: ToolResult = None
    status: ToolCallStatus = ToolCallStatus.CORRECT
    error_message: Optional[str] = None
    execution_time_ms: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "tool_name": self.tool_name,
            "arguments": self.arguments,
            "result": self.result,
            "status": self.status.value,
            "error_message": self.error_message,
        }


@dataclass
class PolicyConstraint:
    """A policy constraint the agent must follow."""
    policy_id: str
    description: str
    check_function: str  # Name of validation function
    severity: str = "error"  # error, warning, info
    domain: Optional[TauDomain] = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "policy_id": self.policy_id,
            "description": self.description,
            "severity": self.severity,
        }


@dataclass
class ConversationTurn:
    """A single turn in the conversation."""
    role: str  # user, assistant, tool
    content: str
    tool_call: Optional[ToolCall] = None
    timestamp_ms: float = 0.0


@dataclass
class TauBenchTask:
    """A single task in the Tau-bench benchmark."""
    task_id: str
    domain: TauDomain
    user_instruction: str
    user_profile: str = ""
    user_goal: str = ""
    conversation_history: list[dict[str, str]] = field(default_factory=list)
    available_tools: list[ToolDefinition] = field(default_factory=list)
    expected_tool_calls: list[ToolCall] = field(default_factory=list)
    policy_constraints: list[PolicyConstraint] = field(default_factory=list)
    ground_truth_response: str = ""
    success_criteria: list[str] = field(default_factory=list)
    initialization_data: dict[str, Any] = field(default_factory=dict)
    difficulty: TaskDifficulty = TaskDifficulty.MEDIUM
    max_turns: int = 15
    timeout_ms: int = 120000
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class TauBenchResult:
    """Result of running a single Tau-bench task."""
    task_id: str
    domain: TauDomain
    trial_number: int = 1
    tool_calls_made: list[ToolCall] = field(default_factory=list)
    tool_call_accuracy: float = 0.0
    tool_selection_accuracy: float = 0.0
    parameter_accuracy: float = 0.0
    conversation_history: list[ConversationTurn] = field(default_factory=list)
    response_generated: str = ""
    response_quality: float = 0.0
    policy_violations: list[str] = field(default_factory=list)
    policy_compliance: float = 1.0
    goal_achieved: bool = False
    final_state: dict[str, Any] = field(default_factory=dict)
    success: bool = False
    duration_ms: float = 0.0
    turns_used: int = 0
    tokens_used: int = 0
    error: Optional[str] = None
    metrics: dict[str, float] = field(
        default_factory=lambda: {
            "planning_time_ms": 0.0,
            "execution_time_ms": 0.0,
            "tool_invocation_count": 0.0,
            "correct_tool_count": 0.0,
        }
    )


@dataclass
class PassKMetrics:
    """Pass^k reliability metrics."""
    k: int
    pass_rate: float
    trials_passed: int
    total_trials: int
    
    @classmethod
    def calculate(cls, results: list[TauBenchResult], k: int) -> "PassKMetrics":
        """Calculate Pass^k metric from a list of results for the same task."""
        if not results:
            return cls(k=k, pass_rate=0.0, trials_passed=0, total_trials=0)
        
        # Group by task_id
        task_results: dict[str, list[bool]] = {}
        for r in results:
            if r.task_id not in task_results:
                task_results[r.task_id] = []
            task_results[r.task_id].append(r.success)
        
        # Calculate pass^k (task passes if ALL k trials succeed)
        tasks_passed = 0
        total_tasks = len(task_results)
        
        for task_id, successes in task_results.items():
            # Take first k trials
            k_trials = successes[:k]
            if len(k_trials) == k and all(k_trials):
                tasks_passed += 1
        
        pass_rate = tasks_passed / total_tasks if total_tasks > 0 else 0.0
        
        return cls(
            k=k,
            pass_rate=pass_rate,
            trials_passed=tasks_passed,
            total_trials=total_tasks,
        )


@dataclass
class DomainReport:
    """Report for a single domain."""
    domain: TauDomain
    total_tasks: int
    passed_tasks: int
    failed_tasks: int
    success_rate: float
    average_tool_accuracy: float
    average_policy_compliance: float
    average_response_quality: float
    average_turns: float
    average_duration_ms: float
    pass_k_metrics: dict[int, PassKMetrics] = field(default_factory=dict)
    results: list[TauBenchResult] = field(default_factory=list)


@dataclass
class TauBenchReport:
    """Comprehensive report for Tau-bench evaluation."""
    total_tasks: int
    total_trials: int
    passed_tasks: int
    failed_tasks: int
    overall_success_rate: float
    overall_tool_accuracy: float
    overall_policy_compliance: float
    overall_response_quality: float
    average_duration_ms: float
    domain_reports: dict[TauDomain, DomainReport] = field(default_factory=dict)
    pass_k_metrics: dict[int, PassKMetrics] = field(default_factory=dict)
    overall_metrics: dict[str, float] = field(
        default_factory=lambda: {
            "total_tokens": 0.0,
            "average_tokens_per_task": 0.0,
            "average_turns_per_task": 0.0,
            "average_tool_calls_per_task": 0.0,
        }
    )
    comparison_to_leaderboard: dict[str, Any] = field(
        default_factory=lambda: {
            "best_comparable_model": "",
            "comparison_details": {},
        }
    )
    summary: dict[str, Any] = field(
        default_factory=lambda: {
            "status": "pending",
            "key_findings": [],
            "strengths": [],
            "weaknesses": [],
            "recommendations": [],
            "timestamp": "",
        }
    )
    results: list[TauBenchResult] = field(default_factory=list)


@dataclass
class TauBenchConfig:
    """Configuration for running Tau-bench."""
    data_path: str = "./benchmark-data/tau-bench"
    output_dir: str = "./benchmark_results/tau-bench"
    domains: list[TauDomain] = field(default_factory=lambda: [TauDomain.RETAIL, TauDomain.AIRLINE])
    max_tasks: Optional[int] = None
    difficulty: Optional[TaskDifficulty] = None
    num_trials: int = 1  # For Pass^k evaluation
    max_turns_per_task: int = 15
    timeout_ms: int = 120000
    save_detailed_logs: bool = True
    enable_metrics: bool = True
    enable_memory_tracking: bool = True
    use_llm_judge: bool = True  # Use LLM to evaluate response quality
    verbose: bool = False
    # ElizaOS integration settings
    use_mock: bool = False  # Use real LLM by default - set True or --mock for testing
    temperature: float = 0.0  # LLM temperature for generation
    model_provider: Optional[str] = None  # Force specific provider: openai, anthropic, google, ollama
    # Trajectory logging (for training/benchmark telemetry)
    enable_trajectory_logging: bool = True
    trajectory_export_format: str = "art"  # "art" or "grpo"

    def get_enabled_domains(self) -> list[TauDomain]:
        """Get list of enabled domains."""
        return self.domains if self.domains else list(TauDomain)
