"""M074_doc_extraction_thinking_impact grader — CSV + bar chart from PDF."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocExtractionThinkingImpactGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade thinking impact analysis: CSV data accuracy + bar chart quality.

    Two-phase scoring:
      Phase 1 — text judge on CSV content (data accuracy)
      Phase 2 — visual judge on PNG chart (chart specs + aesthetics)
    """

    CSV_FILE = "/workspace/thinking_relative_impact.csv"
    PNG_FILE = "/workspace/relative_gain_bar.png"

    DATA_RUBRIC = """\
Ground Truth (6 Open-Source Models, sorted by relative increase descending):
Model               Baseline  Think   Relative_Increase
MiMo-VL-7B-RL      18.6      24.1    29.57%
Qwen3-VL-32B       39.5      46.9    18.73%
Qwen3-VL-8B        31.0      34.3    10.65%
Qwen3-VL-A22B      45.1      49.8    10.42%
Qwen3-VL-A3B       35.7      39.2    9.80%
GLM-4.5V           32.1      34.0    5.92%

Note: Seed-1.6-V must be excluded (commercial model per Section 4.1).

Scoring is strictly additive from 0.0:

- [+0.5] Information Filtering & Math Accuracy:
  The agent successfully filtered out Seed-1.6-V, leaving exactly 6 open-source
  models. Baseline and thinking accuracies are correctly extracted from Table 3
  and Figure 5. The relative percentage was correctly calculated using
  (Think - Base) / Base * 100 and rounded to 2 decimal places.
  Award 0 if Seed-1.6-V is included, if any model is missing, or if the
  relative percentages are wrong.

- [+0.5] Relational Logic & Sorting:
  Rows are strictly sorted in descending order of relative percentage increase
  (MiMo-VL-7B-RL first, GLM-4.5V last).
  Award 0 if the sort order is wrong.

Output a score between 0.0 and 1.0 as the sum of awarded components."""

    VISUAL_RUBRIC = """\
Ground Truth (expected bar heights, sorted descending):
  MiMo-VL-7B-RL:  29.57%
  Qwen3-VL-32B:   18.73%
  Qwen3-VL-8B:    10.65%
  Qwen3-VL-A22B:  10.42%
  Qwen3-VL-A3B:    9.80%
  GLM-4.5V:        5.92%

Scoring is strictly based on one criterion:

- [+1.0] Chart Execution & Autonomous Formatting:
  Must be a vertical BAR chart showing relative percentage increase for exactly
  6 open-source models only. Bars sorted in descending order (MiMo-VL-7B-RL
  highest, GLM-4.5V lowest). Bar heights should approximately match the GT
  percentages above. Model names on x-axis must be fully readable (no
  overlap/cropping). Axis labels present.
  Award 0 if wrong chart type, wrong number of models, wrong sort order, or
  model names are unreadable.

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

        scores.completion = round(0.66 * data_score + 0.34 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
