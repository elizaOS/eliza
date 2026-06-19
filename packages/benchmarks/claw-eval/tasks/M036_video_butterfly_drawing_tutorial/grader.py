"""M036_video_butterfly_drawing_tutorial grader — butterfly drawing tutorial notes.

Scoring: LLM judge evaluates 4 dimensions:
  - Material list accuracy (0.10)
  - Stage identification accuracy (0.40)
  - Per-step image quality (0.40)
  - Overall tutorial quality (0.10)
"""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoButterflyDrawingTutorialGrader(AbstractGrader, MultimodalGraderMixin):
    """Butterfly drawing tutorial grader using LLM judge."""

    RUBRIC = """\
评分标准（总计1.0分）：

维度一：材料清单准确度（总计 0.10 分）
对照参考答案计算召回率。请逐一判断以下几种必备材料是否被模型提及（同义词/相同功能的物品可接受）：
① 素描本/画纸（Sketchbook / Drawing Paper）
② 铅笔（Pencil）— 用于起稿
③ 黑色细线笔/勾线笔（Black Fine-tip Pen / Ink Pen / Marker for outlining）
④ 红色/橙色马克笔或彩色笔（Red/Orange Marker / Colored Pen）— 用于蝴蝶翅膀上色
得分 = 召回率 × 0.10

维度二：划分阶段的准确性识别（总计 0.40 分）
对照GT逐项判断每个阶段的顺序和内容是否正确：
参考GT阶段共4个步骤。如果模型输出大于四个阶段，自动映射到这四个阶段上去再做判断。
每个阶段判断内容是否正确（是/否）。
得分 = 正确阶段数/4 × 0.40

维度三：每个步骤的图片质量（总计 0.40 分）
一共四个阶段，逐个阶段判断：
1）这个阶段是否有配图？（0.05）
2）图片是否来自于原始视频？图片是否和这个阶段的文字一致？（0.05）
每个阶段一共0.1分。
得分=每个阶段的分数累加

维度四：教程笔记整体质量（总计 0.10 分）
判断输出的教程整体清晰度、美观性、是否适合给初学者看。
是=0.1分，否=0分"""

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

        final_text = self._get_all_assistant_text(messages)

        if judge:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=self.format_conversation(messages),
                actions_summary=self.summarize_actions(audit_data),
                rubric=self.RUBRIC,
            )
            scores.completion = result.score
        else:
            scores.completion = 0.0

        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
