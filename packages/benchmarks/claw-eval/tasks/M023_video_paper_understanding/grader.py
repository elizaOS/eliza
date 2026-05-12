"""M023_video_paper_understanding grader — paper title, Meta Queries, formulas."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoPaperUnderstandingGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade paper understanding from video presentation.

    5 weighted parts: title(0.2) + mechanism(0.4) + formula(0.15) + plain(0.15) + open-source(0.1).
    """

    RUBRIC = """\
Ground Truth:
Paper title: "OmniTransfer: All-in-one Framework for Spatio-temporal Video Transfer"

Part 1 - Correct Full Name (0.2):
Must state the exact paper title. Minor typos acceptable. Score 0.2 if correct, 0 otherwise.

Part 2 - Core Mechanism and Training (0.4):
- Interaction mechanism explanation (0.2): Must mention Qwen-2.5-VL replacing T5, \
explain Meta Queries' different treatment for time-related tasks (aggregating timeline \
cues + first frames) vs appearance-related tasks (integrating identity style + prompt semantics).
- Decoupled training objectives (0.2): Must accurately describe 3 training stages: \
Stage 1 trains diffusion module, Stage 2 trains connector, Stage 3 joint fine-tuning.

Part 3 - Formula Accuracy (0.15):
Must list the cross-attention formula: Attn(Q_tgt, K_MLLM, V_MLLM) \
with basic variable explanations. Full 0.15 if formula matches; 0 if structural errors.

Part 4 - Plain Expression (0.15):
Uses metaphors/analogies easy for non-professionals (e.g. dictionary, guide). \
If entirely rigid academic jargon, score 0.

Part 5 - Open Source Judgment (0.1):
Must explicitly answer "Already open-sourced" or equivalent. Score 0.1 if correct.

Final score = sum of all parts (0.0-1.0)."""

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
        if not final_text.strip():
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        if judge:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=final_text,
                actions_summary="",
                rubric=self.RUBRIC,
            )
            scores.completion = result.score if result else 0.0

        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
