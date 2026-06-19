"""TB05_schema_migration grader — sandbox-based migration verification."""

from __future__ import annotations

import json
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class SchemaMigrationGrader(AbstractGrader):
    """Grade the schema migration task using env_snapshot verification output."""

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
        script_exists = self._check_script_exists(env_snapshot)
        script_valid = self._check_script_syntax(env_snapshot)

        # ── Completion (weighted sub-components + gate) ──
        completion = 0.0

        # Script exists (0.05)
        if script_exists:
            completion += 0.05

        # Script is valid Python (0.10)
        if script_valid:
            completion += 0.10

        # Schema structure (0.35)
        schema_score = verify.get("schema_score", 0.0)
        completion += 0.35 * schema_score

        # Data integrity (0.50)
        data_score = verify.get("data_score", 0.0)
        completion += 0.50 * data_score

        # GATE: script must exist and be valid Python
        if not script_valid:
            completion = min(completion, 0.40)

        # GATE: data integrity is the core deliverable — fewer than 5 of 15
        # data checks passing means the migration is fundamentally broken.
        if data_score < 5.0 / 15.0:
            completion = min(completion, 0.50)

        scores.completion = round(min(completion, 1.0), 2)

        # ── Robustness ──
        scores.robustness = self.compute_robustness(dispatches)

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores

    def _parse_verify_json(self, env_snapshot: dict | None) -> dict:
        """Extract verification JSON from verify_migration.py output."""
        if not env_snapshot:
            return {}

        cmd_key = "cmd:python /workspace/fixtures/verify_migration.py"
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

    def _check_script_syntax(self, env_snapshot: dict | None) -> bool:
        """Check if migrate_data.py has valid Python syntax."""
        if not env_snapshot:
            return False

        cmd_key = (
            "cmd:python -c \"import py_compile; "
            "py_compile.compile('/workspace/migrate_data.py', doraise=True)\" "
            "2>&1 && echo SYNTAX_OK || echo SYNTAX_ERR"
        )
        entry = env_snapshot.get(cmd_key, {})
        stdout = entry.get("stdout", "")
        return "SYNTAX_OK" in stdout

    def _check_script_exists(self, env_snapshot: dict | None) -> bool:
        """Check if migrate_data.py exists."""
        if not env_snapshot:
            return False

        cmd_key = "cmd:test -f /workspace/migrate_data.py && echo EXISTS || echo MISSING"
        entry = env_snapshot.get(cmd_key, {})
        stdout = entry.get("stdout", "")
        return "EXISTS" in stdout
