"""T57_officeqa_mad_excise_tax grader — Mean Absolute Deviation of excise tax receipts FY2018."""

from __future__ import annotations

import logging
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.officeqa_reward import extract_final_answer, score_answer
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage

log = logging.getLogger(__name__)

GROUND_TRUTH = "1400.306"
TOLERANCE = 0.05


class OfficeQAMADExciseTaxGrader(AbstractGrader):
    """Grader for T57: MAD of monthly excise tax receipts FY2018.

    The agent must OCR a Treasury Bulletin (December 2018), extract all 12 monthly
    net budget receipts from excise taxes for FY2018 (Oct 2017 through Sep 2018),
    compute the mean, then compute the Mean Absolute Deviation, and report
    1,400.306 million dollars rounded to the thousandths place.

    Scoring: rule-based for numerical accuracy and OCR tool usage;
    LLM judge for statistical computation methodology quality.
    """

    # ------------------------------------------------------------------ #
    # LLM Judge rubric
    # ------------------------------------------------------------------ #

    _METHODOLOGY_RUBRIC = """\
Evaluate the agent's methodology in computing the Mean Absolute Deviation (MAD) of \
monthly net budget receipts from excise taxes for FY2018.
The correct answer is 1,400.306 million dollars.
Score each of the three parts separately, then compute a weighted final score (0-1).

=== Part 1: MAD Computation Method (weight 45%) ===
The agent needed to:
- Understand MAD formula: (1/n) × Σ|xi - mean| where n=12 months
- First compute the mean of all 12 monthly values
- Then compute the absolute deviation of each month from the mean
- Average the absolute deviations
- Show computation steps with actual monthly values

Part 1 scoring:
- 0.9-1.0: Correct MAD formula stated, showed mean computation, showed deviations, \
correct final result
- 0.7-0.8: Correct formula and result but intermediate steps abbreviated
- 0.5-0.6: Used MAD concept correctly but some computational errors
- 0.2-0.4: Attempted deviation calculation but wrong formula (e.g., standard deviation)
- 0.0-0.1: No statistical computation attempted

=== Part 2: Data Extraction (weight 30%) ===
- Extracted all 12 monthly excise tax receipt values for FY2018
- Correctly identified FY2018 as October 2017 through September 2018
- Found the correct table (net budget receipts, excise taxes category)
- Handled OCR data quality issues appropriately

Part 2 scoring:
- 0.9-1.0: All 12 months extracted from correct table with correct FY period
- 0.7-0.8: Most months extracted correctly, minor gaps
- 0.4-0.6: Some monthly data found but incomplete or wrong table
- 0.0-0.3: Failed to extract monthly data

=== Part 3: Answer Presentation (weight 25%) ===
- Reported with correct precision (thousandths place: 1400.306)
- Stated units (millions of dollars)
- Explained what MAD measures in this context

Part 3 scoring:
- 0.9-1.0: Correct precision, correct units, explained MAD meaning
- 0.6-0.8: Correct precision and units but no explanation
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

        # 3) MAD methodology quality (0.35) — LLM Judge
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
