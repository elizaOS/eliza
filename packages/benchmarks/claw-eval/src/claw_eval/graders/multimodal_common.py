"""Shared helpers for multimodal task graders (video, document, webpage)."""

from __future__ import annotations

import re
from difflib import SequenceMatcher

from ..models.trace import ToolDispatch


class MultimodalGraderMixin:
    """Mixin providing utility methods for graders that handle multimodal tasks."""

    @staticmethod
    def check_file_exists(env_snapshot: dict | None, path: str) -> bool:
        """Check whether a file was successfully read in the env_snapshot."""
        if not env_snapshot:
            return False
        key = f"file:{path}"
        entry = env_snapshot.get(key, {})
        return "error" not in entry

    @staticmethod
    def check_file_format(
        env_snapshot: dict | None, path: str, expected_mime: str,
    ) -> bool:
        """Verify output format via stored /read response mime_type."""
        if not env_snapshot:
            return False
        key = f"file:{path}"
        entry = env_snapshot.get(key, {})
        mime = entry.get("mime_type", "")
        return expected_mime.lower() in mime.lower()

    @staticmethod
    def get_ffprobe_metadata(env_snapshot: dict | None, cmd_key: str) -> dict | None:
        """Parse JSON output from an ffprobe command stored in env_snapshot.

        *cmd_key* is the full command string used as key, e.g.
        ``"cmd:ffprobe -v quiet -print_format json ..."``.
        """
        if not env_snapshot:
            return None
        entry = env_snapshot.get(cmd_key, {})
        stdout = entry.get("stdout", "")
        if not stdout:
            return None
        import json
        try:
            return json.loads(stdout)
        except (json.JSONDecodeError, TypeError):
            return None

    @staticmethod
    def compute_text_similarity(reference: str, candidate: str) -> float:
        """Compute normalised text similarity (0.0–1.0) between two strings.

        Uses :class:`difflib.SequenceMatcher` which works well for subtitle
        and OCR comparison tasks.
        """
        if not reference and not candidate:
            return 1.0
        if not reference or not candidate:
            return 0.0
        # Normalise whitespace
        ref = " ".join(reference.split())
        cand = " ".join(candidate.split())
        return SequenceMatcher(None, ref, cand).ratio()

    @staticmethod
    def check_tool_usage(
        dispatches: list[ToolDispatch],
        tool_name: str,
        min_calls: int = 1,
    ) -> bool:
        """Verify the agent used *tool_name* at least *min_calls* times successfully."""
        count = sum(
            1 for d in dispatches
            if d.tool_name == tool_name and d.response_status < 400
        )
        return count >= min_calls

    @staticmethod
    def get_snapshot_stdout(env_snapshot: dict | None, cmd: str) -> str:
        """Extract stdout from a command entry in env_snapshot."""
        if not env_snapshot:
            return ""
        key = f"cmd:{cmd}"
        entry = env_snapshot.get(key, {})
        return entry.get("stdout", "")

    @staticmethod
    def get_snapshot_exit_code(env_snapshot: dict | None, cmd: str) -> int | None:
        """Extract exit code from a command entry in env_snapshot."""
        if not env_snapshot:
            return None
        key = f"cmd:{cmd}"
        entry = env_snapshot.get(key, {})
        code = entry.get("exit_code")
        return int(code) if code is not None else None

    @staticmethod
    def extract_number_from_text(text: str) -> float | None:
        """Extract the first number from text (useful for counting tasks)."""
        m = re.search(r"[-+]?\d*\.?\d+", text)
        if m:
            return float(m.group())
        return None
