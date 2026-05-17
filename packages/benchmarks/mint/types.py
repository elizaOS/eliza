"""
MINT Benchmark Type Definitions

Defines all data classes and enums used by the MINT benchmark implementation.

Taxonomy follows the original UIUC MINT benchmark
(https://github.com/xingyaoww/mint-bench, ICLR 2024):

    - 8 subtasks split across 3 high-level task types:
        * reasoning        : gsm8k, math, theoremqa, mmlu, hotpotqa
        * code_generation  : humaneval, mbpp
        * decision_making  : alfworld

The 4-bucket category enum that previously lived here was invented and is
gone. Subtasks remain the canonical unit because the paper reports turn-k
metrics per subtask, not per task-type.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class MINTSubtask(str, Enum):
    """The 8 MINT subtasks defined by the paper."""

    HUMANEVAL = "humaneval"
    MBPP = "mbpp"
    MATH = "math"
    GSM8K = "gsm8k"
    HOTPOTQA = "hotpotqa"
    MMLU = "mmlu"
    THEOREMQA = "theoremqa"
    ALFWORLD = "alfworld"


class MINTTaskType(str, Enum):
    """The 3 high-level task types that group the 8 subtasks."""

    REASONING = "reasoning"
    CODE_GENERATION = "code_generation"
    DECISION_MAKING = "decision_making"


# Mapping from subtask -> task type.
SUBTASK_TO_TASK_TYPE: dict[MINTSubtask, MINTTaskType] = {
    MINTSubtask.HUMANEVAL: MINTTaskType.CODE_GENERATION,
    MINTSubtask.MBPP: MINTTaskType.CODE_GENERATION,
    MINTSubtask.MATH: MINTTaskType.REASONING,
    MINTSubtask.GSM8K: MINTTaskType.REASONING,
    MINTSubtask.HOTPOTQA: MINTTaskType.REASONING,
    MINTSubtask.MMLU: MINTTaskType.REASONING,
    MINTSubtask.THEOREMQA: MINTTaskType.REASONING,
    MINTSubtask.ALFWORLD: MINTTaskType.DECISION_MAKING,
}


# ---------------------------------------------------------------------------
# Backwards-compatibility shim
#
# Older code in this package, in eliza-adapter, and in tests refers to
# ``MINTCategory``. We keep the name as an alias for ``MINTSubtask`` so the
# import path keeps working while the rebuild lands incrementally. Tests that
# specifically check for the 4-bucket invented taxonomy have been deleted /
# rewritten.
# ---------------------------------------------------------------------------
MINTCategory = MINTSubtask


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
    CODE_TEST = "code_test"  # Upstream HumanEval / MBPP harness.
    PARTIAL_MATCH = "partial_match"
    SEMANTIC = "semantic"
    THEOREMQA = "theoremqa"  # Upstream TheoremqaTask grader.
    MULTIPLE_CHOICE = "multiple_choice"  # Upstream MMLU grader.


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
    # Whether the assistant claimed this turn was its final answer. Used by
    # the metrics calculator to compute Turn-1 / Turn-3 / Turn-5 SR.
    proposed_solution: bool = False


class MINTTask:
    """A MINT benchmark task.

    Backwards-compat: accepts both ``subtask=`` (new) and ``category=``
    (legacy) for the same value. Implemented as a plain class (rather than
    a dataclass) so the legacy keyword works without surprises.
    """

    id: str
    subtask: MINTSubtask
    description: str
    initial_prompt: str
    ground_truth: str
    max_turns: int
    tools_allowed: list[str]
    evaluation_metric: str
    difficulty: str
    metadata: dict[str, str | int | float | bool]

    def __init__(
        self,
        id: str,
        subtask: Optional["MINTSubtask"] = None,
        description: str = "",
        initial_prompt: str = "",
        ground_truth: str = "",
        max_turns: int = 5,
        tools_allowed: Optional[list[str]] = None,
        evaluation_metric: str = "exact_match",
        difficulty: str = "medium",
        metadata: Optional[dict[str, str | int | float | bool]] = None,
        category: Optional["MINTSubtask"] = None,
    ) -> None:
        if subtask is None:
            subtask = category
        if subtask is None:
            raise TypeError("MINTTask requires a subtask (or legacy 'category')")
        self.id = id
        self.subtask = subtask
        self.description = description
        self.initial_prompt = initial_prompt
        self.ground_truth = ground_truth
        self.max_turns = max_turns
        self.tools_allowed = ["python"] if tools_allowed is None else list(tools_allowed)
        self.evaluation_metric = evaluation_metric
        self.difficulty = difficulty
        self.metadata = {} if metadata is None else dict(metadata)

    # Backwards-compatible alias for callers that still read ``task.category``.
    @property
    def category(self) -> MINTSubtask:
        return self.subtask

    @property
    def task_type(self) -> MINTTaskType:
        return SUBTASK_TO_TASK_TYPE[self.subtask]

    def replace(self, **changes) -> "MINTTask":
        """Return a copy with the given fields overridden.

        Mirrors ``dataclasses.replace`` so ``runner.py`` can keep using
        ``replace(task, max_turns=...)``.
        """
        kwargs = {
            "id": self.id,
            "subtask": self.subtask,
            "description": self.description,
            "initial_prompt": self.initial_prompt,
            "ground_truth": self.ground_truth,
            "max_turns": self.max_turns,
            "tools_allowed": list(self.tools_allowed),
            "evaluation_metric": self.evaluation_metric,
            "difficulty": self.difficulty,
            "metadata": dict(self.metadata),
        }
        kwargs.update(changes)
        return MINTTask(**kwargs)

    def __repr__(self) -> str:
        return (
            f"MINTTask(id={self.id!r}, subtask={self.subtask.value!r}, "
            f"metric={self.evaluation_metric!r})"
        )

    def __eq__(self, other) -> bool:
        if not isinstance(other, MINTTask):
            return NotImplemented
        return (
            self.id == other.id
            and self.subtask == other.subtask
            and self.initial_prompt == other.initial_prompt
            and self.ground_truth == other.ground_truth
        )

    def __hash__(self) -> int:
        return hash((self.id, self.subtask))


@dataclass
class MINTTrajectory:
    """Records the trajectory of solving a MINT task.

    ``per_turn_answers`` records the answer the agent had committed to at the
    end of each assistant turn (or ``None`` if no answer was proposed yet).
    This is what powers the Turn-k SR metric.
    """

    task_id: str
    turns: list[Turn] = field(default_factory=list)
    final_answer: Optional[str] = None
    success: bool = False
    num_tool_uses: int = 0
    num_feedback_turns: int = 0
    total_tokens: int = 0
    start_time_ms: float = 0.0
    end_time_ms: float = 0.0
    per_turn_answers: list[Optional[str]] = field(default_factory=list)
    per_turn_success: list[bool] = field(default_factory=list)


@dataclass
class MINTResult:
    """Result of evaluating a single MINT task."""

    task_id: str
    subtask: MINTSubtask
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
    # Per-turn cumulative success flags for the Turn-k SR metric. Index ``i``
    # is True if the agent had a correct answer by turn ``i + 1``.
    cumulative_success_per_turn: list[bool] = field(default_factory=list)

    # Backwards-compatible alias.
    @property
    def category(self) -> MINTSubtask:
        return self.subtask


@dataclass
class MINTMetrics:
    """Comprehensive metrics from MINT benchmark evaluation."""

    # Overall metrics
    overall_success_rate: float
    total_tasks: int
    passed_tasks: int
    failed_tasks: int

    # Per-subtask metrics (the canonical paper view).
    subtask_success_rates: dict[MINTSubtask, float] = field(default_factory=dict)
    subtask_counts: dict[MINTSubtask, int] = field(default_factory=dict)

    # Per-task-type metrics (reasoning / code_generation / decision_making).
    task_type_success_rates: dict[MINTTaskType, float] = field(default_factory=dict)
    task_type_counts: dict[MINTTaskType, int] = field(default_factory=dict)

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

    # Multi-turn analysis (the canonical MINT headline metric).
    # ``turn_k_success_rate`` is the fraction of tasks where the agent had a
    # correct answer AT OR BEFORE turn k.
    multi_turn_gain: float = 0.0
    turn_1_success_rate: float = 0.0
    turn_2_success_rate: float = 0.0
    turn_3_success_rate: float = 0.0
    turn_4_success_rate: float = 0.0
    turn_5_success_rate: float = 0.0
    per_turn_success_rates: list[float] = field(default_factory=list)

    # Performance metrics
    avg_latency_ms: float = 0.0
    avg_tokens_per_task: float = 0.0
    total_tokens: int = 0
    total_duration_ms: float = 0.0


@dataclass
class MINTConfig:
    """Configuration for MINT benchmark runner."""

    # Paths
    data_path: str = ""  # Empty -> vendored data if present, else cache.
    cache_dir: str = ""  # Empty -> MINT_DATA_CACHE or ~/.cache/elizaos/mint.
    output_dir: str = "./benchmark_results/mint"

    # Execution settings
    max_tasks_per_subtask: Optional[int] = None
    timeout_per_task_ms: int = 120000  # 2 minutes per task
    max_turns: int = 5
    use_docker: bool = True
    code_timeout_seconds: int = 30

    # What to run
    subtasks: Optional[list[MINTSubtask]] = None  # None = all (minus alfworld lazy).
    enable_tools: bool = True
    enable_feedback: bool = True
    run_ablation: bool = True  # Run with different configs

    # Mock / sample-task escape hatches (must be opted in explicitly).
    use_mock_executor: bool = False
    use_sample_tasks: bool = False  # If True, use a tiny hand-written smoke set.
    auto_fetch_upstream: bool = True  # Fetch compact upstream JSONL into cache.
    allow_ground_truth_mock: bool = False

    # Reporting
    save_detailed_logs: bool = True
    save_trajectories: bool = True
    generate_report: bool = True

    # Feedback settings
    feedback_mode: str = "templated"  # "templated" or "llm"
    feedback_model: str = "gpt-4"  # Used only when feedback_mode == "llm".
    temperature: float = 0.0  # Temperature for deterministic results.


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


# ---------------------------------------------------------------------------
# Leaderboard reference
#
# The original 4-bucket scores were apples-to-oranges. We deliberately do not
# ship invented reference numbers. Consumers that want to compare to the
# paper should look up the per-subtask Turn-5 SR in Table 2 / Table 3 of
# https://arxiv.org/abs/2309.10691 .
#
# We keep the symbol exported as an EMPTY dict so import sites that read
# ``LEADERBOARD_SCORES`` don't break, and so report generation degrades to
# "no published numbers available" instead of fabricating a comparison.
# ---------------------------------------------------------------------------
LEADERBOARD_SCORES: dict[str, dict[str, float]] = {}

# Direct link to the paper, surfaced in the markdown report.
PAPER_RESULTS_URL: str = "https://arxiv.org/abs/2309.10691"
