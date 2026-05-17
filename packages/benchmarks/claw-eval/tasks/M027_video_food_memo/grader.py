"""M027_video_food_memo grader — Henan food video markdown memo."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoFoodMemoGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade Henan food memo: markdown(0.2) + food1(0.4) + food2(0.4)."""

    RUBRIC = """\
Ground Truth (2 foods from the video):

1. 百年白记 花生糕 (Peanut Cake):
   - Craftsman: 第三代传承人白凤奇 (3rd generation, Bai Fengqi)
   - Method: 熬糖, 拌料, 层层叠压, 擀平, 横撕竖拉, 最后成型 \
(boil sugar, mix ingredients, layer and press, roll flat, tear horizontally \
and vertically, final shaping)
   - Taste: 酥香绵甜, 入口即化 (crispy, fragrant, soft-sweet, melts in mouth)

2. 齐氏大刀面 (Qi's Big Knife Noodles):
   - Craftsman: 第八代传承人齐同库 (8th generation, Qi Tongku)
   - Method: 大铡刀切面, 入锅3秒就熟 (cut with big chopper, cooked in 3 seconds)
   - Taste: 清香松软, 光滑利口, 劲道 (fragrant, soft, smooth, chewy)

Scoring:
- Markdown format (0.2): Output uses proper markdown formatting (headers, lists, etc.).
- Food 1 (0.4): Name (0.1) + Craftsman name and generation (0.1) + Method (0.1) + Taste (0.1).
- Food 2 (0.4): Name (0.1) + Craftsman name and generation (0.1) + Method (0.1) + Taste (0.1).

For method and taste, partial credit is allowed (not all-or-nothing).
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
