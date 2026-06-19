"""T54_officeqa_bond_yield_change grader — bond yield change WWII to Korean War."""

from __future__ import annotations

import logging
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.officeqa_reward import extract_final_answer, score_answer
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage

log = logging.getLogger(__name__)

GROUND_TRUTH = "0.24"
TOLERANCE = 0.05


class OfficeQABondYieldChangeGrader(AbstractGrader):
    """Grader for T54: absolute change in corporate Aa bond yield WWII→Korean War.

    The agent must OCR a Treasury Bulletin (July 1960), identify the highest
    quality corporate bond yields (Aa grade) for 1945 and 1950, compute the
    absolute change, and report 0.24 percentage points.

    Scoring: rule-based for numerical accuracy and OCR tool usage;
    LLM judge for historical reasoning and computation quality.
    """

    # ------------------------------------------------------------------ #
    # LLM Judge rubric
    # ------------------------------------------------------------------ #

    _REASONING_RUBRIC = """\
Evaluate the agent's reasoning in computing the absolute change in highest quality \
corporate bond yield from the end of WWII (1945) to the start of the Korean War (1950).
The correct answer is 0.24 percentage points.
Score each of the three parts separately, then compute a weighted final score (0-1).

=== Part 1: Historical Period Identification (weight 30%) ===
The agent needed to:
- Correctly identify 1945 as the calendar year marking the end of World War II
- Correctly identify 1950 as the calendar year the Korean War began
- Use calendar year averages (not fiscal year) as specified in the question

Part 1 scoring:
- 0.9-1.0: Both years correctly identified with historical justification
- 0.7-0.8: Both years correct but no historical context
- 0.4-0.6: One year correct, other wrong or ambiguous
- 0.0-0.3: Neither year correctly identified

=== Part 2: Yield Data Extraction & Computation (weight 45%) ===
- Located the correct table with corporate Aa bond yields in the Treasury Bulletin
- Extracted yield values for both 1945 and 1950
- Computed absolute change correctly (|yield_1950 - yield_1945|)
- Showed the computation steps

Part 2 scoring:
- 0.9-1.0: Both yields extracted, computation shown step-by-step, correct result
- 0.7-0.8: Correct computation but steps not fully shown
- 0.4-0.6: Found relevant data but computation errors
- 0.0-0.3: Failed to extract yield data or completely wrong computation

=== Part 3: Answer Presentation (weight 25%) ===
- Stated the answer with appropriate units (percentage points)
- Referenced the bond quality grade (Aa / highest quality)
- Provided context (direction of change, which year was higher)

Part 3 scoring:
- 0.9-1.0: Clear answer with units, bond grade reference, and direction of change
- 0.6-0.8: Answer with units but missing context
- 0.3-0.5: Just a number without proper context
- 0.0-0.2: No clear answer

Output the final weighted score: score = 0.30×Part1 + 0.45×Part2 + 0.25×Part3"""

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

        # 3) Reasoning quality (0.35) — LLM Judge
        completion += 0.35 * self._call_judge(
            judge, task.prompt.text, conversation, actions_summary,
            self._REASONING_RUBRIC,
        )

        scores.completion = min(completion, 1.0)

        # ── Robustness ──────────────────────────────────────────────
        scores.robustness = self.compute_robustness(dispatches)

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
