"""M028_video_badminton_score_chart grader — score progression line chart."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoBadmintonScoreChartGrader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Grade badminton score chart: file(0.05) + structure(0.25) + data(0.70).

    Two visual judge calls:
      Call 1 — chart structure (type, axes, dual lines, player names)
      Call 2 — score data accuracy and timestamp annotations
    """

    OUTPUT_FILE = "/workspace/score_chart.png"

    STRUCTURE_RUBRIC = """\
Evaluate this badminton match score chart for structural correctness:

1. Chart Type (0.2): Is it a LINE chart (not bar/scatter/etc.)?
2. Axis Semantics (0.2): X-axis = match time, Y-axis = cumulative score?
3. Dual-Line Distinctiveness (0.2): At least 2 line graphs with clearly different colors?
4. Player Names (0.4): Legend or labels contain both "Kento MOMOTA" and "Viktor AXELSEN" \
(case differences allowed, spelling must be fundamentally correct)?

Score 0.0-1.0 based on these criteria."""

    DATA_RUBRIC = """\
Evaluate this badminton match score chart for data accuracy:

Ground truth score sequence (Momota:Axelsen):
0:0, 0:1, 1:1, 2:1, 2:2, 3:2, 4:2, 5:2, 6:2, 6:3, 7:3, 7:4, 8:4, 9:4, \
9:5, 9:6, 9:7, 9:8, 10:8, 10:9, 11:9, 12:9, 12:10, 13:10, 13:11, 14:11, \
15:11, 16:11, 17:11, 18:11, 19:11, 20:11, 21:11

Key timestamps with scores (must be bold):
7:56 (1:1), 12:46 (7:3), 21:26 (11:9), 25:03 (13:11)

Evaluation criteria:
1. Score annotations (0.5): Are score change points annotated on the chart? \
Compare annotated sequence against ground truth. \
Score based on edit-distance similarity (ratio >= 0.6 maps linearly, <0.6 = 0).
2. Timestamp labels (0.15): Are timestamps 7:56, 12:46, 21:26, 25:03 marked on x-axis?
3. Key score accuracy (0.35): At those 4 timestamps, are the scores displayed and correct? \
Are they bolded?

Score 0.0-1.0 based on weighted criteria."""

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

        # Check file exists
        file_exists = self.check_file_exists(env_snapshot, self.OUTPUT_FILE)
        if not file_exists:
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        # Extract image
        png_entry = (env_snapshot or {}).get(f"file:{self.OUTPUT_FILE}", {})
        png_b64 = (
            png_entry.get("content", "")
            if png_entry.get("encoding") == "base64"
            else ""
        )
        if not png_b64:
            scores.completion = 0.05  # file exists but can't read
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        structure_score = 0.0
        data_score = 0.0

        # Call 1: Structure evaluation
        if judge and hasattr(judge, "evaluate_visual"):
            result = judge.evaluate_visual(
                rubric=self.STRUCTURE_RUBRIC,
                reference_images_b64=[],
                candidate_images_b64=[png_b64],
                context="Evaluate structural correctness of a badminton match score line chart.",
            )
            structure_score = result.score if result else 0.0

        # Call 2: Data accuracy evaluation
        if judge and hasattr(judge, "evaluate_visual"):
            result = judge.evaluate_visual(
                rubric=self.DATA_RUBRIC,
                reference_images_b64=[],
                candidate_images_b64=[png_b64],
                context="Evaluate data accuracy of a badminton match score line chart.",
            )
            data_score = result.score if result else 0.0

        scores.completion = round(0.05 + 0.25 * structure_score + 0.70 * data_score, 2)
        scores.completion = min(scores.completion, 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
