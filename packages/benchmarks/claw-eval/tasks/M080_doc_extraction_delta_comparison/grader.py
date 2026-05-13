"""M080_doc_extraction_delta_comparison grader — CSV + delta bar chart from PDF."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocExtractionDeltaComparisonGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade delta comparison: CSV data accuracy + delta bar chart quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/deepseek_v2_vs_llama3.csv"
    PNG_FILE = "/workspace/deepseek_v2_vs_llama3_delta.png"

    DATA_RUBRIC = """\
Ground Truth (from Table 2):
Benchmark          DeepSeek-V2  LLaMA3_70B  Delta
BBH                78.9         81.0        -2.1
MMLU               78.5         78.9        -0.4
DROP               80.1         82.5        -2.4
ARC-Easy           97.6         97.9        -0.3
ARC-Challenge      92.4         93.3        -0.9
HellaSwag          84.2         87.9        -3.7
PIQA               83.7         85.0        -1.3
WinoGrande         84.9         85.7        -0.8
RACE-Middle        73.1         73.3        -0.2
RACE-High          52.7         57.9        -5.2
TriviaQA           79.9         81.6        -1.7
NaturalQuestions   38.7         40.2        -1.5
HumanEval          48.8         48.2        +0.6
MBPP               66.6         68.6        -2.0

Scoring is strictly based on one criterion:

- [+1.0] Data Extraction & Delta Calculation Accuracy:
  Raw scores for all 14 benchmarks match GT. Delta calculations are correct
  (DeepSeek-V2 - LLaMA3_70B). CSV has 4 columns: Benchmark, DeepSeek-V2,
  LLaMA3_70B, Delta.
  Award 0 if any raw scores are wrong, deltas are incorrectly computed, or
  benchmarks are missing.

Output a score between 0.0 and 1.0."""

    VISUAL_RUBRIC = """\
Ground Truth (expected delta bar values):
  BBH: -2.1, MMLU: -0.4, DROP: -2.4, ARC-Easy: -0.3, ARC-Challenge: -0.9,
  HellaSwag: -3.7, PIQA: -1.3, WinoGrande: -0.8, RACE-Middle: -0.2,
  RACE-High: -5.2, TriviaQA: -1.7, NaturalQuestions: -1.5,
  HumanEval: +0.6 (only positive), MBPP: -2.0

Scoring is strictly based on one criterion:

- [+1.0] PNG & Dual-Color Support:
  PNG exists as a bar chart showing Delta values on Y-axis with 14 benchmark
  labels on X-axis. Bar heights should approximately match the GT deltas
  above. Positive deltas colored BLUE, negative deltas colored RED. Only
  HumanEval should be positive (blue); all others negative (red). Benchmark
  names readable.
  Award 0 if dual-color (blue/red) is missing, X-axis does not have all 14
  labels, or labels are unreadable.

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
                context="Evaluate this delta bar chart for data visualization quality.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.5 * data_score + 0.5 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
