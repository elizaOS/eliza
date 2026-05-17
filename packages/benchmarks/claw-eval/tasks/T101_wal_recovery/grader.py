"""TB02_wal_recovery grader — sandbox-based WAL file recovery verification."""

from __future__ import annotations

import json
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class WalRecoveryGrader(AbstractGrader):
    """Grade the WAL recovery task using env_snapshot verification output."""

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
        json_exists = self._check_json_exists(env_snapshot)

        # ── Completion (weighted sub-components + gate) ──
        completion = 0.0

        # JSON file exists (0.05)
        if verify.get("json_exists", False) or json_exists:
            completion += 0.05

        # Record count: all 11 present (0.15)
        record_count = verify.get("record_count", 0)
        expected_count = verify.get("expected_count", 11)
        if record_count == expected_count:
            completion += 0.15
        elif record_count > 0:
            completion += 0.15 * min(record_count / expected_count, 1.0)

        # Per-record value correctness (0.50)
        correct_records = verify.get("correct_records", 0)
        if expected_count > 0:
            completion += 0.50 * (correct_records / expected_count)

        # WAL actually fixed — DB reads 11 rows via SQLite (0.30)
        if verify.get("wal_fixed", False):
            completion += 0.30
        else:
            # Partial credit if DB shows more than base 5
            db_row_count = verify.get("db_row_count", 0)
            if db_row_count > 5:
                completion += 0.30 * min((db_row_count - 5) / 6, 1.0)

        # GATE: If record_count < 8 → agent who only gets base 5 cannot pass
        if record_count < 8:
            completion = min(completion, 0.40)

        scores.completion = round(min(completion, 1.0), 2)

        # ── Robustness ──
        scores.robustness = self.compute_robustness(dispatches)

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores

    def _parse_verify_json(self, env_snapshot: dict | None) -> dict:
        """Extract verification JSON from verify_recovery.py output."""
        if not env_snapshot:
            return {}

        cmd_key = "cmd:python /workspace/fixtures/verify_recovery.py"
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

    def _check_json_exists(self, env_snapshot: dict | None) -> bool:
        """Check if recovered.json exists from the test command."""
        if not env_snapshot:
            return False

        cmd_key = "cmd:test -f /workspace/recovered.json && echo EXISTS || echo MISSING"
        entry = env_snapshot.get(cmd_key, {})
        stdout = entry.get("stdout", "")
        return "EXISTS" in stdout
