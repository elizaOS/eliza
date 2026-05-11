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

ScoreKind = Literal["exact", "choice", "bbox"]
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
    image_size: tuple[int, int] | None = None
    options: list[str] | list[BBox] = field(default_factory=list)
    bbox: BBox | None = None
    elem_desc: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def score_kind(self) -> ScoreKind:
        """Return the default scoring family for this task."""
        if self.task_type in {
            VisualWebBenchTaskType.ELEMENT_GROUND,
            VisualWebBenchTaskType.ACTION_GROUND,
        }:
            return "bbox"
        if self.task_type is VisualWebBenchTaskType.ACTION_PREDICTION:
            return "choice"
        return "exact"


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
    """Scored result for one VisualWebBench task."""

    task_id: str
    task_type: VisualWebBenchTaskType
    website: str
    score_kind: ScoreKind
    score: float
    success: bool
    expected: str | int | list[str] | BBox
    prediction: VisualWebBenchPrediction
    exact_match: bool = False
    choice_match: bool = False
    bbox_iou: float | None = None
    latency_ms: float = 0.0
    error: str | None = None


@dataclass
class VisualWebBenchReport:
    """Aggregate VisualWebBench report."""

    total_tasks: int
    overall_accuracy: float
    exact_accuracy: float
    choice_accuracy: float
    bbox_accuracy: float
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
    dry_run: bool = True
    use_huggingface: bool = False
    use_fixture: bool = True
    provider: str | None = None
    model: str | None = None
    temperature: float = 0.0
    timeout_ms: int = 120000
    bbox_iou_threshold: float = 0.5
    save_traces: bool = True
    verbose: bool = False
