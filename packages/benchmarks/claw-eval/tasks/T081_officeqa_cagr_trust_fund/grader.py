"""T55_officeqa_cagr_trust_fund grader — CAGR for Old-Age and Survivors Insurance trust fund."""

from __future__ import annotations

import logging
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.officeqa_reward import extract_final_answer, score_answer
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage

log = logging.getLogger(__name__)

GROUND_TRUTH = "108.01%"
TOLERANCE = 0.05


class OfficeQACAGRTrustFundGrader(AbstractGrader):
    """Grader for T55: CAGR for OASI trust fund expenditure transfers.

    The agent must OCR a Treasury Bulletin (February 1953), locate expenditure
    transfer data for the Federal Old-Age and Survivors Insurance trust fund,
    extract values for FY1947 and FY1950, compute CAGR, and report 108.01%.

    This requires: OCR → table identification → historical knowledge (Korean War
    started 1950) → CAGR formula application → percentage formatting.

    Scoring: rule-based for numerical accuracy and OCR tool usage;
    LLM judge for CAGR computation methodology quality.
    """

    # ------------------------------------------------------------------ #
    # LLM Judge rubric
    # ------------------------------------------------------------------ #

    _METHODOLOGY_RUBRIC = """\
Evaluate the agent's methodology in computing the Compound Annual Growth Rate (CAGR) \
for expenditure transfers to the Federal Old-Age and Survivors Insurance trust fund \
from FY1947 to FY1950.
The correct answer is 108.01%.
Score each of the three parts separately, then compute a weighted final score (0-1).

=== Part 1: CAGR Formula & Computation (weight 45%) ===
The agent needed to:
- Apply the correct CAGR formula: (end_value / start_value)^(1/n) - 1
- Identify n = 3 years (FY1947 to FY1950)
- Show the computation steps with actual values
- Convert to percentage and round to 2 decimal places

Part 1 scoring:
- 0.9-1.0: Correct formula stated, computation shown step-by-step with actual values
- 0.7-0.8: Correct formula and result but steps not fully shown
- 0.5-0.6: Used CAGR concept but formula application had minor errors
- 0.2-0.4: Attempted growth calculation but wrong formula (e.g., simple growth rate)
- 0.0-0.1: No growth rate computation attempted

=== Part 2: Data Identification & Extraction (weight 30%) ===
- Identified the OASI trust fund expenditure transfer table in the Treasury Bulletin
- Correctly determined FY1950 as the Korean War start year
- Extracted the correct values for FY1947 and FY1950
- Distinguished between different trust fund categories

Part 2 scoring:
- 0.9-1.0: Correct table, correct fiscal years, correct values extracted
- 0.7-0.8: Correct table and years but some uncertainty in values
- 0.4-0.6: Found relevant data but wrong table or wrong fiscal years
- 0.0-0.3: Failed to identify the correct data

=== Part 3: Answer Presentation (weight 25%) ===
- Reported as percentage with 2 decimal places (108.01%)
- Explained what CAGR represents in this context
- Noted the time period and data source

Part 3 scoring:
- 0.9-1.0: Correct format (%), explained CAGR meaning, noted time period
- 0.6-0.8: Correct format but minimal explanation
- 0.3-0.5: Result given but wrong format or no context
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

        # 3) CAGR methodology quality (0.35) — LLM Judge
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
