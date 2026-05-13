"""M075_doc_extraction_spatial_leaderboard grader — CSV + bar chart from PDF."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocExtractionSpatialLeaderboardGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade spatial leaderboard: CSV data accuracy + bar chart quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/top10_os_spatial.csv"
    PNG_FILE = "/workspace/top10_spatial_chart.png"

    DATA_RUBRIC = """\
Ground Truth Top 10 Ranking:
Rank  Model_Condition              Score
1     Qwen3-VL-A22B (Think)       73.7
2     Qwen3-VL-32B (Think)        70.0
3     Qwen3-VL-A3B (Think)        53.3
4     Qwen3-VL-A22B (Base)        49.7
5     Qwen3-VL-32B (Base)         47.3
6     GLM-4.5V (Think)            45.3
7     Qwen3-VL-8B (Think)         43.0
8     GLM-4.5V (Base)             42.0
9     Qwen2.5-VL-72B (Base)       40.3
10    Qwen2.5-VL-32B (Base)       40.0

Scoring is strictly based on one criterion:

- [+1.0] Data Truncation & Output Strictness:
  The CSV strictly contains exactly 10 data rows (plus the header) and 2
  columns (Model_Condition, Score). The order of the models strictly matches
  the GT descending list, successfully blending "(Base)" and "(Think)"
  conditions into a unified ranking. The scores are correctly extracted.
  Award 0 if wrong row count, wrong columns, wrong order, or incorrect values.

Output a score between 0.0 and 1.0."""

    VISUAL_RUBRIC = """\
Ground Truth (expected bar values, descending order):
  1. Qwen3-VL-A22B (Think): 73.7
  2. Qwen3-VL-32B (Think):  70.0
  3. Qwen3-VL-A3B (Think):  53.3
  4. Qwen3-VL-A22B (Base):  49.7
  5. Qwen3-VL-32B (Base):   47.3
  6. GLM-4.5V (Think):      45.3
  7. Qwen3-VL-8B (Think):   43.0
  8. GLM-4.5V (Base):        42.0
  9. Qwen2.5-VL-72B (Base): 40.3
  10. Qwen2.5-VL-32B (Base): 40.0

Scoring is strictly based on one criterion:

- [+1.0] Chart Execution:
  The chart accurately reflects exactly 10 entries with bar heights
  approximately matching the GT values above. Model names on the axis are
  fully legible (e.g., using a horizontal bar chart layout or correctly
  rotating x-axis labels to prevent overlap). Bars are in descending order.
  Award 0 if model names are unreadable, not exactly 10 entries, or wrong order.

Output a score between 0.0 and 1.0."""

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
                context="Evaluate this bar chart for data visualization quality.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.5 * data_score + 0.5 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
