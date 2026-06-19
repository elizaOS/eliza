"""M077_doc_extraction_cross_modality grader — CSV + scatter plot from PDF."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocExtractionCrossModalityGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade cross-modality analysis: CSV data accuracy + scatter plot quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/llava_ov_cross_modality.csv"
    PNG_FILE = "/workspace/llava_ov_cross_modality_chart.png"

    DATA_RUBRIC = """\
Ground Truth (sorted by Average_Video descending):

Model                AI2D  ChartQA DocVQA MathVista MMMU  MMVet ActNetQA EgoSchema MLVU  MVBench PercepTest VideoMME Avg_SI  Avg_Video
LLaVA-OV-72B        85.6  83.7    91.3   67.5      56.8  63.7  62.3     62.0      68.0  59.4    66.9       66.2     74.77   64.13
LLaVA-OV-72B (SI)   85.1  84.9    91.8   66.5      57.4  60.0  62.1     58.6      60.9  57.1    62.3       64.8     74.28   60.97
LLaVA-OV-7B         81.4  80.0    87.5   63.2      48.8  57.5  56.6     60.1      64.7  56.7    57.1       58.2     69.73   58.90
LLaVA-OV-7B (SI)    81.6  78.8    86.9   56.1      47.3  58.8  55.1     52.9      60.2  51.2    54.9       55.0     68.25   54.88
GPT-4V              78.2  78.5    88.4   49.9      56.8  49.9  57.0     -         49.2  43.5    -          59.9     66.95   52.40*
LLaVA-OV-0.5B       57.1  61.4    70.0   34.8      31.4  29.1  50.5     26.8      50.3  45.5    49.2       44.0     47.30   44.38
LLaVA-OV-0.5B (SI)  54.2  61.0    71.2   34.6      31.2  26.9  49.0     33.1      47.9  43.3    48.6       41.7     46.52   43.93

*GPT-4V averages computed over available values only (skip missing).

Scoring is strictly additive from 0.0:

- [+0.5] Data Accuracy:
  CSV contains the 7 models above with correct scores. Average scores correctly
  computed (mean of available values). Sort order by Average_Video is correct.
  GPT-4V missing values handled correctly (averaged over available only).
  Award 0 if wrong set of models, wrong averages, or wrong sort order.

- [+0.5] File Compliance:
  CSV has all 15 required columns. Well-formed with comma delimiter. Missing
  values properly marked.
  Award 0 if columns missing or file malformed.

Output a score between 0.0 and 1.0 as the sum of awarded components."""

    VISUAL_RUBRIC = """\
Ground Truth (expected scatter point positions):
  Model                Avg_Single_Image(x)  Avg_Video(y)
  LLaVA-OV-72B        74.77                64.13
  LLaVA-OV-72B (SI)   74.28                60.97
  LLaVA-OV-7B         69.73                58.90
  LLaVA-OV-7B (SI)    68.25                54.88
  GPT-4V              66.95                52.40
  LLaVA-OV-0.5B       47.30                44.38
  LLaVA-OV-0.5B (SI)  46.52                43.93

Scoring is strictly based on one criterion:

- [+1.0] Chart Correctness & Aesthetics:
  Must be a SCATTER plot (not bar or line). X-axis: Average_Single_Image,
  Y-axis: Average_Video. Each point labeled with model name. Diagonal y=x
  reference line present. Data point positions should approximately match
  the GT coordinates above (7 points). Labels readable. Axes labeled.
  Award 0 if wrong chart type, missing reference line, missing labels, or
  labels are unreadable.

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
                context="Evaluate this scatter plot for data visualization quality.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.67 * data_score + 0.33 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
