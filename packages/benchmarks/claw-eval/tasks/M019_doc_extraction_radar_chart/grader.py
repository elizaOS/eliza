"""M019_doc_extraction_radar_chart grader — CSV + radar chart from PDF."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocExtractionRadarChartGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade radar chart task: CSV data accuracy + chart visual quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/model_comparison.csv"
    PNG_FILE = "/workspace/comparison_radar.png"

    DATA_RUBRIC = """\
Ground Truth data (4 L-1 dimensions + Total):
                Dim1    Dim2    Dim3    Dim4    Total
Qwen3-VL-A22B  69.6    49.7    54.0    0.0     45.1
Gemini-2.5-Pro  34.8    34.0    7.0     7.0     20.7

Evaluate the CSV content for data accuracy:
- 1.0: All data values match the ground truth exactly.
- 0.7-0.9: Minor discrepancies (e.g., rounding differences within ±0.5).
- 0.3-0.6: Some correct values but significant errors in others.
- 0.0-0.2: Mostly incorrect data.

Output a score between 0.0 and 1.0."""

    VISUAL_RUBRIC = """\
Evaluate this radar chart for:

1. Chart Specifications (weight ~67%):
   - Must be a RADAR chart (spider/web chart)
   - Includes exactly 4 L-1 dimensions (excluding Total)
   - Axis range is 0 to 100
   - Legend is present identifying both models
   - Color mapping: Blue for Qwen3, Red for Gemini
   - Data points should match GT values on the 4 dimensions

2. Aesthetic Quality (weight ~33%):
   - No overlapping text/fonts
   - Labels are readable on all axes
   - No incomplete layers or misaligned elements
   - Clean and professional appearance

Score 0.0-1.0 based on the weighted combination of these criteria."""

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
                context="Evaluate this radar chart for data visualization quality.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.4 * data_score + 0.6 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
