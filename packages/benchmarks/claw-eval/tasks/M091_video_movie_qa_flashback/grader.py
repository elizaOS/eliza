"""Grader for M091_video_movie_qa_flashback: Movie Scene QA - Character Embarrassing History.

Task: List all embarrassing flashback scenes of Wang Duoyu shown in the video.

GT: 4 flashback scenes (0.25 each):
  1. Soccer biting: yellow jersey, red-white headband, biting blue-jersey player's leg
  2. Women's football: pink jersey, playing goalkeeper
  3. Human sushi platter: lying on table as a human food plate for Japanese cuisine
  4. Nude model: lying naked on bed, art students sketching him

Scoring (total = 1.0): 0.25 per correctly identified scene.
"""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


ANSWER_FILE = "/workspace/answer.txt"

QA_RUBRIC = """\
You are evaluating whether the agent correctly identified the embarrassing \
flashback scenes of Wang Duoyu (王多鱼) from a movie clip.

GROUND TRUTH: There are 4 flashback scenes shown in the video:

1. Soccer/football biting incident (足球咬人):
   Wang Duoyu wears a yellow jersey and red-white headband, lying on the ground \
biting a blue-jersey opponent's leg/calf. He was banned for 2 years for this.

2. Women's football goalkeeper (踢女足):
   Wang Duoyu wears a pink jersey, playing as goalkeeper on a women's football team.

3. Human sushi platter (做日料/人体餐盘):
   Wang Duoyu lies on a table serving as a human food platter for Japanese cuisine.

4. Nude art model (人体模特):
   Wang Duoyu lies naked on a bed/platform in an art class while students sketch him.

SCORING (return a single score 0.0 to 1.0):
Award 0.25 for each correctly identified scene. A scene counts as "identified" \
if the agent describes the core visual content correctly — exact wording is not \
required, but the key elements must be recognizable:
- Scene 1: soccer/football + biting/dirty play
- Scene 2: women's football / pink jersey goalkeeper
- Scene 3: lying on table as food platter / human sushi
- Scene 4: nude model / art class / students drawing

If a scene is vaguely mentioned without sufficient detail, award 0.125 for that scene.

Sum all parts. Examples: 4/4 correct = 1.0, 3/4 = 0.75, 2/4 = 0.5, 1/4 = 0.25."""


class Grader(AbstractGrader, MultimodalGraderMixin):
    """Embarrassing flashback scenes QA grader: 0.25 per scene."""

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

        # Read answer.txt, fall back to conversation
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
