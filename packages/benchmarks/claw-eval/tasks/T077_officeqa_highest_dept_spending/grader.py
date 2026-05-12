"""T51_officeqa_highest_dept_spending grader — highest spending dept FY1955."""

from __future__ import annotations

import logging
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.officeqa_reward import extract_final_answer, score_answer
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage

log = logging.getLogger(__name__)

GROUND_TRUTH = "36080"
TOLERANCE = 0.05


class OfficeQAHighestDeptSpendingGrader(AbstractGrader):
    """Grader for T51: highest spending U.S. Federal Department FY1955.

    The agent must OCR a Treasury Bulletin scan, find the department expenditure
    table for FY1955, identify that Defense is the highest spender, and report
    36,080 million dollars.

    Scoring: rule-based for numerical accuracy, department identification,
    and OCR tool usage; LLM judge for reasoning quality.
    """

    # ------------------------------------------------------------------ #
    # LLM Judge rubric
    # ------------------------------------------------------------------ #

    _REASONING_QUALITY_RUBRIC = """\
Evaluate the quality of the agent's reasoning in finding the highest spending \
U.S. Federal Department in FY1955 from a Treasury Bulletin.
Score each of the three parts separately, then compute a weighted final score (0-1).

=== Part 1: Department Identification & Comparison (weight 45%) ===
The agent needed to compare spending across multiple departments and identify \
the highest one (Department of Defense at 36,080 million):
- Did it explicitly state that Defense / Department of Defense had the highest spending?
- Did it list or compare multiple departments' spending figures to justify this?
- Did it show the comparison logic (not just assert the answer)?

Part 1 scoring:
- 0.9-1.0: Clearly identified Defense as highest, compared with other departments' \
figures to demonstrate this
- 0.7-0.8: Identified Defense as highest with some supporting comparison
- 0.5-0.6: Identified Defense as highest but no comparison shown
- 0.2-0.4: Mentioned Defense but didn't clearly state it was the highest
- 0.0-0.1: Didn't identify the department or named wrong one

=== Part 2: Data Source & Extraction (weight 25%) ===
- Referenced the Treasury Bulletin (October 1958) as data source
- Identified the correct table/section (department expenditures, FY1955)
- Distinguished fiscal year from calendar year

Part 2 scoring:
- 0.9-1.0: Clear data source reference and table identification
- 0.6-0.8: Mentioned source but table identification unclear
- 0.3-0.5: Gave answer without explaining source
- 0.0-0.2: No source reference

=== Part 3: Answer Presentation (weight 30%) ===
- Stated both the department name AND the amount with units
- Provided context (fiscal year 1955, millions of dollars)
- Clear and precise final answer

Part 3 scoring:
- 0.9-1.0: Complete answer (dept name + amount + units + context)
- 0.6-0.8: Has dept and amount but missing units or context
- 0.3-0.5: Only number or only department name
- 0.0-0.2: No clear answer

Output the final weighted score: score = 0.45×Part1 + 0.25×Part2 + 0.30×Part3"""

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

        # 3) Reasoning quality incl. dept identification (0.35) — LLM Judge
        completion += 0.35 * self._call_judge(
            judge, task.prompt.text, conversation, actions_summary,
            self._REASONING_QUALITY_RUBRIC,
        )

        scores.completion = min(completion, 1.0)

        # ── Robustness ──────────────────────────────────────────────
        scores.robustness = self.compute_robustness(dispatches)

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores

