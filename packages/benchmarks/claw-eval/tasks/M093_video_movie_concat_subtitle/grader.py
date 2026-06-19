"""Grader for M093_video_movie_concat_subtitle: Movie Video Concatenation with Subtitle Overlay.

Scoring (total = 1.0):
  - 0.3: Output file /workspace/merged.mp4 exists and is a valid video
  - 0.2: Concatenation content — video1 before video2, duration ~120-125s
  - 0.5: Subtitle visual — "夏洛特烦恼 - 婚礼到场" visible at bottom center in white
"""

from __future__ import annotations

import json
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


FFPROBE_CMD = "ffprobe -v quiet -print_format json -show_format -show_streams /workspace/merged.mp4"

CONCAT_CONTENT_RUBRIC = """\
You are evaluating a video concatenation task.

TASK: The agent was asked to concatenate two video clips (video1.mp4 ~60s, \
video2.mp4 ~63s) into one merged video, with video1 appearing first.

Below is the ffprobe metadata of the merged video and the agent's conversation.

Check:
1. Is the total duration approximately 120-125 seconds (60 + 63)?
2. Based on the agent's approach (visible in conversation), was video1 placed \
before video2 in the concatenation?

Scoring:
- 1.0: Duration is in 115-130s range and video1 is before video2
- 0.5: Duration is roughly correct but order cannot be confirmed, or duration \
is somewhat off (100-115s or 130-145s)
- 0.0: Duration is clearly wrong (<80s or >160s) or videos are in wrong order"""

SUBTITLE_VISUAL_RUBRIC = """\
Examine these video frames sampled from a merged movie clip.
The task required adding a white subtitle text "夏洛特烦恼 - 婚礼到场" at the \
bottom center of the video.

Evaluate:
1. Is there visible subtitle/overlay text at the bottom of any frame?
2. Does the subtitle text read "夏洛特烦恼 - 婚礼到场" or something very close?
3. Is the text white and horizontally centered at the bottom?

Scoring:
- 1.0: Subtitle is clearly visible, correctly reads the required text, and is \
positioned at bottom center in white.
- 0.7: Subtitle is visible and text is correct but position or color is slightly off.
- 0.4: Subtitle text is present but partially incorrect (wrong text, wrong \
position, or wrong color).
- 0.0: No subtitle text is visible in any frame."""


class Grader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Video concatenation + subtitle overlay grader."""

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
        # 1. File existence check (0.3)
        # ------------------------------------------------------------------
        file_ok = self.check_file_exists(snapshot, "/workspace/merged.mp4")
        if file_ok:
            total += 0.3
        else:
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            scores.efficiency_turns = len(
                [m for m in messages if m.message.role == "assistant"]
            )
            return scores

        # ------------------------------------------------------------------
        # 2. Concatenation content check (0.2) — duration + order
        # ------------------------------------------------------------------
        concat_score = 0.0
        ffprobe_raw = self.get_snapshot_stdout(snapshot, FFPROBE_CMD)
        if judge and ffprobe_raw:
            conversation = self.format_conversation(messages)
            context = (
                f"FFprobe metadata of merged video:\n{ffprobe_raw}\n\n"
                f"Agent conversation:\n{conversation}"
            )
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=context,
                actions_summary="",
                rubric=CONCAT_CONTENT_RUBRIC,
            )
            concat_score = result.score if result else 0.0

        total += 0.2 * concat_score

        # ------------------------------------------------------------------
        # 3. Subtitle visual check (0.5) — text, color, position
        # ------------------------------------------------------------------
        visual_score = 0.0
        if judge:
            frame_b64_list = []
            for frame_path in [
                "/workspace/grading_frames/frame_001.png",
                "/workspace/grading_frames/frame_002.png",
                "/workspace/grading_frames/frame_003.png",
            ]:
                entry = snapshot.get(f"file:{frame_path}", {})
                b64 = (
                    entry.get("content", "")
                    if entry.get("encoding") == "base64"
                    else ""
                )
                if b64:
                    frame_b64_list.append(b64)

            if frame_b64_list:
                result = self.judge_visual_similarity(
                    judge,
                    ref_images_b64=[],
                    gen_images_b64=frame_b64_list,
                    rubric=SUBTITLE_VISUAL_RUBRIC,
                    context="Sampled frames from a concatenated movie video that should have subtitle overlay.",
                )
                if result:
                    visual_score = result.score

        total += 0.5 * visual_score

        # ------------------------------------------------------------------
        # Final
        # ------------------------------------------------------------------
        scores.completion = round(min(total, 1.0), 3)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )

        print(
            f"[grader] {task.task_id}: file_ok={file_ok} "
            f"concat={concat_score:.2f} subtitle={visual_score:.2f} "
            f"-> completion={scores.completion}"
        )
        return scores
