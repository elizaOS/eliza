"""M018_doc_extraction_line_chart grader — CSV + line chart from PDF."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocExtractionLineChartGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade line chart task: CSV data accuracy + chart visual quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/duration_comparison.csv"
    PNG_FILE = "/workspace/duration_trend.png"

    DATA_RUBRIC = """\
Ground Truth data (w/ subs scores):
                Short   Medium  Long    Overall
VILA-1.5        68.9    57.4    52.0    59.4
Gemini-1.5-Pro  84.5    81.0    77.4    81.3

Evaluate the CSV content for data accuracy:
- 1.0: All data values match the ground truth exactly.
- 0.7-0.9: Minor discrepancies (e.g., rounding differences within ±0.5).
- 0.3-0.6: Some correct values but significant errors in others.
- 0.0-0.2: Mostly incorrect data.

Output a score between 0.0 and 1.0."""

    VISUAL_RUBRIC = """\
Evaluate this line chart for:

1. Chart Specifications (weight ~67%):
   - Must be a LINE chart with markers (not bar chart, scatter, etc.)
   - X-axis has exactly 3 durations: Short, Medium, Long (excluding Overall)
   - Y-axis range is 0 to 100
   - Legend is present identifying both models
   - Color mapping: Green for VILA-1.5, Purple for Gemini 1.5 Pro
   - Data points match GT: VILA-1.5 (69.9, 55.7, 50.4), Gemini (84.5, 81.0, 77.4)

2. Aesthetic Quality (weight ~33%):
   - No overlapping text/fonts
   - Axis labels are present and readable
   - No misaligned elements
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
                context="Evaluate this line chart for data visualization quality.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.4 * data_score + 0.6 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
