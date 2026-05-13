"""M073_doc_extraction_training_cost grader — JSON + script + ratio from PDF."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DocExtractionTrainingCostGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade training cost extraction: JSON data + script + ratio accuracy.

    Text-only scoring (no visual judge) across three output files.
    """

    JSON_FILE = "/workspace/training_costs.json"
    SCRIPT_FILE = "/workspace/calculate_ratio.py"
    RATIO_FILE = "/workspace/efficiency_ratio.txt"

    RUBRIC = """\
Ground Truth:
  GNMT + RL: 2.3e19
  ConvS2S: 9.6e18
  Transformer (base model): 3.3e18
  Transformer (big): 2.3e19
  Ratio = 2.3e19 / 3.3e18 = 6.9696... -> 6.97

Prerequisite: training_costs.json, calculate_ratio.py, and efficiency_ratio.txt
must all exist. If any is missing, score 0.

Scoring is strictly additive from 0.0:

- [+0.4] Multimodal Data Parsing:
  The training_costs.json accurately reflects the extracted float values
  (e.g., 2.3e19, 9.6e18). The agent successfully recognized the scientific
  notation 10^18 and 10^19 from the PDF and converted them into valid JSON
  numbers. Award 0 if any value is wrong or missing.

- [+0.2] Code Generation:
  The calculate_ratio.py script reads the JSON file, performs the exact
  division GNMT+RL / Transformer(base model), and rounds to 2 decimal places.
  Award 0 if the script is broken, uses hardcoded values, or wrong division.

- [+0.4] Mathematical Accuracy:
  The file efficiency_ratio.txt strictly contains "6.97" (or minor formatting
  like "Ratio: 6.97"). Award 0 if the ratio is wrong.

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

        json_exists = self.check_file_exists(env_snapshot, self.JSON_FILE)
        script_exists = self.check_file_exists(env_snapshot, self.SCRIPT_FILE)
        ratio_exists = self.check_file_exists(env_snapshot, self.RATIO_FILE)
        if not json_exists or not script_exists or not ratio_exists:
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        json_content = (env_snapshot or {}).get(
            f"file:{self.JSON_FILE}", {}
        ).get("content", "")
        script_content = (env_snapshot or {}).get(
            f"file:{self.SCRIPT_FILE}", {}
        ).get("content", "")
        ratio_content = (env_snapshot or {}).get(
            f"file:{self.RATIO_FILE}", {}
        ).get("content", "")

        combined = (
            f"training_costs.json:\n{json_content}\n\n"
            f"calculate_ratio.py:\n{script_content}\n\n"
            f"efficiency_ratio.txt:\n{ratio_content}"
        )

        completion = 0.0
        if judge and combined.strip():
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"Output files:\n{combined}",
                actions_summary="",
                rubric=self.RUBRIC,
            )
            completion = result.score if result else 0.0

        scores.completion = round(completion, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
