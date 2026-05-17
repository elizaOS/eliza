"""Grader for M090_video_movie_qa_wedding: Movie Scene QA - Wedding Hall Characters.

Scoring (total = 1.0):
  - 0.3: Q1 — outfit clash with emcee/host (主持人/司仪)
  - 0.3: Q2 — person urged to recite poem is 袁华 (Yuan Hua)
  - 0.4: Q3 — movie is 《夏洛特烦恼》
"""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


ANSWER_FILE = "/workspace/answer.txt"

QA_RUBRIC = """\
You are evaluating the agent's answers to three questions about a Chinese \
movie scene (from the movie "夏洛特烦恼").

GROUND TRUTH ANSWERS:

Question (1): 走进婚宴大厅的男子发现自己和谁撞衫了？那个人的职业/角色是什么？
Answer: 男子（夏洛）和主持人/司仪撞衫了，两人都穿黑色西装+白衬衫。
Key: 主持人 / 司仪 (emcee/host/MC).

Question (2): 被朋友们起哄即兴作诗的人叫什么？
Answer: 袁华 (Yuan Hua).

Question (3): 这个片段来自哪部电影？
Answer: 《夏洛特烦恼》(Charlotte's Trouble / Goodbye Mr. Loser).

SCORING (return a single score 0.0 to 1.0):
- 0.3 for Q1: correctly identifying the outfit clash is with the emcee/host \
(主持人/司仪). Must identify the ROLE/职业. Partial credit 0.15 if the agent \
describes the clash but gets the role wrong.
- 0.3 for Q2: correctly identifying 袁华 as the poem person. Partial credit \
0.15 if the agent describes the scene correctly but wrong name.
- 0.4 for Q3: correctly identifying the movie as 《夏洛特烦恼》. Accept \
Chinese name, pinyin "Xialuo Te Fannao", or English translation "Goodbye Mr. \
Loser" / "Charlotte's Trouble".

Sum all parts for the final score (0.0 to 1.0)."""


class Grader(AbstractGrader, MultimodalGraderMixin):
    """QA grader: LLM text evaluation of 3 questions."""

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
        snapshot = env_snapshot or {}

        # Try answer.txt first, fall back to conversation
        answer_entry = snapshot.get(f"file:{ANSWER_FILE}", {})
        answer_text = (
            answer_entry.get("content", "").strip()
            if answer_entry.get("encoding") != "base64"
            else ""
        )

        if not answer_text:
            answer_text = self.format_conversation(messages)

        if not answer_text.strip():
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            scores.efficiency_turns = len(
                [m for m in messages if m.message.role == "assistant"]
            )
            return scores

        # LLM judge evaluation
        qa_score = 0.0
        if judge:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"Agent's answer:\n{answer_text}",
                actions_summary="",
                rubric=QA_RUBRIC,
            )
            qa_score = result.score if result else 0.0

        scores.completion = round(qa_score, 3)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )

        print(
            f"[grader] {task.task_id}: qa_score={qa_score:.2f} "
            f"-> completion={scores.completion}"
        )
        return scores
