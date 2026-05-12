"""Grader for M094_video_movie_band_extraction: Movie Band Clip Extraction and Editing.

Task: Extract band-related clips from video, save timestamps, concatenate into
a single band-only video.

GT segments: 00:00-00:09, 00:14-00:19, 00:28-00:35 (3 segments)

Scoring (total = 1.0):
  - 0.6: Timestamp accuracy (IoU of predicted segments vs GT segments)
  - 0.2: band_cut.mp4 file exists
  - 0.2: Video content check (LLM judge verifies band content)
"""

from __future__ import annotations

import json
import re
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


TIMESTAMPS_FILE = "/workspace/timestamps.txt"
VIDEO_FILE = "/workspace/band_cut.mp4"
FFPROBE_CMD = "ffprobe -v quiet -print_format json -show_format -show_streams /workspace/band_cut.mp4"

# Ground truth segments in seconds
GT_SEGMENTS = [
    (0, 9),
    (14, 19),
    (28, 35),
]

TIMESTAMP_RUBRIC = """\
You are evaluating a video clip extraction task where the agent identified \
band-related segments from a video.

GROUND TRUTH: There are 3 band-related segments in the original video:
  1. 00:00 - 00:09 (0s to 9s)
  2. 00:14 - 00:19 (14s to 19s)
  3. 00:28 - 00:35 (28s to 35s)

The agent's timestamps.txt content is provided below. Parse all segment \
time ranges from it.

For each GT segment, find the best matching predicted segment and compute \
temporal IoU:
  IoU = intersection / union

Compute the average IoU across all 3 GT segments. If a GT segment has no \
matching prediction, its IoU = 0.

Also consider: did the agent find approximately the right number of segments \
(3)? Finding 2-4 segments is acceptable; finding 1 or 5+ is penalized.

Final score = average IoU across GT segments, with a penalty factor:
- 2-4 predicted segments: no penalty
- 1 or 5+ predicted segments: multiply by 0.5

Return a score from 0.0 to 1.0."""

CONTENT_RUBRIC = """\
You are evaluating a video editing task. The agent was asked to extract and \
concatenate all band-related segments from a movie clip.

The expected output is a video containing only band introduction and performance \
scenes (approximately 21 seconds total: 9s + 5s + 7s from 3 segments).

Below is the ffprobe metadata of the output video and the agent's conversation.

Check:
1. Is the video duration roughly 15-30 seconds? (the 3 GT segments total ~21s)
2. Based on the agent's approach, did they extract and concatenate multiple \
segments (not just one continuous segment)?

Scoring:
- 1.0: Duration is reasonable (~15-30s) and approach involved multi-segment extraction
- 0.5: Duration is somewhat off or only partial segments were extracted
- 0.0: Video is clearly wrong (very short, very long, or single unrelated segment)"""


class Grader(AbstractGrader, MultimodalGraderMixin):
    """Band clip extraction grader: timestamps IoU + file exists + content check."""

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
        # 1. Timestamp accuracy (0.6) — from timestamps.txt
        # ------------------------------------------------------------------
        ts_score = 0.0
        ts_entry = snapshot.get(f"file:{TIMESTAMPS_FILE}", {})
        ts_content = (
            ts_entry.get("content", "").strip()
            if ts_entry.get("encoding") != "base64"
            else ""
        )

        if ts_content and judge:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"Agent's timestamps.txt content:\n{ts_content}",
                actions_summary="",
                rubric=TIMESTAMP_RUBRIC,
            )
            ts_score = result.score if result else 0.0

        total += 0.6 * ts_score

        # ------------------------------------------------------------------
        # 2. Video file existence (0.2)
        # ------------------------------------------------------------------
        file_ok = self.check_file_exists(snapshot, VIDEO_FILE)
        if file_ok:
            total += 0.2

        # ------------------------------------------------------------------
        # 3. Video content check (0.2)
        # ------------------------------------------------------------------
        content_score = 0.0
        if file_ok and judge:
            ffprobe_raw = self.get_snapshot_stdout(snapshot, FFPROBE_CMD)
            conversation = self.format_conversation(messages)
            context = (
                f"FFprobe metadata of output video:\n{ffprobe_raw}\n\n"
                f"Agent conversation:\n{conversation}"
            )
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=context,
                actions_summary="",
                rubric=CONTENT_RUBRIC,
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
            f"[grader] {task.task_id}: ts={ts_score:.2f} "
            f"file_ok={file_ok} content={content_score:.2f} "
            f"-> completion={scores.completion}"
        )
        return scores
