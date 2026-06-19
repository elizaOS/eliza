"""M081_doc_extraction_heatmap_comparison grader — CSV + heatmap from PDF."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocExtractionHeatmapComparisonGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade heatmap comparison: CSV data accuracy + heatmap visual quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/mlvu_gpt4o_vs_llava_ov.csv"
    PNG_FILE = "/workspace/mlvu_delta_heatmap.png"

    DATA_RUBRIC = """\
Ground Truth:
Task  GPT-4o  LLaVA-Onevision  Delta
TR    83.7    83.5             +0.2
AR    68.8    56.4             +12.4
NQA   42.9    46.7             -3.8
ER    47.8    58.4             -10.6
PQA   57.1    58.0             -0.9
AO    46.2    35.7             +10.5
AC    35.0    23.3             +11.7

Scoring is strictly based on one criterion:

- [+1.0] Raw Score & Delta Accuracy:
  Raw scores for all 7 tasks match GT. Delta values are correct
  (GPT-4o - LLaVA-Onevision). CSV has 4 columns.
  Award 0 if any raw scores are wrong, deltas are incorrectly computed, or
  tasks are missing.

Output a score between 0.0 and 1.0."""

    VISUAL_RUBRIC = """\
Ground Truth (expected cell values in heatmap):
  Task:       TR    AR    NQA   ER    PQA   AO    AC
  GPT-4o:     83.7  68.8  42.9  47.8  57.1  46.2  35.0
  LLaVA-OV:   83.5  56.4  46.7  58.4  58.0  35.7  23.3

Scoring is strictly based on one criterion:

- [+1.0] Heatmap Quality:
  PNG exists as a HEATMAP (not bar chart or table). Rows are the two models,
  columns are the 7 tasks. Cells annotated with score values that
  approximately match the GT above. Color intensity represents score
  magnitude correctly.
  Award 0 if not a heatmap, wrong layout, cells not annotated with scores,
  or color mapping is wrong.

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
                context="Evaluate this heatmap for data visualization quality.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.5 * data_score + 0.5 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
