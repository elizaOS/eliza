"""M078_doc_extraction_cross_benchmark grader — CSV + radar chart from PDF."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocExtractionCrossBenchmarkGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade cross-benchmark analysis: CSV data accuracy + radar chart quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/qwen2vl_cross_benchmark.csv"
    PNG_FILE = "/workspace/qwen2vl_cross_benchmark_chart.png"

    DATA_RUBRIC = """\
Ground Truth (sorted by MMMU descending):

Model               MMMU  DocVQA ChartQA TextVQA OCRBench RealWorldQA MME     MMBench_EN MMStar MMVet MathVista MVBench PercepTest EgoSchema VideoMME
GPT-4o              69.1  92.8   85.7    -       736      75.4        2328.7  83.4       63.9   69.1  63.8      -       -          72.2      71.9
Claude 3.5 Sonnet   68.3  95.2   90.8    -       788      60.1        1920.0  79.7       62.2   66.0  67.7      -       -          -         -
Qwen2-VL-72B        64.5  96.5   88.3    85.5    877      77.8        2482.7  86.5       68.3   74.0  70.5      73.6    68.0       77.9      71.2
Qwen2-VL-7B         54.1  94.5   83.0    84.3    866      70.1        2326.8  83.0       60.7   62.0  58.2      67.0    62.3       66.7      63.3
Qwen2-VL-2B         41.1  90.1   73.5    79.7    809      62.9        1872.0  74.9       48.0   49.5  43.0      63.2    53.9       54.9      55.6

Note: Claude 3.5 Sonnet missing MVBench, PerceptionTest, EgoSchema, VideoMME.
GPT-4o missing MVBench, PerceptionTest.

Scoring is strictly additive from 0.0:

- [+0.5] Data Accuracy:
  All 5 models present with correct benchmark scores. Sort order by MMMU
  descending. Missing values properly marked.
  Award 0 if wrong models, wrong sort, or incorrect values.

- [+0.5] File Compliance:
  CSV has all 16 columns. Well-formed with comma delimiter.
  Award 0 if columns missing or CSV malformed.

Output a score between 0.0 and 1.0 as the sum of awarded components."""

    VISUAL_RUBRIC = """\
Ground Truth (raw values for the 3 models on 6 metrics, to be normalized):
  Metric      Qwen2-VL-72B  GPT-4o  Claude 3.5 Sonnet
  MMMU        64.5          69.1    68.3
  DocVQA      96.5          92.8    95.2
  ChartQA     88.3          85.7    90.8
  MathVista   70.5          63.8    67.7
  MVBench     73.6          -       -
  EgoSchema   77.9          72.2    -

Note: Missing values (Claude MVBench/EgoSchema, GPT-4o MVBench) should be
handled gracefully in normalization.

Scoring is strictly based on one criterion:

- [+1.0] Chart Correctness & Aesthetics:
  Must be a RADAR/SPIDER chart (not bar or line chart). Compares exactly
  3 models: Qwen2-VL-72B, GPT-4o, Claude 3.5 Sonnet. Shows 6 normalized
  metrics: MMMU, DocVQA, ChartQA, MathVista, MVBench, EgoSchema. Polygon
  shapes should approximately reflect the relative proportions of the GT
  values above. Legend identifies all 3 models. Labels readable on all axes.
  Three models distinguishable by color/style.
  Award 0 if wrong chart type, wrong models, wrong metrics, or labels
  unreadable.

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
                context="Evaluate this radar chart for data visualization quality.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.67 * data_score + 0.33 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
