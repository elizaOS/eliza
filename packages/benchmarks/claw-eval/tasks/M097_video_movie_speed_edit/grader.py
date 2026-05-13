"""Grader for M097_video_movie_speed_edit - Movie Clip Speed-Up Editing.

Scoring breakdown (total = 1.0):
  - 0.10: chase_2x.mp4 file exists
  - 0.40: timestamp IoU against ground truth [16, 23]
  - 0.25: ffprobe duration in valid range (2-5 seconds for 7s clip at 2x)
  - 0.25: LLM judge evaluates content quality (sped-up chase scene)
"""

from __future__ import annotations

import json
import re
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


# Ground truth chase segment boundaries (seconds)
GT_START = 16
GT_END = 23

CONTENT_RUBRIC = """\
评估 /workspace/chase_2x.mp4 的内容质量。

任务要求：从原始视频中提取两个男孩追逐奔跑的片段，并制作成 2 倍速版本。

Ground Truth：
- 追逐片段位于原视频约 00:16 - 00:23（约 7 秒）
- 内容：两个男孩从吊脚楼下跑出来后互相追逐
- 2 倍速后时长约 3-4 秒

请评估：
1. 视频内容是否确实包含追逐场景
2. 视频是否明显经过加速处理（动作比正常速度快）

评分：如果内容和加速都正确给 1.0，只有部分正确给 0.5，完全不对给 0.0。
"""


def _parse_timestamp_range(text: str) -> tuple[float, float] | None:
    """Parse a timestamp range from text like '16 - 23' or '00:16 - 00:23'."""
    text = text.strip()

    # Try MM:SS - MM:SS format
    match = re.search(r"(\d{1,2}):(\d{2})\s*[-~]\s*(\d{1,2}):(\d{2})", text)
    if match:
        start = int(match.group(1)) * 60 + int(match.group(2))
        end = int(match.group(3)) * 60 + int(match.group(4))
        return (float(start), float(end))

    # Try plain seconds: "16 - 23" or "16-23" or "16 to 23"
    match = re.search(r"(\d+(?:\.\d+)?)\s*[-~to]+\s*(\d+(?:\.\d+)?)", text)
    if match:
        return (float(match.group(1)), float(match.group(2)))

    return None


def _compute_iou(start1: float, end1: float, start2: float, end2: float) -> float:
    """Compute Intersection over Union for two time intervals."""
    inter_start = max(start1, start2)
    inter_end = min(end1, end2)
    intersection = max(0.0, inter_end - inter_start)

    union = max(end1, end2) - min(start1, start2)
    if union <= 0:
        return 0.0
    return intersection / union


def _get_duration_from_ffprobe(env_snapshot: dict | None) -> float | None:
    """Extract duration from ffprobe JSON output in env_snapshot."""
    cmd_key = "cmd:ffprobe -v quiet -print_format json -show_format -show_streams /workspace/chase_2x.mp4"
    raw = (env_snapshot or {}).get(cmd_key, {}).get("stdout", "")
    if not raw:
        return None

    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None

    # Try format.duration first
    fmt = data.get("format", {})
    if "duration" in fmt:
        try:
            return float(fmt["duration"])
        except (ValueError, TypeError):
            pass

    # Fall back to first video stream duration
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video" and "duration" in stream:
            try:
                return float(stream["duration"])
            except (ValueError, TypeError):
                pass

    return None


class Grader(AbstractGrader, MultimodalGraderMixin):
    """Movie clip speed-up editing grader."""

    OUTPUT_FILE = "/workspace/chase_2x.mp4"
    TIMESTAMP_FILE = "/workspace/timestamp.txt"

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

        total_score = 0.0

        # ---- Component 1: File exists (0.10) ----
        file_exists = self.check_file_exists(env_snapshot, self.OUTPUT_FILE)
        if file_exists:
            total_score += 0.10

        # ---- Component 2: Timestamp IoU (0.40) ----
        ts_entry = (env_snapshot or {}).get(f"file:{self.TIMESTAMP_FILE}", {})
        ts_content = ""
        if ts_entry.get("encoding") != "base64":
            ts_content = ts_entry.get("content", "").strip()

        timestamp_score = 0.0
        if ts_content:
            parsed = _parse_timestamp_range(ts_content)
            if parsed:
                pred_start, pred_end = parsed
                iou = _compute_iou(pred_start, pred_end, GT_START, GT_END)
                # IoU >= 0.7 gets full credit, otherwise proportional
                if iou >= 0.7:
                    timestamp_score = 1.0
                else:
                    timestamp_score = iou / 0.7
        total_score += 0.40 * timestamp_score

        # ---- Component 3: Duration check via ffprobe (0.25) ----
        duration = _get_duration_from_ffprobe(env_snapshot)
        duration_score = 0.0
        if duration is not None:
            # Expected: ~3.5s (half of 7s). Valid range: 2-5s.
            if 2.0 <= duration <= 5.0:
                duration_score = 1.0
            elif 1.0 <= duration < 2.0 or 5.0 < duration <= 8.0:
                # Partial credit for close but out of ideal range
                duration_score = 0.5
            else:
                duration_score = 0.0
        total_score += 0.25 * duration_score

        # ---- Component 4: Content quality via LLM judge (0.25) ----
        content_score = 0.0
        if file_exists and judge:
            conversation = self.format_conversation(messages)
            ffprobe_info = ""
            if duration is not None:
                ffprobe_info = f"\nffprobe shows output duration: {duration:.1f} seconds"

            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=conversation + ffprobe_info,
                actions_summary=self.summarize_actions(audit_data),
                rubric=CONTENT_RUBRIC,
            )
            content_score = result.score if result else 0.0
        total_score += 0.25 * content_score

        scores.completion = round(total_score, 4)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
