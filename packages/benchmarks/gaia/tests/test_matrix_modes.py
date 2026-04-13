from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
_ORCH_PKG = _ROOT / "plugins" / "plugin-agent-orchestrator" / "python"
if _ORCH_PKG.exists():
    sys.path.insert(0, str(_ORCH_PKG))

from elizaos_plugin_agent_orchestrator import TaskResult
from elizaos_gaia.orchestrator.providers import BaseGAIAProvider
from elizaos_gaia.orchestrator.runner import OrchestratedGAIARunner
from elizaos_gaia.types import GAIAConfig


@pytest.mark.asyncio
async def test_orchestrated_runner_matrix_modes(monkeypatch, tmp_path) -> None:
    async def _fake_execute_task(self, task, ctx):  # type: ignore[no-untyped-def]
        _ = self, ctx
        payload = json.loads(task.description)
        return TaskResult(
            success=True,
            summary="ok",
            extra={
                "predicted_answer": str(payload.get("final_answer") or ""),
                "token_usage": 1,
                "latency_ms": 1.0,
                "tool_names": ["web_search"],
            },
        )

    monkeypatch.setattr(BaseGAIAProvider, "execute_task", _fake_execute_task)

    config = GAIAConfig(
        dataset_source="sample",
        split="validation",
        max_questions=1,
        output_dir=str(tmp_path),
        orchestrated=True,
        matrix=True,
        execution_mode="orchestrated",
        provider_set=["claude-code", "swe-agent", "codex"],
    )
    runner = OrchestratedGAIARunner(config)
    report = await runner.run_benchmark()

    assert "orchestrated" in report.matrix_results
    assert "direct_shell" in report.matrix_results
    assert set(report.matrix_results["orchestrated"].keys()) == {
        "claude-code",
        "swe-agent",
        "codex",
    }
