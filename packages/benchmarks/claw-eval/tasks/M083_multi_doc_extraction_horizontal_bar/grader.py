"""M083_multi_doc_extraction_horizontal_bar grader — CSV + horizontal bar from PDFs."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class MultiDocExtractionHorizontalBarGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade Document AI metrics: CSV data accuracy + horizontal bar chart quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/doc_ai_metrics.csv"
    PNG_FILE = "/workspace/doc_ai_horizontal.png"

    DATA_RUBRIC = """\
Ground Truth:
Model             DocVQA    ChartQA    TextVQA
Qwen2.5-VL-72B   96.4      89.5       83.5
DeepSeek-VL2      93.3      86.0       84.2

Scoring is strictly based on one criterion:

- [+1.0] Data Extraction Precision:
  Successfully extracts the correct metrics for the requested models across
  the three benchmarks. CSV has 4 columns: Model, DocVQA, ChartQA, TextVQA.
  Both models present with all correct values.
  Award 0 if any model missing or any score is wrong.

Output a score between 0.0 and 1.0."""

    VISUAL_RUBRIC = """\
Ground Truth (expected bar lengths):
  Model             DocVQA  ChartQA  TextVQA
  Qwen2.5-VL-72B   96.4    89.5     83.5
  DeepSeek-VL2      93.3    86.0     84.2

Scoring is strictly additive from 0.0:

- [+0.5] Chart Specifications (Horizontal Grouping & Hex Colors):
  The chart is strictly a Horizontal Grouped Bar Chart (bars extending left
  to right). Y-axis contains model names. Bar lengths should approximately
  match the GT values above. Colors match the requested Hex codes: #1f77b4
  (DocVQA), #ff7f0e (ChartQA), #2ca02c (TextVQA). Legend reflects this
  color-benchmark mapping.
  Award 0 if wrong chart type (vertical instead of horizontal), wrong
  color codes, or missing legend.

- [+0.5] Aesthetic Quality:
  Model names on y-axis are fully readable and aligned properly with their
  grouped bars. Clean layout.
  Award 0 if model names are unreadable or bars are misaligned.

Output a score between 0.0 and 1.0 as the sum of awarded components."""

    def grade(
        self,
        messages: list[TraceMessage],
        dispatches: list[ToolDispatch],
        task: TaskDefinition,
        audit_data: dict[str, dict] | None = None,
        judge: Any | None = None,
        media_events: list[MediaLoad] | None = None,
        env_snapshot: dict | None = None,
    ) -> DimensionScores:
        scores = DimensionScores()
        scores.safety = 1.0

        csv_exists = self.check_file_exists(env_snapshot, self.CSV_FILE)
        png_exists = self.check_file_exists(env_snapshot, self.PNG_FILE)
        if not csv_exists or not png_exists:
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        data_score = 0.0
        visual_score = 0.0

        # Phase 1: Data accuracy via text judge
        csv_content = (env_snapshot or {}).get(
            f"file:{self.CSV_FILE}", {}
        ).get("content", "")
        if judge and csv_content.strip():
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"CSV output:\n{csv_content}",
                actions_summary="",
                rubric=self.DATA_RUBRIC,
            )
            data_score = result.score if result else 0.0

        # Phase 2: Chart quality via visual judge
        png_entry = (env_snapshot or {}).get(f"file:{self.PNG_FILE}", {})
        png_b64 = (
            png_entry.get("content", "")
            if png_entry.get("encoding") == "base64"
            else ""
        )
        if judge and png_b64 and hasattr(judge, "evaluate_visual"):
            vis_result = judge.evaluate_visual(
                rubric=self.VISUAL_RUBRIC,
                reference_images_b64=[],
                candidate_images_b64=[png_b64],
                context="Evaluate this horizontal grouped bar chart for data visualization quality.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.4 * data_score + 0.6 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
