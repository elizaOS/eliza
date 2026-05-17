"""Type definitions for VisualWebBench."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Literal


class VisualWebBenchTaskType(str, Enum):
    """VisualWebBench task/config names."""

    WEB_CAPTION = "web_caption"
    WEBQA = "webqa"
    HEADING_OCR = "heading_ocr"
    ELEMENT_OCR = "element_ocr"
    ELEMENT_GROUND = "element_ground"
    ACTION_PREDICTION = "action_prediction"
    ACTION_GROUND = "action_ground"


VISUALWEBBENCH_TASK_TYPES: tuple[VisualWebBenchTaskType, ...] = tuple(VisualWebBenchTaskType)

# Metric "family" — drives which scorer runs and which aggregate bucket the
# task contributes to. Mirrors the upstream `eval_*` helpers in
# `VisualWebBench/utils/eval_utils.py`:
#   - rouge:  ROUGE-1/2/L (web_caption, heading_ocr, element_ocr)
#   - f1:     ROUGE-1 F1 against best-of-references (webqa)
#   - choice: MCQ letter parsing (element_ground, action_prediction, action_ground)
ScoreKind = Literal["rouge", "f1", "choice"]
BBox = tuple[float, float, float, float]


@dataclass(frozen=True)
class VisualWebBenchTask:
    """A single VisualWebBench QA-style task."""

    id: str
    task_type: VisualWebBenchTaskType
    website: str
    prompt: str
    answer: str | int | list[str] | BBox
    image_path: str | None = None
    image_bytes: bytes | None = None
    image_size: tuple[int, int] | None = None
    options: list[str] | list[BBox] = field(default_factory=list)
    bbox: BBox | None = None
    elem_desc: str = ""
    question: str = ""
    instruction: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def score_kind(self) -> ScoreKind:
        """Return the upstream metric family for this task."""
        if self.task_type in {
            VisualWebBenchTaskType.WEB_CAPTION,
            VisualWebBenchTaskType.HEADING_OCR,
            VisualWebBenchTaskType.ELEMENT_OCR,
        }:
            return "rouge"
        if self.task_type is VisualWebBenchTaskType.WEBQA:
            return "f1"
        return "choice"


@dataclass
class VisualWebBenchPrediction:
    """Agent prediction for one VisualWebBench task."""

    task_id: str
    task_type: VisualWebBenchTaskType
    answer_text: str = ""
    choice_index: int | None = None
    bbox: BBox | None = None
    raw_output: dict[str, Any] = field(default_factory=dict)
    latency_ms: float = 0.0
    error: str | None = None


@dataclass
class VisualWebBenchResult:
    """Scored result for one VisualWebBench task.

    ``metrics`` holds the upstream-shaped metric dict
    (e.g. ``{"rouge_1": 22.3, "rouge_2": 5.1, "rouge_l": 18.0}``) on a 0-100 scale.
    ``score`` is the canonical headline value for this task on a 0-1 scale —
    ``rouge_l/100`` for ROUGE families, ``f1/100`` for webqa, 0-or-1 for choice tasks.
    """

    task_id: str
    task_type: VisualWebBenchTaskType
    website: str
    score_kind: ScoreKind
    score: float
    success: bool
    expected: str | int | list[str] | BBox
    prediction: VisualWebBenchPrediction
    metrics: dict[str, float] = field(default_factory=dict)
    latency_ms: float = 0.0
    error: str | None = None


@dataclass
class VisualWebBenchReport:
    """Aggregate VisualWebBench report."""

    total_tasks: int
    overall_accuracy: float
    by_task_type: dict[str, dict[str, float]]
    average_latency_ms: float
    results: list[VisualWebBenchResult]
    summary: dict[str, Any] = field(default_factory=dict)


@dataclass
class VisualWebBenchConfig:
    """Configuration for VisualWebBench runs."""

    output_dir: str = "./benchmark_results/visualwebbench"
    fixture_path: Path | None = None
    hf_repo: str = "visualwebbench/VisualWebBench"
    split: str = "test"
    task_types: tuple[VisualWebBenchTaskType, ...] = VISUALWEBBENCH_TASK_TYPES
    max_tasks: int | None = None
    mock: bool = False
    use_huggingface: bool = True
    use_sample_tasks: bool = False
    cache_images_to_disk: bool = True
    image_cache_dir: Path | None = None
    provider: str | None = None
    model: str | None = None
    temperature: float = 0.0
    timeout_ms: int = 120000
    bbox_iou_threshold: float = 0.5
    save_traces: bool = True
    app_harness_script: Path | None = None
    app_harness_runtime: str = "bun"
    app_harness_no_launch: bool = True
    app_harness_prompt_via_ui: bool = True
    app_harness_dry_run: bool = False
    app_harness_api_base: str | None = None
    app_harness_ui_url: str | None = None
    app_harness_poll_interval_ms: int | None = None
    verbose: bool = False
