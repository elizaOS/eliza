"""M020_multi_doc_extraction_bar_chart grader — CSV + grouped bar chart from 3 PDFs."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class MultiDocExtractionBarChartGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade grouped bar chart task: CSV data accuracy + chart visual quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy + NaN handling)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/meta_analysis.csv"
    PNG_FILE = "/workspace/cross_benchmark_comparison.png"

    DATA_RUBRIC = """\
Ground Truth data:
Model                       RefCOCO-avg     ERQA
Qwen3-VL-A22B-Instruct     91.9            51.3
GLM-4.6V                   88.6            47.8
Seed-1.5-VL-Thinking       91.3            NaN

Evaluate the CSV content for:
1. Data accuracy: All numerical values match the ground truth.
2. Anomaly handling: The agent correctly identifies that the ERQA score for
   Seed-1.5-VL-Thinking is missing/unavailable and represents it as NaN or
   empty (not as 0 or a guessed value).

Scoring:
- 1.0: All values correct AND missing ERQA properly handled as NaN/empty.
- 0.7-0.9: Values correct but NaN handling imperfect (e.g., marked as 0).
- 0.3-0.6: Some correct values but significant errors.
- 0.0-0.2: Mostly incorrect data.

Output a score between 0.0 and 1.0."""

    VISUAL_RUBRIC = """\
Evaluate this grouped bar chart for:

1. Chart Specifications (weight ~67%):
   - Must be a GROUPED Bar Chart (bars side-by-side, NOT stacked)
   - Legend is present identifying the two benchmarks (RefCOCO-avg and ERQA)
   - X-axis labels show the three model names correctly
   - The missing Seed-1.5-VL-Thinking ERQA data is handled gracefully
     (no crash, no misleading bar at 0)
   - Data values visually match the GT

2. Aesthetic Quality (weight ~33%):
   - Text elements (model names on x-axis) are fully visible, not cropped/overlapping
   - Axis labels are present and readable
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
                context="Evaluate this grouped bar chart for data visualization quality.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.4 * data_score + 0.6 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
