"""Grader for M096_video_movie_title_director: Movie Title and Director Identification.

Task: Watch the video and identify the movie name and director.

GT: Movie title = 影 (SHADOW), Director = 张艺谋

Scoring (total = 1.0):
  - 0.4: Movie title correct — "影" or "SHADOW"
  - 0.6: Director correct — 张艺谋 (Zhang Yimou)
"""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


ANSWER_FILE = "/workspace/answer.txt"

TITLE_RUBRIC = """\
You are evaluating whether the agent correctly identified the movie title.

The correct movie title is: 影 (English: SHADOW)

The agent's answer is provided below. Check if it contains the correct title.

Scoring:
- 1.0: The answer contains "影" or "SHADOW" as the movie title.
- 0.0: The answer does not contain the correct title."""

DIRECTOR_RUBRIC = """\
You are evaluating whether the agent correctly identified the movie director.

The correct director is: 张艺谋 (Zhang Yimou)

The agent's answer is provided below. Check if it contains the correct director.

Scoring:
- 1.0: The answer contains "张艺谋" or "Zhang Yimou" (case-insensitive).
- 0.0: The answer does not contain the correct director name."""


class Grader(AbstractGrader, MultimodalGraderMixin):
    """Movie title and director identification grader."""

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
        total = 0.0

        # Read answer.txt
        answer_entry = snapshot.get(f"file:{ANSWER_FILE}", {})
        answer_text = (
            answer_entry.get("content", "").strip()
            if answer_entry.get("encoding") != "base64"
            else ""
        )

        if not answer_text:
            # Fall back to conversation if no answer file
            answer_text = self.format_conversation(messages)

        if answer_text and judge:
            # ------------------------------------------------------------------
            # 1. Movie title (0.4)
            # ------------------------------------------------------------------
            title_score = 0.0
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"Agent's answer:\n{answer_text}",
                actions_summary="",
                rubric=TITLE_RUBRIC,
            )
            title_score = result.score if result else 0.0
            total += 0.4 * title_score

            # ------------------------------------------------------------------
            # 2. Director (0.6)
            # ------------------------------------------------------------------
            director_score = 0.0
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"Agent's answer:\n{answer_text}",
                actions_summary="",
                rubric=DIRECTOR_RUBRIC,
            )
            director_score = result.score if result else 0.0
            total += 0.6 * director_score

            print(
                f"[grader] {task.task_id}: title={title_score:.2f} "
                f"director={director_score:.2f} -> completion={total:.3f}"
            )

        scores.completion = round(min(total, 1.0), 3)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
