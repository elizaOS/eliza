"""T58_officeqa_geometric_mean_silver grader — geometric mean of silver production April-August 1940."""

from __future__ import annotations

import logging
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.officeqa_reward import extract_final_answer, score_answer
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage

log = logging.getLogger(__name__)

GROUND_TRUTH = "5423.58"
TOLERANCE = 0.05


class OfficeQAGeometricMeanSilverGrader(AbstractGrader):
    """Grader for T58: geometric mean of silver production Apr-Aug 1940.

    The agent must OCR a Treasury Bulletin (October 1940), extract monthly silver
    production data (in thousands of nominal fine ounces) for April through August
    1940, compute the geometric mean of 5 values, and report 5,423.58.

    Scoring: rule-based for numerical accuracy and OCR tool usage;
    LLM judge for geometric mean computation methodology quality.
    """

    # ------------------------------------------------------------------ #
    # LLM Judge rubric
    # ------------------------------------------------------------------ #

    _METHODOLOGY_RUBRIC = """\
Evaluate the agent's methodology in computing the geometric mean of silver production \
(thousands of fine ounces) in the United States from April to August 1940.
The correct answer is 5,423.58.
Score each of the three parts separately, then compute a weighted final score (0-1).

=== Part 1: Geometric Mean Computation (weight 45%) ===
The agent needed to:
- Apply the correct geometric mean formula: (x1 × x2 × x3 × x4 × x5)^(1/5)
- Use all 5 monthly values (April, May, June, July, August 1940)
- Show the computation steps (product, then 5th root)
- Round to 2 decimal places

Part 1 scoring:
- 0.9-1.0: Correct formula, all 5 values shown, computation step-by-step, proper rounding
- 0.7-0.8: Correct formula and result but steps abbreviated
- 0.5-0.6: Used geometric mean concept but computational errors
- 0.2-0.4: Confused geometric mean with arithmetic mean or other statistic
- 0.0-0.1: No computation attempted

=== Part 2: Data Extraction (weight 30%) ===
- Located the silver production table in the Treasury Bulletin
- Extracted values for all 5 months (April through August 1940)
- Used the correct unit (thousands of nominal fine ounces)
- Distinguished silver production from other precious metal data

Part 2 scoring:
- 0.9-1.0: All 5 months correctly extracted with right units
- 0.7-0.8: Most months correct, minor data issues
- 0.4-0.6: Some months extracted but incomplete or wrong units
- 0.0-0.3: Failed to extract silver production data

=== Part 3: Answer Presentation (weight 25%) ===
- Reported with 2 decimal places (5423.58)
- Stated units (thousands of fine ounces)
- Listed the individual monthly values used in the computation

Part 3 scoring:
- 0.9-1.0: Correct precision, correct units, monthly values listed
- 0.6-0.8: Correct precision and units but no monthly breakdown
- 0.3-0.5: Answer given but wrong precision or missing units
- 0.0-0.2: No clear answer

Output the final weighted score: score = 0.45×Part1 + 0.30×Part2 + 0.25×Part3"""

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #

    def _call_judge(
        self, judge: Any, task_prompt: str, conversation: str,
        actions: str, rubric: str,
    ) -> float:
        result = judge.evaluate(task_prompt, conversation, actions, rubric)
        return result.score

    # ================================================================== #
    # Main grading
    # ================================================================== #

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

        final_text = self._get_final_assistant_text(messages)
        all_text = self._get_all_assistant_text(messages)
        conversation = self.format_conversation(messages)
        actions_summary = self.summarize_actions(audit_data)

        # ── Completion ──────────────────────────────────────────────
        completion = 0.0

        # 1) Numerical accuracy (0.55) — rule-based
        try:
            answer_text = extract_final_answer(all_text) if all_text else ""
            if answer_text:
                completion += 0.55 * score_answer(GROUND_TRUTH, answer_text, TOLERANCE)
        except Exception:
            pass

        # 2) OCR tool usage (0.10) — rule-based
        if any(d.tool_name == "ocr_extract_text" for d in dispatches if d.response_status < 400):
            completion += 0.10

        # 3) Geometric mean methodology (0.35) — LLM Judge
        completion += 0.35 * self._call_judge(
            judge, task.prompt.text, conversation, actions_summary,
            self._METHODOLOGY_RUBRIC,
        )

        scores.completion = min(completion, 1.0)

        # ── Robustness ──────────────────────────────────────────────
        scores.robustness = self.compute_robustness(dispatches)

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
