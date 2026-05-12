"""M082_multi_doc_extraction_scatter grader — CSV + scatter plot from multiple PDFs."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class MultiDocExtractionScatterGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade multi-doc math reasoning: CSV data accuracy + scatter plot quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/reasoning_math.csv"
    PNG_FILE = "/workspace/math_reasoning_scatter.png"

    DATA_RUBRIC = """\
Ground Truth:
Model                AIME_2024    MATH_500
DeepSeek-R1          79.8         97.3
DeepSeek-R1-Zero     77.9         95.9
Qwen3-235B-A22B      85.7         98.0
OpenAI-o1            74.3         96.4

Scoring is strictly based on one criterion:

- [+1.0] Data Accuracy & Cross-Document Alignment:
  The CSV correctly extracts the math metrics from two different PDFs.
  All 4 models present with correct AIME_2024 and MATH_500 scores.
  CSV has 3 columns: Model, AIME_2024, MATH_500.
  Award 0 if any model is missing or any score is wrong.

Output a score between 0.0 and 1.0."""

    VISUAL_RUBRIC = """\
Ground Truth (expected scatter point positions):
  Model               AIME_2024(x)  MATH_500(y)
  DeepSeek-R1         79.8          97.3
  DeepSeek-R1-Zero    77.9          95.9
  Qwen3-235B-A22B     85.7          98.0
  OpenAI-o1           74.3          96.4

Scoring is strictly additive from 0.0:

- [+0.5] Chart Specifications (Scatter & Annotations):
  The chart is strictly a Scatter Plot (not bar or line). Axes correctly
  mapped (AIME 2024 on x, MATH-500 on y). Point positions should
  approximately match the GT coordinates above. Model names appear visually
  next to their respective dots. Exactly 4 data points.
  Award 0 if wrong chart type, wrong axis mapping, or missing model labels.

- [+0.5] Robustness & Aesthetics:
  Annotations do not heavily overlap with axes or each other. Data points
  are not overlapping. Axis labels present. Clean appearance.
  Award 0 if annotations overlap badly or axes unlabeled.

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
                context="Evaluate this scatter plot for data visualization quality.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.4 * data_score + 0.6 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
