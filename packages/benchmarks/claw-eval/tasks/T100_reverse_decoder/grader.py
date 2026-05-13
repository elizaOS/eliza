"""TB01_reverse_decoder grader — sandbox-based encoder verification."""

from __future__ import annotations

import json
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class ReverseDecoderGrader(AbstractGrader):
    """Grade the reverse-decoder task using env_snapshot verification output."""

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

        # Parse verification results from env_snapshot
        verify = self._parse_verify_json(env_snapshot)

        # ── Completion (weighted sub-components + gate) ──
        completion = 0.0

        # File exists (0.05)
        if verify.get("file_exists", False):
            completion += 0.05

        # Exact decode match (0.55) — partial credit via char_match_ratio
        if verify.get("exact_match", False):
            completion += 0.55
        elif verify.get("decode_success", False):
            ratio = verify.get("char_match_ratio", 0.0)
            completion += 0.55 * ratio

        # Size constraint (0.40) — full at <=60%, partial at <=75%
        if verify.get("size_within_60pct", False):
            completion += 0.40
        elif verify.get("size_within_75pct", False):
            completion += 0.20

        # GATE: compression is a hard requirement — without ANY compression
        # progress (>75% of target), cap completion so it cannot pass.
        # Rationale: the task explicitly requires <= 60% size; getting the
        # decode right but ignoring compression means the core task is unmet.
        if not verify.get("size_within_75pct", False):
            completion = min(completion, 0.35)

        scores.completion = round(min(completion, 1.0), 2)

        # ── Robustness ──
        scores.robustness = self.compute_robustness(dispatches)

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores

    def _parse_verify_json(self, env_snapshot: dict | None) -> dict:
        """Extract verification JSON from the verify_encoder.py command output."""
        if not env_snapshot:
            return {}

        cmd_key = "cmd:python /workspace/fixtures/verify_encoder.py"
        entry = env_snapshot.get(cmd_key, {})
        stdout = entry.get("stdout", "")

        for line in stdout.strip().splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    pass
        return {}
