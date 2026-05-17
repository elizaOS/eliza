"""M029_video_surveillance_clip grader — intrusion clip extraction scored by temporal IoU.

Ground-truth on-screen timestamps: 2018-10-16 16:40:26 – 2018-10-16 16:40:41 (15 s).

The agent is NOT told about timestamps; it must find the clip visually.
The grader decodes the extracted clip, samples frames at 4 fps (always including
first and last frame), reads the on-screen timestamp watermark via visual judge,
then computes IoU.
"""

from __future__ import annotations

import base64
import re
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage

# ── ground-truth ─────────────────────────────────────────────────────────────
GT_START   = datetime(2018, 10, 16, 16, 40, 26)
GT_END     = datetime(2018, 10, 16, 16, 40, 41)
GT_START_S = GT_START.timestamp()
GT_END_S   = GT_END.timestamp()
GT_DURATION = GT_END_S - GT_START_S  # 15 s

_TS_RE  = re.compile(r"(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})")
_TS_FMT = "%Y-%m-%d %H:%M:%S"

CLIP_FILE = "/workspace/clip.mp4"

VISUAL_RUBRIC = """\
You are looking at frames sampled from a surveillance video clip.
Each frame has an on-screen timestamp watermark at the **top center** \
(format: YYYY-MM-DD HH:MM:SS).

Read the timestamps visible across all frames provided.
List every distinct timestamp you can read, one per line, in the format:
YYYY-MM-DD HH:MM:SS

If you cannot read any timestamp, respond with: UNKNOWN"""


def _parse_ts(text: str) -> datetime | None:
    m = _TS_RE.search(text)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), _TS_FMT)
    except ValueError:
        return None


def _iou(pred_start: float, pred_end: float,
         gt_start: float, gt_end: float) -> float:
    inter = max(0.0, min(pred_end, gt_end) - max(pred_start, gt_start))
    union = (pred_end - pred_start) + (gt_end - gt_start) - inter
    return inter / union if union > 0 else 0.0


def _extract_frames_b64(video_path: Path, fps: float = 4.0) -> list[str]:
    """Sample frames at `fps` rate from a video (always including first and last frame).

    Returns base64-encoded JPEG strings.
    """
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(video_path)],
        capture_output=True, text=True,
    )
    try:
        duration = float(result.stdout.strip())
    except ValueError:
        duration = 0.0

    interval = 1.0 / fps
    timestamps: list[float] = []
    t = 0.0
    while t < duration:
        timestamps.append(t)
        t += interval
    if not timestamps or timestamps[-1] < duration:
        timestamps.append(duration)
    seen: set[float] = set()
    timestamps = [t for t in timestamps if not (t in seen or seen.add(t))]  # type: ignore[func-returns-value]

    frames_b64 = []
    for ts in timestamps:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp_path = tmp.name
        subprocess.run(
            ["ffmpeg", "-y", "-ss", str(ts), "-i", str(video_path),
             "-vframes", "1", "-q:v", "3", tmp_path],
            capture_output=True,
        )
        p = Path(tmp_path)
        if p.exists() and p.stat().st_size > 0:
            frames_b64.append(base64.b64encode(p.read_bytes()).decode())
            p.unlink(missing_ok=True)

    return frames_b64


class VideoSurveillanceClipGrader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Grade extracted clip by temporal IoU against ground-truth on-screen timestamps.

    - clip exists:      0.1
    - temporal IoU × 0.9: sample frames from the clip, read bottom-left timestamp
      watermarks via visual judge, compute IoU with GT 16:40:26–16:40:41.
    """

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

        # --- clip exists? ---
        if not self.check_file_exists(env_snapshot, CLIP_FILE):
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            scores.efficiency_turns = len(
                [m for m in messages if m.message.role == "assistant"]
            )
            return scores

        existence_score = 0.1
        iou_score = 0.0

        # --- decode clip to temp file, sample frames, read timestamps ---
        clip_entry = (env_snapshot or {}).get(f"file:{CLIP_FILE}", {})
        clip_b64 = (
            clip_entry.get("content", "")
            if clip_entry.get("encoding") == "base64"
            else ""
        )

        if clip_b64 and judge and hasattr(judge, "evaluate_visual"):
            with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
                tmp_path = Path(tmp.name)
                tmp_path.write_bytes(base64.b64decode(clip_b64))

            try:
                frames_b64 = _extract_frames_b64(tmp_path, fps=4.0)
            finally:
                tmp_path.unlink(missing_ok=True)

            if frames_b64:
                result = judge.evaluate_visual(
                    rubric=VISUAL_RUBRIC,
                    reference_images_b64=[],
                    candidate_images_b64=frames_b64,
                    context=(
                        "These frames are sampled from the surveillance clip the agent extracted. "
                        "Read the on-screen timestamp at the top center of each frame."
                    ),
                )
                if result and result.reasoning:
                    tss = [_parse_ts(line) for line in result.reasoning.splitlines()]
                    tss = [t for t in tss if t is not None]
                    if len(tss) >= 2:
                        pred_start = min(t.timestamp() for t in tss)
                        pred_end   = max(t.timestamp() for t in tss)
                        iou_score  = _iou(pred_start, pred_end, GT_START_S, GT_END_S)
                    elif len(tss) == 1:
                        t = tss[0].timestamp()
                        iou_score = _iou(t, t + GT_DURATION, GT_START_S, GT_END_S)

        scores.completion = round(existence_score + 0.9 * iou_score, 3)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
