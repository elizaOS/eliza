"""
GAIA Benchmark Type Definitions

Defines all data classes and enums used by the GAIA benchmark implementation.
"""

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path


class GAIALevel(str, Enum):
    """GAIA difficulty levels.

    - LEVEL_1: Solvable by advanced LLMs with simple tool use (~150 questions)
    - LEVEL_2: Requires complex reasoning + tools (~200 questions)
    - LEVEL_3: Demanding advanced capabilities (~100 questions)
    """
    LEVEL_1 = "1"
    LEVEL_2 = "2"
    LEVEL_3 = "3"


class ToolType(str, Enum):
    """Types of tools required for GAIA tasks."""
    WEB_SEARCH = "web_search"
    WEB_BROWSE = "web_browse"
    FILE_READ = "file_read"
    CODE_EXEC = "code_exec"
    CALCULATOR = "calculator"
    IMAGE_ANALYSIS = "image_analysis"
    PDF_READ = "pdf_read"
    SPREADSHEET_READ = "spreadsheet_read"
    AUDIO_TRANSCRIBE = "audio_transcribe"


class TaskCategory(str, Enum):
    """Categories of GAIA tasks based on required capabilities."""
    WEB_BROWSING = "web_browsing"
    FILE_PROCESSING = "file_processing"
    CALCULATIONS = "calculations"
    MULTI_STEP_REASONING = "multi_step_reasoning"
    TOOL_USE = "tool_use"
    MULTIMODAL = "multimodal"


@dataclass
class AnnotatorMetadata:
    """Metadata from human annotators about the task."""
    steps: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    number_of_steps: int = 0
    time_taken_in_mins: float = 0.0


@dataclass
class GAIAQuestion:
    """A GAIA benchmark question."""
    task_id: str
    question: str
    level: GAIALevel
    final_answer: str
    file_name: str | None = None
    file_path: Path | None = None
    annotator_metadata: AnnotatorMetadata | None = None
    # Derived fields
    required_tools: list[ToolType] = field(default_factory=list)
    categories: list[TaskCategory] = field(default_factory=list)


@dataclass
class StepRecord:
    """Record of a single step taken by the agent."""
    step_number: int
    action: str
    tool_used: ToolType | None = None
    tool_input: str | None = None
    tool_output: str | None = None
    reasoning: str | None = None
    timestamp_ms: float = 0.0
    duration_ms: float = 0.0
    success: bool = True
    error: str | None = None


@dataclass
class GAIAResult:
    """Result of evaluating a single GAIA question."""
    task_id: str
    level: GAIALevel
    question: str
    predicted_answer: str
    expected_answer: str
    is_correct: bool
    steps_taken: list[StepRecord] = field(default_factory=list)
    tools_used: list[ToolType] = field(default_factory=list)
    latency_ms: float = 0.0
    token_usage: int = 0
    error: str | None = None
    # Detailed evaluation
    normalized_predicted: str = ""
    normalized_expected: str = ""
    match_type: str = "exact"  # exact, fuzzy, numeric, etc.


@dataclass
class GAIAMetrics:
    """Comprehensive metrics from GAIA benchmark evaluation."""
    # Overall metrics
    overall_accuracy: float
    total_questions: int
    correct_answers: int
    incorrect_answers: int
    errors: int

    # Per-level metrics
    level_accuracy: dict[GAIALevel, float] = field(default_factory=dict)
    level_counts: dict[GAIALevel, int] = field(default_factory=dict)
    level_correct: dict[GAIALevel, int] = field(default_factory=dict)

    # Tool usage metrics
    tool_usage: dict[ToolType, int] = field(default_factory=dict)
    tool_success_rate: dict[ToolType, float] = field(default_factory=dict)
    avg_tools_per_question: float = 0.0

    # Performance metrics
    avg_steps: float = 0.0
    avg_latency_ms: float = 0.0
    avg_tokens_per_question: float = 0.0
    total_tokens: int = 0
    total_duration_ms: float = 0.0

    # Error analysis
    error_rate: float = 0.0
    error_categories: dict[str, int] = field(default_factory=dict)


@dataclass
class LeaderboardComparison:
    """Comparison with published leaderboard scores."""
    our_score: float
    our_level_scores: dict[GAIALevel, float]
    rank: int
    total_entries: int
    comparison: dict[str, dict[str, float]]
    percentile: float


@dataclass
class GAIAConfig:
    """Configuration for GAIA benchmark runner."""
    # Paths
    cache_dir: str = ".cache/gaia"
    output_dir: str = "./benchmark_results/gaia"
    files_dir: str | None = None  # Directory for downloaded files

    # Execution settings
    split: str = "validation"  # validation or test
    # Dataset source
    # - "gaia": load official GAIA from HuggingFace (requires approval + HF_TOKEN)
    # - "sample": load built-in sample dataset (for end-to-end validation)
    # - "jsonl": load from a local JSONL file via dataset_path
    dataset_source: str = "gaia"
    dataset_path: str | None = None
    levels: list[GAIALevel] | None = None  # None = all levels
    max_questions: int | None = None  # Limit for testing
    max_iterations: int = 15  # Max agent iterations per question
    timeout_per_question_ms: int = 300000  # 5 minutes per question

    # Canonical Eliza runtime execution
    # When enabled, the benchmark runs questions through AgentRuntime.message_service
    # (providers + action planning + action execution + evaluators).
    use_eliza_runtime: bool = True

    # Tool settings
    enable_web_search: bool = True
    enable_web_browse: bool = True
    enable_file_processing: bool = True
    enable_code_execution: bool = True
    web_search_api_key: str | None = None
    code_execution_sandbox: bool = True
    code_timeout_seconds: int = 30

    # Model settings - supports multiple providers
    # Format: "model_name" or "provider/model_name"
    # Examples: "llama-3.1-8b-instant", "groq/llama-3.3-70b-versatile", "openai/gpt-5"
    model_name: str = "llama-3.1-8b-instant"  # Default: Groq's fast Llama
    provider: str | None = None  # Provider override (groq, openai, anthropic, etc.)
    temperature: float = 0.0
    max_tokens: int = 4096
    api_key: str | None = None  # Override API key
    api_base: str | None = None  # Override API base URL

    # Reporting
    save_detailed_logs: bool = True
    save_trajectories: bool = True
    generate_report: bool = True
    compare_leaderboard: bool = True

    # Result naming - include model in output path
    include_model_in_output: bool = True  # Prevents overwriting results from different models

    # Orchestrated evaluation mode
    orchestrated: bool = False
    execution_mode: str = "orchestrated"  # orchestrated | direct_shell
    matrix: bool = False
    orchestrator_model: str = "gpt-4o"
    provider_set: list[str] = field(
        default_factory=lambda: ["claude-code", "swe-agent", "codex"]
    )
    required_capabilities: list[str] = field(default_factory=list)
    strict_capabilities: bool = False


@dataclass
class GAIABenchmarkResults:
    """Full benchmark results with analysis."""
    metadata: dict[str, str | int | float | bool]
    results: list[GAIAResult]
    metrics: GAIAMetrics
    leaderboard_comparison: LeaderboardComparison | None = None
    summary: dict[str, str | list[str]] = field(default_factory=dict)


# Leaderboard reference scores (as of 2025)
# Source: https://huggingface.co/spaces/gaia-benchmark/leaderboard
LEADERBOARD_SCORES: dict[str, dict[str, float]] = {
    "h2oGPTe Agent (2025-01)": {
        "level_1": 0.75,
        "level_2": 0.62,
        "level_3": 0.48,
        "overall": 0.65,
    },
    "Langfun ReAct Agent": {
        "level_1": 0.58,
        "level_2": 0.45,
        "level_3": 0.35,
        "overall": 0.49,
    },
    "Magentic-1 (2024-11)": {
        "level_1": 0.52,
        "level_2": 0.35,
        "level_3": 0.22,
        "overall": 0.38,
    },
    "AutoGen + GPT-4": {
        "level_1": 0.48,
        "level_2": 0.32,
        "level_3": 0.18,
        "overall": 0.35,
    },
    "GPT-4 + Plugins (baseline)": {
        "level_1": 0.25,
        "level_2": 0.12,
        "level_3": 0.05,
        "overall": 0.15,
    },
    "Human Performance": {
        "level_1": 0.95,
        "level_2": 0.92,
        "level_3": 0.88,
        "overall": 0.92,
    },
}
