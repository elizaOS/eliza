"""T50_officeqa_defense_spending grader — U.S. national defense expenditures 1940."""

from __future__ import annotations

import logging
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.officeqa_reward import extract_final_answer, score_answer
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage

log = logging.getLogger(__name__)

GROUND_TRUTH = "2,602"
TOLERANCE = 0.05


class OfficeQADefenseSpendingGrader(AbstractGrader):
    """Grader for T50: U.S. national defense expenditures (1940).

    The agent must use OCR to extract text from a Treasury Bulletin scan,
    locate the defense expenditures table, and report 2,602 million dollars.

    Scoring: rule-based for numerical accuracy and OCR tool usage;
    LLM judge for answer explanation quality.
    """

    # ------------------------------------------------------------------ #
    # LLM Judge rubric
    # ------------------------------------------------------------------ #

    _ANSWER_QUALITY_RUBRIC = """\
Evaluate the quality of the agent's answer explanation for finding U.S. national \
defense expenditures in 1940 from a Treasury Bulletin.
Score each of the two parts separately, then compute a weighted final score (0-1).

=== Part 1: Data Source & Extraction Process (weight 50%) ===
The agent should demonstrate it correctly processed the OCR output:
- Referenced the Treasury Bulletin as the data source
- Identified the correct table/section containing defense expenditures
- Showed how it located the 1940 calendar year data
- Distinguished between fiscal year and calendar year if relevant

Part 1 scoring:
- 0.9-1.0: Clearly described data source and extraction process, referenced \
specific table/section
- 0.6-0.8: Mentioned data source but extraction process unclear
- 0.3-0.5: Gave an answer without explaining how it was found
- 0.0-0.2: No reference to data source or extraction method

=== Part 2: Answer Presentation & Context (weight 50%) ===
The agent should present the answer clearly with appropriate context:
- Stated the answer with correct units (millions of dollars)
- Provided context (e.g., "national defense" category, calendar year 1940)
- Noted any caveats or data quality issues from OCR

Part 2 scoring:
- 0.9-1.0: Clear answer with units, context, and any relevant caveats
- 0.6-0.8: Answer with units but minimal context
- 0.3-0.5: Just a number without units or context
- 0.0-0.2: No clear answer presented

Output the final weighted score: score = 0.50×Part1 + 0.50×Part2"""

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
        scores.safety = 1.0  # No safety gate for QA tasks

        final_text = self._get_final_assistant_text(messages)
        all_text = self._get_all_assistant_text(messages)
        conversation = self.format_conversation(messages)
        actions_summary = self.summarize_actions(audit_data)

        # ── Completion ──────────────────────────────────────────────
        completion = 0.0

        # 1) Numerical accuracy (0.70) — rule-based
        try:
            answer_text = extract_final_answer(all_text) if all_text else ""
            if answer_text:
                numerical_score = score_answer(GROUND_TRUTH, answer_text, TOLERANCE)
                completion += 0.70 * numerical_score
        except Exception:
            pass

        # 2) OCR tool usage (0.15) — rule-based
        ocr_calls = [d for d in dispatches if d.tool_name == "ocr_extract_text" and d.response_status < 400]
        if ocr_calls:
            completion += 0.15

        # 3) Answer explanation quality (0.15) — LLM Judge
        completion += 0.15 * self._call_judge(
            judge, task.prompt.text, conversation, actions_summary,
            self._ANSWER_QUALITY_RUBRIC,
        )

        scores.completion = min(completion, 1.0)

        # ── Robustness ──────────────────────────────────────────────
        scores.robustness = self.compute_robustness(dispatches)

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )

        return scores

