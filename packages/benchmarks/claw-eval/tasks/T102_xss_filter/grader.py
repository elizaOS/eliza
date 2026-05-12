"""TB03_xss_filter grader — sandbox-based XSS filter verification."""

from __future__ import annotations

import json
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class XssFilterGrader(AbstractGrader):
    """Grade the XSS filter task using env_snapshot verification output."""

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
        run_ok = self._check_exit_code(env_snapshot)

        # ── Completion (weighted sub-components + gate) ──
        completion = 0.0

        # Script exists + runs (0.10)
        if verify.get("script_exists", False) or script_exists:
            completion += 0.05
        if verify.get("script_runs", False) or run_ok:
            completion += 0.05

        # XSS blocking rate (0.55)
        xss_blocking_rate = verify.get("xss_blocking_rate", 0.0)
        completion += 0.55 * xss_blocking_rate

        # Clean preservation rate (0.35)
        clean_preservation_rate = verify.get("clean_preservation_rate", 0.0)
        completion += 0.35 * clean_preservation_rate

        # GATE: if XSS blocking rate < 50%, filter is ineffective
        if xss_blocking_rate < 0.50:
            completion = min(completion, 0.40)

        scores.completion = round(min(completion, 1.0), 2)

        # ── Robustness ──
        scores.robustness = self.compute_robustness(dispatches)

        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores

    def _parse_verify_json(self, env_snapshot: dict | None) -> dict:
        """Extract verification JSON from verify_filter.py output."""
        if not env_snapshot:
            return {}

        cmd_key = "cmd:python /workspace/fixtures/verify_filter.py"
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

    def _check_script_exists(self, env_snapshot: dict | None) -> bool:
        """Check if filter.py exists from the test command."""
        if not env_snapshot:
            return False

        cmd_key = "cmd:test -f /workspace/filter.py && echo EXISTS || echo MISSING"
        entry = env_snapshot.get(cmd_key, {})
        stdout = entry.get("stdout", "")
        return "EXISTS" in stdout

    def _check_exit_code(self, env_snapshot: dict | None) -> bool:
        """Check if filter.py ran with exit code 0."""
        if not env_snapshot:
            return False

        cmd_key = "cmd:python /workspace/filter.py /workspace/fixtures/samples/attack_01.html 2>&1; echo EXIT_CODE=$?"
        entry = env_snapshot.get(cmd_key, {})
        stdout = entry.get("stdout", "")
        return "EXIT_CODE=0" in stdout
