"""
Mind2Web benchmark type definitions.

Based on OSU-NLP-Group/Mind2Web dataset format:
https://github.com/OSU-NLP-Group/Mind2Web
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Literal


class Mind2WebOperation(str, Enum):
    """Operation types in Mind2Web."""

    CLICK = "CLICK"
    TYPE = "TYPE"
    SELECT = "SELECT"
    HOVER = "HOVER"
    ENTER = "ENTER"


class Mind2WebSplit(str, Enum):
    """Dataset splits available in Mind2Web."""

    TRAIN = "train"
    TEST_TASK = "test_task"  # Cross-Task: same websites, new tasks
    TEST_WEBSITE = "test_website"  # Cross-Website: new websites
    TEST_DOMAIN = "test_domain"  # Cross-Domain: new domains


@dataclass
class Mind2WebElement:
    """A DOM element candidate in Mind2Web."""

    tag: str
    backend_node_id: str
    attributes: dict[str, str] = field(default_factory=dict)
    is_original_target: bool = False
    is_top_level_target: bool = False
    text_content: str = ""


@dataclass
class Mind2WebActionStep:
    """A single action step in a Mind2Web task trace."""

    action_uid: str
    operation: Mind2WebOperation
    value: str = ""  # Text typed or option selected
    original_op: str = ""  # Original annotation before normalization
    raw_html: str = ""
    cleaned_html: str = ""
    pos_candidates: list[Mind2WebElement] = field(default_factory=list)
    neg_candidates: list[Mind2WebElement] = field(default_factory=list)
    screenshot_path: Path | None = None

    @property
    def target_element(self) -> Mind2WebElement | None:
        """Get the target element for this action."""
        for elem in self.pos_candidates:
            if elem.is_original_target:
                return elem
        return self.pos_candidates[0] if self.pos_candidates else None


@dataclass
class Mind2WebTask:
    """A Mind2Web task/trajectory."""

    annotation_id: str
    confirmed_task: str  # The instruction/goal
    website: str
    domain: str
    subdomain: str = ""
    action_reprs: list[str] = field(default_factory=list)  # Human-readable action sequence
    actions: list[Mind2WebActionStep] = field(default_factory=list)
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)

    @property
    def instruction(self) -> str:
        """Alias for confirmed_task."""
        return self.confirmed_task

    @property
    def num_steps(self) -> int:
        """Number of action steps in this task."""
        return len(self.actions)


@dataclass
class Mind2WebAction:
    """An action predicted or executed by the agent."""

    operation: Mind2WebOperation
    element_id: str = ""  # Backend node ID or selector
    value: str = ""  # For TYPE/SELECT operations
    reasoning: str = ""  # Agent's reasoning for this action


@dataclass
class Mind2WebStepResult:
    """Result of evaluating a single step."""

    step_index: int
    predicted_action: Mind2WebAction | None
    ground_truth: Mind2WebActionStep
    element_correct: bool = False
    operation_correct: bool = False
    value_correct: bool = False
    step_correct: bool = False  # All components correct
    latency_ms: float = 0.0


@dataclass
class Mind2WebResult:
    """Result of evaluating a Mind2Web task."""

    task_id: str
    instruction: str
    website: str
    domain: str
    trial_number: int = 1
    success: bool = False
    element_accuracy: float = 0.0  # % of steps with correct element
    operation_accuracy: float = 0.0  # % of steps with correct operation
    step_accuracy: float = 0.0  # % of fully correct steps
    steps_completed: int = 0
    total_steps: int = 0
    step_results: list[Mind2WebStepResult] = field(default_factory=list)
    latency_ms: float = 0.0
    error: str | None = None
    agent_trajectory: list[Mind2WebAction] = field(default_factory=list)


@dataclass
class Mind2WebReport:
    """Benchmark report for Mind2Web."""

    total_tasks: int
    total_trials: int
    overall_element_accuracy: float
    overall_operation_accuracy: float
    overall_step_accuracy: float
    overall_task_success_rate: float
    by_domain: dict[str, dict[str, float]] = field(default_factory=dict)
    by_website: dict[str, dict[str, float]] = field(default_factory=dict)
    average_latency_ms: float = 0.0
    results: list[Mind2WebResult] = field(default_factory=list)
    summary: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass
class Mind2WebConfig:
    """Configuration for Mind2Web benchmark runs."""

    # Output
    output_dir: str = "./benchmark_results/mind2web"
    save_detailed_logs: bool = True

    # Task selection
    split: Mind2WebSplit = Mind2WebSplit.TEST_TASK
    max_tasks: int | None = None
    num_trials: int = 1
    max_steps_per_task: int = 20

    # Timing
    timeout_ms: int = 120000
    step_timeout_ms: int = 30000

    # Model configuration
    model_provider: str | None = None  # groq, openai, anthropic, etc.
    model_name: str | None = None
    temperature: float = 0.0
    groq_small_model: str | None = "qwen3"
    groq_large_model: str | None = "qwen3"

    # Evaluation mode
    use_mock: bool = False
    use_screenshots: bool = False  # Use multimodal Mind2Web
    verbose: bool = False
    check_should_respond: bool = False
    advanced_planning: bool = False

    # Trajectory logging
    enable_trajectory_logging: bool = True
    trajectory_export_format: Literal["art", "grpo"] = "art"

    # Browser configuration
    headless: bool = True
    browser_timeout_ms: int = 30000
