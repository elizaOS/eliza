"""M087_multi_doc_extraction_grouped_bar grader — CSV + grouped bar from PDFs."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class MultiDocExtractionGroupedBarGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade LLM instruct comparison: CSV data accuracy + grouped bar chart quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/llm_instruct_comparison.csv"
    PNG_FILE = "/workspace/llm_instruct_chart.png"

    DATA_RUBRIC = """\
Ground Truth:
Model                       GPQA_Diamond    AIME_2024
DeepSeek-V3                 59.1            39.2
Qwen2.5-72B-Instruct       49.0            23.3
LLaMA-3.1-405B-Instruct    51.1            23.3

Scoring is strictly based on one criterion:

- [+1.0] Data Accuracy:
  The extracted CSV data perfectly matches the Ground Truth. All 3 models
  present with correct GPQA_Diamond and AIME_2024 scores. CSV has exactly
  3 columns: Model, GPQA_Diamond, AIME_2024.
  Award 0 if any model missing or any score is wrong.

Output a score between 0.0 and 1.0."""

    VISUAL_RUBRIC = """\
Ground Truth (expected bar heights):
  Model                       GPQA_Diamond  AIME_2024
  DeepSeek-V3                 59.1          39.2
  Qwen2.5-72B-Instruct       49.0          23.3
  LLaMA-3.1-405B-Instruct    51.1          23.3

Scoring is strictly additive from 0.0:

- [+0.5] Chart Specifications:
  The chart is strictly a Grouped Bar Chart (bars side-by-side, NOT stacked).
  Includes a legend identifying GPQA-Diamond and AIME 2024. Correct x-axis
  labels for all three models. Bar heights should approximately match the GT
  values above.
  Award 0 if wrong chart type (stacked instead of grouped), missing legend,
  or wrong model labels.

- [+0.5] Aesthetic Quality & Code Robustness:
  Model names on x-axis fully visible without cropping or overlapping. Bar
  colors are distinguishable. Clean appearance.
  Award 0 if model names overlap or are cropped, or colors indistinguishable.

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
                context="Evaluate this grouped bar chart for data visualization quality.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.34 * data_score + 0.66 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
