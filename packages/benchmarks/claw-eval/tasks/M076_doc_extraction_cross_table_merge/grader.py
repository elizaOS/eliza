"""M076_doc_extraction_cross_table_merge grader — CSV + horizontal bar chart from PDF."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocExtractionCrossTableMergeGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade cross-table merge: CSV data accuracy + horizontal bar chart quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/internvl_cross_table_merged.csv"
    PNG_FILE = "/workspace/internvl_cross_table_chart.png"

    DATA_RUBRIC = """\
Ground Truth (models in both Table 2 and Table 3, sorted by MMT-Bench Overall desc):

Model              DocVQA ChartQA InfoVQA TextVQA OCRBench MMMU MMBench_EN MMVet MathVista MMT_Bench_Overall
InternVL 1.2       57.7   68.0    39.5    72.5    569      51.6 82.2       48.9  47.7      63.4
Qwen-VL-Plus       91.4   78.1    -       -       694      45.2 67.0       61.1  43.3      62.3
GPT-4V             88.4   78.5    -       78.0    645      56.8 77.0       67.6  49.9      62.0
Gemini Pro 1.0     88.1   74.1    75.2    74.6    659      47.9 73.6       64.3  45.2      61.6
LLaVA-NeXT         84.0   68.7    51.5    69.5    574      51.1 81.1       57.4  46.5      60.8
InternVL 1.5       90.9   83.8    72.5    80.6    724      45.2 82.2       62.8  53.5      59.0
Claude-3 Haiku     88.8   81.7    -       -       658      50.2 60.7       -     46.4      52.2

Scoring is strictly additive from 0.0:

- [+0.5] Data Accuracy:
  CSV contains the correct 7 overlapping models with GT values. Sort order by
  MMT-Bench Overall is descending. Missing values marked as "-" or empty.
  Award 0 if wrong set of models, wrong sort order, or incorrect values.

- [+0.5] File Compliance:
  CSV has proper headers (Model + 10 benchmark columns). Uses comma delimiter.
  All required columns present. Exactly 7 data rows.
  Award 0 if columns are missing or file is malformed.

Output a score between 0.0 and 1.0 as the sum of awarded components."""

    VISUAL_RUBRIC = """\
Ground Truth (4 metrics per model, sorted by MMT-Bench Overall descending):
  Model            DocVQA  ChartQA  MMMU  MMT_Bench_Overall
  InternVL 1.2     57.7    68.0     51.6  63.4
  Qwen-VL-Plus     91.4    78.1     45.2  62.3
  GPT-4V           88.4    78.5     56.8  62.0
  Gemini Pro 1.0   88.1    74.1     47.9  61.6
  LLaVA-NeXT       84.0    68.7     51.1  60.8
  InternVL 1.5     90.9    83.8     45.2  59.0
  Claude-3 Haiku   88.8    81.7     50.2  52.2

Scoring is strictly based on one criterion:

- [+1.0] Chart Correctness & Aesthetics:
  Must be a HORIZONTAL GROUPED bar chart (bars extending left to right).
  Shows 4 metrics (DocVQA, ChartQA, MMMU, MMT-Bench Overall) side by side.
  Models on y-axis sorted by MMT-Bench Overall (highest on top). Bar lengths
  should approximately match the GT values above. Legend identifies all 4
  benchmarks. Model names fully readable. Colors distinguishable.
  Award 0 if wrong chart type, wrong metrics, wrong sort order, or model
  names are unreadable.

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
                context="Evaluate this horizontal grouped bar chart for data visualization quality.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.67 * data_score + 0.33 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
