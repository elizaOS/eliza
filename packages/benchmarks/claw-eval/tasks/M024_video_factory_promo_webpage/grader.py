"""M024_video_factory_promo_webpage grader — factory video QA + HTML promo page."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoFactoryPromoWebpageGrader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Grade factory promo task: 5 QA items (0.5) + HTML visual quality (0.5).

    Phase 1 — text judge on conversation for 5 QA answers.
    Phase 2 — visual judge on Playwright screenshots of output.html.
    """

    QA_RUBRIC = """\
Ground Truth (5 questions, each worth 0.1, total 0.5 mapped to 1.0 in judge):

1. Product (0.2): 复合耐磨钢板 (composite wear-resistant steel plate).
2. Core Technology (0.2): 明弧自保护全自动堆焊技术 (open-arc self-shielded fully automatic surfacing welding).
3. Performance (0.2): 优良的抗疲劳性能、抗冲击性能和耐腐蚀性能 (fatigue resistance, impact resistance, corrosion resistance).
4. Production Data (0.2): 字幕中完全没有出现任何关于产能、产量或生产速度的数据 (no production capacity data in subtitles).
5. Subtitles (0.2): 视频包含字幕 (video contains subtitles).

Score each item 0.2 if correct, 0 if wrong. Sum all items for final score 0.0-1.0."""

    VISUAL_RUBRIC = """\
Evaluate this factory promotional webpage:
- Is the HTML generated and does it render properly? (0.2)
- Industrial + modern style (dark/metallic tones, clean layout)? (0.2)
- Content detailed and rich (product info, technology, performance)? (0.2)
- Content matches the video subtitles accurately, no fabrication? (0.2)
- Color harmony, layout aesthetics, overall visual appeal? (0.2)

Score 0.0-1.0 based on weighted sum of criteria."""

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

        qa_score = 0.0
        visual_score = 0.0

        # Phase 1: QA accuracy via text judge
        all_text = self._get_all_assistant_text(messages)
        if judge and all_text.strip():
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=all_text,
                actions_summary="",
                rubric=self.QA_RUBRIC,
            )
            qa_score = result.score if result else 0.0

        # Phase 2: Visual quality via screenshot judge
        screenshots = self.collect_screenshots_from_snapshot(env_snapshot)
        if judge and screenshots:
            vis_result = self.judge_visual_similarity(
                judge,
                ref_images_b64=[],
                gen_images_b64=screenshots[:3],
                rubric=self.VISUAL_RUBRIC,
                context="Screenshots of a factory promotional HTML page generated from video content.",
            )
            visual_score = vis_result.score if vis_result else 0.0

        scores.completion = round(0.5 * qa_score + 0.5 * visual_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
