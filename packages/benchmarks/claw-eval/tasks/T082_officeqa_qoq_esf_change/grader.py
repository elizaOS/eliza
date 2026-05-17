"""T56_officeqa_qoq_esf_change grader — QoQ percent change in ESF total assets 2022."""

from __future__ import annotations

import logging
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.officeqa_reward import extract_final_answer, score_answer
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage

log = logging.getLogger(__name__)

GROUND_TRUTH = "4.815"
TOLERANCE = 0.05


class OfficeQAQoQESFChangeGrader(AbstractGrader):
    """Grader for T56: QoQ percent change in ESF total assets.

    The agent must OCR a Treasury Bulletin (December 2022), locate the Exchange
    Stabilization Fund balance sheet, extract total assets for end of Q2 (June)
    and Q3 (September) 2022, compute the absolute QoQ percent change, and
    report 4.815% rounded to the nearest thousandth.

    Scoring: rule-based for numerical accuracy and OCR tool usage;
    LLM judge for computation methodology quality.
    """

    # ------------------------------------------------------------------ #
    # LLM Judge rubric
    # ------------------------------------------------------------------ #

    _METHODOLOGY_RUBRIC = """\
Evaluate the agent's methodology in computing the absolute QoQ percent change in \
total assets of the Exchange Stabilization Fund (ESF) from end of June 2022 to \
end of September 2022.
The correct answer is 4.815%.
Score each of the three parts separately, then compute a weighted final score (0-1).

=== Part 1: QoQ Computation Method (weight 40%) ===
The agent needed to:
- Apply the correct QoQ percent change formula: |(Q3 - Q2) / Q2| × 100
- Extract the correct Q2 (June 30) and Q3 (September 30) total asset values
- Show the computation with actual numbers
- Round to the nearest thousandth (3 decimal places)

Part 1 scoring:
- 0.9-1.0: Correct formula, both values shown, computation step-by-step, proper rounding
- 0.7-0.8: Correct formula and result but steps abbreviated
- 0.5-0.6: Right approach but minor computational or rounding errors
- 0.2-0.4: Attempted percent change but wrong formula or wrong values
- 0.0-0.1: No computation attempted

=== Part 2: ESF Data Identification (weight 35%) ===
- Correctly identified the Exchange Stabilization Fund section in the bulletin
- Found the balance sheet / total assets table
- Extracted values for the correct time periods (Q2 and Q3 2022)
- Understood "end of June" = Q2 end and "end of September" = Q3 end

Part 2 scoring:
- 0.9-1.0: Correct section, correct table, correct quarters identified
- 0.7-0.8: Found ESF data but some ambiguity in quarter identification
- 0.4-0.6: Found relevant financial data but wrong section or periods
- 0.0-0.3: Failed to locate ESF data

=== Part 3: Answer Presentation (weight 25%) ===
- Reported with proper precision (3 decimal places: 4.815%)
- Stated this is an absolute (unsigned) percent change
- Provided context (ESF, total assets, Q2→Q3 2022)

Part 3 scoring:
- 0.9-1.0: Correct precision, noted absolute change, full context
- 0.6-0.8: Correct precision but minimal context
- 0.3-0.5: Answer given but wrong precision or missing context
- 0.0-0.2: No clear answer

Output the final weighted score: score = 0.40×Part1 + 0.35×Part2 + 0.25×Part3"""

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

        # 3) Computation methodology (0.35) — LLM Judge
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
