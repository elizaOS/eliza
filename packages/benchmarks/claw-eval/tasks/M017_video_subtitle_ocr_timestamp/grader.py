"""M017_video_subtitle_ocr_timestamp grader — Chinese subtitle OCR with timestamps."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoSubtitleOcrTimestampGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade subtitle OCR with timestamps from first 30s of video.

    Reads /workspace/subtitles.jsonl from env_snapshot and scores via LLM judge
    using IoU-based timestamp matching.
    """

    OUTPUT_FILE = "/workspace/subtitles.jsonl"

    RUBRIC = """\
Ground Truth (22 subtitle entries):
{"start": 0.7, "end": 1.2, "text": "朋友们"}
{"start": 1.2, "end": 2.1, "text": "不知道你有没有意识到"}
{"start": 2.1, "end": 3.8, "text": "美元今年是跌惨了"}
{"start": 5.1, "end": 6.6, "text": "上半年是近半个世纪"}
{"start": 6.6, "end": 7.8, "text": "表现最差的一年"}
{"start": 7.8, "end": 8.5, "text": "从年初到现在"}
{"start": 8.5, "end": 10.5, "text": "美元指数已经下跌了超过10%"}
{"start": 10.5, "end": 11.7, "text": "你别觉得10%没多少啊"}
{"start": 11.7, "end": 12.6, "text": "这可是美元"}
{"start": 12.6, "end": 13.5, "text": "不是什么比特币"}
{"start": 13.5, "end": 15.0, "text": "这是全球资产的标尺"}
{"start": 15.0, "end": 17.5, "text": "这个尺子半年里头缩短了10%"}
{"start": 17.5, "end": 19.3, "text": "约等于所有人都长高了10%"}
{"start": 19.3, "end": 20.0, "text": "与此同时"}
{"start": 20.0, "end": 22.3, "text": "全球的资产价格都出现了久违的爆发"}
{"start": 22.3, "end": 23.4, "text": "最猛的就是黄金"}
{"start": 23.4, "end": 24.2, "text": "你就看这张图"}
{"start": 24.2, "end": 25.8, "text": "这是过去半个世纪黄金的走势"}
{"start": 25.8, "end": 27.4, "text": "我只能用疯狂来形容"}
{"start": 27.4, "end": 28.7, "text": "比特币也是创出了新高"}
{"start": 28.7, "end": 29.1, "text": "也疯狂"}
{"start": 29.1, "end": 30.7, "text": "不过它可能一直都挺疯狂"}

Scoring rules:
The task starts with a base score of 1.0 based on the 22 ground truth entries.
A line is marked Correct only if:
  1. The text matches the GT (ignoring punctuation), AND
  2. The time interval achieves an IoU > 0.5 with the GT interval.
     IoU = intersection / union of the two time intervals.

For each missing, hallucinated, or incorrect entry, deduct 0.1 points (minimum 0.0).

Evaluate the JSONL output against the ground truth using these criteria.
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
