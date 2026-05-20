"""Centralized evidence-capture utilities.

Every evidence script in `scripts/` needs to:
  - render frames (sim external, sim ego, real camera, or composited)
  - label them with task/time/divergence/whatever HUD info
  - write png + mp4 with consistent naming and codec choices

This module is the single place to do that, so every script writes
artifacts in the same shape and the VLM-eval pipeline can consume them
without per-script adapters.
"""

from __future__ import annotations

import base64
import io
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np


@dataclass
class HudLine:
    """One line of overlay text. Color is BGR (cv2 convention)."""

    text: str
    color: tuple[int, int, int] = (240, 240, 240)
    scale: float = 0.55
    thickness: int = 1


@dataclass
class EvidenceCapture:
    """A single evidence run — accumulates frames, writes everything at close()."""

    out_dir: Path
    name: str
    fps: float = 10.0
    fourcc: str = "mp4v"

    _writers: dict[str, Any] = field(default_factory=dict)
    _frames_by_writer: dict[str, int] = field(default_factory=dict)
    _started_at: float = field(default_factory=time.time)

    def __post_init__(self) -> None:
        self.out_dir = Path(self.out_dir)
        self.out_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Frame ingestion
    # ------------------------------------------------------------------
    def write_frame(
        self,
        track: str,
        rgb: np.ndarray,
        *,
        hud: list[HudLine] | None = None,
    ) -> None:
        """Append `rgb` (HxWx3 uint8) to the mp4 track named `track`.

        Lazily opens the cv2.VideoWriter on first write so the frame
        size is correct. `hud` is rendered as a dimmed bottom bar.
        """
        import cv2

        bgr = rgb[:, :, ::-1].copy()
        if hud:
            bgr = self._draw_hud(bgr, hud)
        writer = self._writers.get(track)
        if writer is None:
            path = self.out_dir / f"{track}.mp4"
            fourcc = cv2.VideoWriter_fourcc(*self.fourcc)
            writer = cv2.VideoWriter(
                str(path), fourcc, self.fps, (bgr.shape[1], bgr.shape[0]),
            )
            if not writer.isOpened():
                raise RuntimeError(f"could not open VideoWriter for {path}")
            self._writers[track] = writer
            self._frames_by_writer[track] = 0
        writer.write(bgr)
        self._frames_by_writer[track] += 1

    def write_png(self, name: str, rgb: np.ndarray) -> Path:
        """Save a single PNG. Returns the path."""
        import cv2

        path = self.out_dir / f"{name}.png"
        bgr = rgb[:, :, ::-1].copy()
        cv2.imwrite(str(path), bgr)
        return path

    def write_side_by_side(
        self,
        track: str,
        left_rgb: np.ndarray | None,
        right_rgb: np.ndarray | None,
        *,
        labels: tuple[str, str] = ("left", "right"),
        hud: list[HudLine] | None = None,
        target_h: int = 360,
    ) -> None:
        """Composite two frames horizontally + write to `track`. Either side
        may be None — replaced with a dark placeholder + label.
        """
        import cv2

        def _resize(rgb: np.ndarray, label: str) -> np.ndarray:
            bgr = rgb[:, :, ::-1].copy()
            scale = target_h / bgr.shape[0]
            new_w = int(bgr.shape[1] * scale)
            resized = cv2.resize(bgr, (new_w, target_h))
            cv2.putText(
                resized, label, (12, 26), cv2.FONT_HERSHEY_SIMPLEX,
                0.6, (240, 240, 240), 1,
            )
            return resized

        def _placeholder(width: int, label: str) -> np.ndarray:
            ph = np.full((target_h, max(width, 200), 3), 30, dtype=np.uint8)
            cv2.putText(
                ph, f"(no {label} frame)", (12, target_h // 2),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1,
            )
            return ph

        ll = labels[0]
        rl = labels[1]
        if left_rgb is None and right_rgb is None:
            return
        if left_rgb is None:
            right = _resize(right_rgb, rl)
            left = _placeholder(right.shape[1], ll)
        elif right_rgb is None:
            left = _resize(left_rgb, ll)
            right = _placeholder(left.shape[1], rl)
        else:
            left = _resize(left_rgb, ll)
            right = _resize(right_rgb, rl)
        combined = np.concatenate([left, right], axis=1)
        if hud:
            combined = self._draw_hud(combined, hud)
        rgb = combined[:, :, ::-1].copy()
        self.write_frame(track, rgb)

    # ------------------------------------------------------------------
    # Static utility — for VLM eval / etc.
    # ------------------------------------------------------------------
    @staticmethod
    def to_base64_png(rgb: np.ndarray) -> str:
        """Encode RGB → base64 PNG (no data URL prefix). Used by VLM eval."""
        try:
            from PIL import Image
        except ImportError as exc:
            raise RuntimeError("evidence_capture requires Pillow") from exc
        img = Image.fromarray(rgb.astype(np.uint8), mode="RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("ascii")

    @staticmethod
    def from_base64_png(b64: str) -> np.ndarray:
        """Decode base64 PNG → RGB ndarray."""
        from PIL import Image

        return np.array(
            Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB"),
            dtype=np.uint8,
        )

    # ------------------------------------------------------------------
    def close(self) -> dict[str, int]:
        """Release all writers. Returns frame counts per track."""
        counts = dict(self._frames_by_writer)
        for w in self._writers.values():
            try:
                w.release()
            except Exception:
                pass
        self._writers.clear()
        return counts

    def __enter__(self) -> "EvidenceCapture":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    # ------------------------------------------------------------------
    def _draw_hud(self, bgr: np.ndarray, hud: list[HudLine]) -> np.ndarray:
        import cv2

        if not hud:
            return bgr
        h, w = bgr.shape[:2]
        line_h = 24
        bar_h = line_h * len(hud) + 8
        overlay = bgr.copy()
        cv2.rectangle(overlay, (0, h - bar_h), (w, h), (0, 0, 0), -1)
        out = cv2.addWeighted(overlay, 0.55, bgr, 0.45, 0)
        y = h - bar_h + line_h - 2
        for line in hud:
            cv2.putText(
                out, line.text, (12, y),
                cv2.FONT_HERSHEY_SIMPLEX, line.scale, line.color, line.thickness,
            )
            y += line_h
        return out
