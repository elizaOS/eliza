"""M026_video_story_interactive_webpage grader — 田忌赛马 story + interactive webpage."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoStoryInteractiveWebpageGrader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Grade 田忌赛马 educational webpage: content (0.3) + visual (0.7).

    Phase 1 — text judge on conversation for story accuracy and characters.
    Phase 2 — visual judge on Playwright screenshots for design quality.
    """

    CONTENT_RUBRIC = """\
Ground Truth: The story is 田忌赛马 (Tian Ji's Horse Racing). Main characters: 齐威王, 田忌, 孙膑.

Scoring (total 1.0, will be weighted 0.3 in final):

1. Story accuracy (0.5):
   - Must accurately convey the core logic: inferior horses vs superior horses, \
rearranging the order of matchups, ultimately winning by losing one and winning two.
   - No fabricated plots.

2. Character identification (0.5):
   - Must correctly identify all 3 characters: 齐威王, 田忌, 孙膑.
   - Must include character avatars/visual representation on the page.
   - Missing characters or no avatars = proportional deduction.

Score 0.0-1.0."""

    VISUAL_RUBRIC = """\
Evaluate this educational webpage about the 田忌赛马 (Tian Ji's Horse Racing) story:

1. Story presentation with character avatars (0.2):
   - Characters (齐威王, 田忌, 孙膑) shown with avatar images/icons.
   - Story flow is clear and follows the narrative.

2. Interactive game (0.3):
   - Contains a truly interactive mini-game (not just static text/images).
   - Game has click/drag interaction, start button, game logic.
   - Game relates to the horse racing strategy theme.

3. Child-friendly design (0.25):
   - Language is lively and fun, appropriate for children.
   - No obscure classical Chinese or dry encyclopedia style.

4. UI/UX layout and color (0.25):
   - Layout is well-organized: text, avatars, game area clearly separated.
   - Colors are bright, harmonious, and cheerful.
   - No overlapping elements, good readability.

Score 0.0-1.0 based on weighted criteria."""

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

        content_score = 0.0
        visual_score = 0.0

        # Phase 1: Content accuracy via text judge
        all_text = self._get_all_assistant_text(messages)
        if judge and all_text.strip():
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=all_text,
                actions_summary="",
                rubric=self.CONTENT_RUBRIC,
            )
            content_score = result.score if result else 0.0

        # Phase 2: Visual quality via screenshot judge
        screenshots = self.collect_screenshots_from_snapshot(env_snapshot)
        if judge and screenshots:
            vis_result = self.judge_visual_similarity(
                judge,
                ref_images_b64=[],
                gen_images_b64=screenshots[:3],
                rubric=self.VISUAL_RUBRIC,
                context="Screenshots of an educational webpage about the 田忌赛马 story for children.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.3 * content_score + 0.7 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
