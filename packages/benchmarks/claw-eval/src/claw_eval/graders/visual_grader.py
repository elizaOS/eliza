"""Mixin for graders that require visual comparison (dynamic webpage, page reproduction)."""

from __future__ import annotations

import re
from typing import Any


class VisualGraderMixin:
    """Helpers for tasks that produce visual output and need screenshot-based grading."""

    @staticmethod
    def collect_screenshots_from_snapshot(
        env_snapshot: dict | None,
        pattern: str = "/workspace/grading_frames/",
    ) -> list[str]:
        """Extract base64-encoded PNG images from env_snapshot file entries.

        Looks for file entries whose key starts with ``file:<pattern>`` and
        returns the base64 content strings, sorted by path.
        """
        if not env_snapshot:
            return []
        images: list[tuple[str, str]] = []
        for key, entry in env_snapshot.items():
            if not key.startswith("file:"):
                continue
            path = key[len("file:"):]
            if pattern not in path:
                continue
            if entry.get("encoding") == "base64" and entry.get("content"):
                images.append((path, entry["content"]))
        # Sort by path to maintain frame ordering
        images.sort(key=lambda x: x[0])
        return [img for _, img in images]

    @staticmethod
    def compute_ssim_score(
        env_snapshot: dict | None,
        cmd: str,
    ) -> float | None:
        """Parse a numeric SSIM score from an env_snapshot command stdout.

        Expects the command to print a float (e.g. ``0.87``) to stdout.
        """
        if not env_snapshot:
            return None
        key = f"cmd:{cmd}"
        entry = env_snapshot.get(key, {})
        stdout = entry.get("stdout", "").strip()
        m = re.search(r"([0-9]+\.?[0-9]*)", stdout)
        if m:
            try:
                return float(m.group(1))
            except ValueError:
                return None
        return None

    @staticmethod
    def judge_visual_similarity(
        judge: Any,
        ref_images_b64: list[str],
        gen_images_b64: list[str],
        rubric: str,
        context: str = "",
    ) -> Any | None:
        """Use LLM Judge with vision to compare reference and generated images.

        Calls ``judge.evaluate_visual()`` if available, returns JudgeResult or None.
        """
        if judge is None:
            return None
        if not hasattr(judge, "evaluate_visual"):
            return None
        if not ref_images_b64 and not gen_images_b64:
            return None
        return judge.evaluate_visual(
            rubric=rubric,
            reference_images_b64=ref_images_b64,
            candidate_images_b64=gen_images_b64,
            context=context,
        )
