"""M016_video_subtitle_ocr_chinese_filter grader — Chinese sentence filter from video."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoSubtitleOcrChineseFilterGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade Chinese subtitle filtering — sentences containing '黄金'.

    Reads /workspace/output.txt from env_snapshot and scores via LLM judge.
    """

    OUTPUT_FILE = "/workspace/output.txt"

    RUBRIC = """\
Ground Truth sentences (10 items):
1. 看历史上黄金和白银的价格走势
2. 大概是黄金的两倍左右
3. 它上涨是黄金的两倍
4. 下跌是黄金的两倍
5. 白银是比黄金要大一个数量级的
6. 白银是要比黄金小一个数量级
7. 黄金就像是一艘航母
8. 黄金市场显然太大了
9. 很多人感觉黄金是不是太贵了呀
10. 白银肯定比黄金更刺激

Start with a base score of 1.0. Apply the following deductions (minimum score 0.0):
- -0.1 pts for each sentence in the Ground Truth that is missing from the output.
- -0.1 pts for each extra sentence included in the output that is NOT in the Ground Truth.

Evaluate the output text against the ground truth using the criteria above.
Output a score between 0.0 and 1.0."""

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

        if not self.check_file_exists(env_snapshot, self.OUTPUT_FILE):
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        content = (env_snapshot or {}).get(
            f"file:{self.OUTPUT_FILE}", {}
        ).get("content", "")

        if judge and content.strip():
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"Contents of {self.OUTPUT_FILE}:\n{content}",
                actions_summary="",
                rubric=self.RUBRIC,
            )
            scores.completion = result.score if result else 0.0

        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
