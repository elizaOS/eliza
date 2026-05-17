"""M079_doc_extraction_f1_verification grader — CSV + grouped bar chart from PDF."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocExtractionF1VerificationGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade F1 verification: CSV data accuracy + grouped bar chart quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/gliner_f1_verification.csv"
    PNG_FILE = "/workspace/gliner_f1_verification.png"

    DATA_RUBRIC = """\
Ground Truth:
Negative_Sampling  Precision  Recall  F1_Reported  F1_Calculated  Match
0%                 49.3       58.1    53.3         53.34          Yes
50%                62.3       59.7    60.9         60.97          Yes
75%                61.1       56.5    58.6         58.71          Yes

F1_Calculated = 2 * P * R / (P + R)

Scoring is strictly additive from 0.0:

- [+0.5] Data Accuracy:
  Correctly extracts all 3 groups of P, R, F1 from Table 5. Recalculated F1
  values are correct (error < 0.05). Match judgments are correct.
  Award 0 if any P/R/F1 values are wrong or F1 recalculation is incorrect.

- [+0.5] File Compliance:
  CSV exists with columns: Negative_Sampling_Ratio, Precision, Recall,
  F1_Reported, F1_Calculated, Match. Data matches Ground Truth. Exactly
  3 data rows.
  Award 0 if columns missing or data rows wrong.

Output a score between 0.0 and 1.0 as the sum of awarded components."""

    VISUAL_RUBRIC = """\
Ground Truth (expected bar heights):
  Negative_Sampling  F1_Reported  F1_Calculated
  0%                 53.3         53.34
  50%                60.9         60.97
  75%                58.6         58.71

Scoring is strictly based on one criterion:

- [+1.0] Visualization Quality:
  PNG exists as a valid grouped bar chart (bars side-by-side, NOT stacked)
  comparing Reported vs Calculated F1 for each of the 3 negative sampling
  ratios. Bar heights should approximately match the GT values above.
  Includes title, axis labels, and legend. Visually clear.
  Award 0 if wrong chart type, missing title/axis labels/legend, or bars
  do not reflect the data.

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
                context="Evaluate this grouped bar chart for data visualization quality.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.66 * data_score + 0.34 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
