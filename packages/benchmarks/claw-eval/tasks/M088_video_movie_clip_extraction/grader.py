"""Grader for M088_video_movie_clip_extraction: Movie Clip Extraction - Car Circling Garden.

Scoring (total = 1.0):
  - 0.6: Timestamp IoU — agent's reported time range vs GT [00:16, 00:57]
  - 0.2: File existence — clip.mp4 exists and is a valid video
  - 0.2: Clip content — visual/duration check that clip matches the timestamp
"""

from __future__ import annotations

import json
import re
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


CLIP_PATH = "/workspace/clip.mp4"
TIMESTAMP_PATH = "/workspace/timestamp.txt"
FFPROBE_CMD = "ffprobe -v quiet -print_format json -show_format -show_streams /workspace/clip.mp4"

# Ground truth interval in seconds
GT_START = 16.0
GT_END = 57.0

TIMESTAMP_IOU_RUBRIC = """\
You are evaluating a video clip extraction task.

TASK: The agent was asked to find the segment where a white Maserati circles \
around a garden after entering a gate, from the start of circling to the car \
stopping, and report the time range.

GROUND TRUTH interval: 00:16 - 00:57 (i.e., 16 seconds to 57 seconds in the \
original video, duration = 41 seconds).

Below is the content of the agent's timestamp.txt file. Parse the agent's \
reported start and end times (in seconds).

If timestamp.txt is empty or cannot be parsed, score = 0.0.

Otherwise, compute Temporal IoU:
  Let agent interval = [agent_start, agent_end]
  Let GT interval = [16, 57]
  intersection = max(0, min(agent_end, 57) - max(agent_start, 16))
  union = max(agent_end, 57) - min(agent_start, 16)
  IoU = intersection / union

Return the IoU as the score (0.0 to 1.0)."""

CLIP_CONTENT_RUBRIC = """\
You are evaluating whether a video clip was correctly extracted.

TASK: The agent was asked to extract a clip of a white Maserati circling a \
garden (GT: 00:16 - 00:57, duration ~41 seconds).

Below is the ffprobe metadata of the extracted clip and the agent's conversation.

Check:
1. Does the clip duration roughly match the expected duration (~41s)? \
A duration between 30s and 50s is acceptable.
2. Based on the agent's ffmpeg command (visible in conversation), does the \
clip cover approximately the right time range?

Scoring:
- 1.0: Duration is close to 41s and extraction range is reasonable
- 0.5: Duration is off but extraction range overlaps significantly with GT
- 0.0: Clip is clearly wrong (very short, very long, or wrong segment)"""


class Grader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Clip extraction grader: timestamp IoU + file existence + content check."""

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

        # ------------------------------------------------------------------
        # 1. Timestamp IoU (0.6) — from /workspace/timestamp.txt
        # ------------------------------------------------------------------
        ts_score = 0.0
        ts_entry = snapshot.get(f"file:{TIMESTAMP_PATH}", {})
        ts_content = (
            ts_entry.get("content", "").strip()
            if ts_entry.get("encoding") != "base64"
            else ""
        )

        if ts_content and judge:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"Agent's timestamp.txt content:\n{ts_content}",
                actions_summary="",
                rubric=TIMESTAMP_IOU_RUBRIC,
            )
            ts_score = result.score if result else 0.0

        total += 0.6 * ts_score

        # ------------------------------------------------------------------
        # 2. File existence (0.2) — clip.mp4 exists and is valid video
        # ------------------------------------------------------------------
        file_ok = self.check_file_exists(snapshot, CLIP_PATH)
        if file_ok:
            total += 0.2

        # ------------------------------------------------------------------
        # 3. Clip content check (0.2) — duration & content verification
        # ------------------------------------------------------------------
        content_score = 0.0
        if file_ok and judge:
            ffprobe_stdout = self.get_snapshot_stdout(snapshot, FFPROBE_CMD)
            conversation = self.format_conversation(messages)
            context = (
                f"FFprobe metadata of extracted clip:\n{ffprobe_stdout}\n\n"
                f"Agent conversation (to find extraction timestamps):\n{conversation}"
            )
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=context,
                actions_summary="",
                rubric=CLIP_CONTENT_RUBRIC,
            )
            content_score = result.score if result else 0.0

        total += 0.2 * content_score

        # ------------------------------------------------------------------
        # Final
        # ------------------------------------------------------------------
        scores.completion = round(min(total, 1.0), 3)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )

        print(
            f"[grader] {task.task_id}: ts_iou={ts_score:.2f} "
            f"file_exists={file_ok} content={content_score:.2f} "
            f"-> completion={scores.completion}"
        )
        return scores
