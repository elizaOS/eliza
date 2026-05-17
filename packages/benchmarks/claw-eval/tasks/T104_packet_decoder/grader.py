"""TB06_packet_decoder grader — sandbox-based packet decoding verification."""

from __future__ import annotations

import json
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class PacketDecoderGrader(AbstractGrader):
    """Grade the packet decoder task using env_snapshot verification output."""

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

        verify = self._parse_verify_json(env_snapshot)
        run_ok = self._check_exit_code(env_snapshot)

        # ── Completion (weighted sub-components + gate) ──
        completion = 0.0

        # Decoder exists + runs clean (0.10)
        if verify.get("decoder_exists", False):
            completion += 0.05
        if run_ok:
            completion += 0.05

        # JSONL produced with reasonable count (0.05)
        if verify.get("jsonl_exists", False):
            expected = verify.get("expected_count", 50)
            actual = verify.get("jsonl_line_count", 0)
            if actual >= 0.8 * expected:
                completion += 0.05
            elif actual > 0:
                completion += 0.02

        # Packet accuracy (0.55)
        packet_acc = verify.get("packet_accuracy", 0.0)
        completion += 0.55 * packet_acc

        # CRC error handling (0.30)
        crc_acc = verify.get("crc_accuracy", 0.0)
        completion += 0.30 * crc_acc

        # GATE: CRC detection is a hard requirement — the task explicitly asks
        # the agent to detect corrupted packets. Without any CRC detection,
        # cap completion so it cannot pass on packet parsing alone.
        corrupt_expected = verify.get("corrupt_expected", 3)
        if corrupt_expected > 0 and crc_acc == 0.0:
            completion = min(completion, 0.50)

        scores.completion = round(min(completion, 1.0), 2)

        # ── Robustness ──
        scores.robustness = self.compute_robustness(dispatches)

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores

    def _parse_verify_json(self, env_snapshot: dict | None) -> dict:
        """Extract verification JSON from verify_decode.py output."""
        if not env_snapshot:
            return {}

        cmd_key = "cmd:python /workspace/fixtures/verify_decode.py"
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

    def _check_exit_code(self, env_snapshot: dict | None) -> bool:
        """Check if decode.py ran with exit code 0."""
        if not env_snapshot:
            return False

        cmd_key = "cmd:python /workspace/decode.py 2>&1; echo EXIT_CODE=$?"
        entry = env_snapshot.get(cmd_key, {})
        stdout = entry.get("stdout", "")
        return "EXIT_CODE=0" in stdout
