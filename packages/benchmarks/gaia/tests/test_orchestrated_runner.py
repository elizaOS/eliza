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
async def test_orchestrated_runner_smoke(monkeypatch, tmp_path) -> None:
    async def _fake_execute_task(self, task, ctx):  # type: ignore[no-untyped-def]
        _ = self, ctx
        payload = json.loads(task.description)
        final_answer = str(payload.get("final_answer") or "42")
        return TaskResult(
            success=True,
            summary="ok",
            extra={
                "predicted_answer": final_answer,
                "token_usage": 10,
                "latency_ms": 1.0,
                "tool_names": ["web_search", "web_browse"],
            },
        )

    monkeypatch.setattr(BaseGAIAProvider, "execute_task", _fake_execute_task)

    config = GAIAConfig(
        dataset_source="sample",
        split="validation",
        max_questions=2,
        output_dir=str(tmp_path),
        orchestrated=True,
        execution_mode="orchestrated",
        provider_set=["claude-code"],
    )
    runner = OrchestratedGAIARunner(config)
    report = await runner.run_benchmark()

    assert report.overall_accuracy == 1.0
    assert "claude-code" in report.by_provider
    assert report.by_provider["claude-code"]
    trace_file = report.by_provider["claude-code"][0].trace_file
    assert trace_file
    with open(trace_file, encoding="utf-8") as handle:
        payload = json.load(handle)
    assert payload["schema_version"] == "2.0"
    assert payload["capability_evidence"]["required"]
    assert payload["event_count"] >= 2
