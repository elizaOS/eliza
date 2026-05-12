"""Tests for orchestrator trace and strict orchestration behavior."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
_PYTHON_PKG = _ROOT / "packages" / "python"
_ORCH_PKG = _ROOT / "plugins" / "plugin-agent-orchestrator" / "python"
sys.path.insert(0, str(_ROOT))
if _PYTHON_PKG.exists():
    sys.path.insert(0, str(_PYTHON_PKG))
if _ORCH_PKG.exists():
    sys.path.insert(0, str(_ORCH_PKG))

from benchmarks.swe_bench.orchestrator.agent import OrchestratingAgent
from benchmarks.swe_bench.orchestrator.trace import RunTraceRecorder
from benchmarks.swe_bench.orchestrator.types import OrchestratedBenchmarkConfig, ProviderType
from benchmarks.swe_bench.repo_manager import RepositoryManager
from benchmarks.swe_bench.types import SWEBenchInstance, SWEBenchVariant


def _make_instance() -> SWEBenchInstance:
    return SWEBenchInstance(
        instance_id="repo__repo-1",
        repo="owner/repo",
        base_commit="abc123",
        problem_statement="Fix a bug in function foo() when input is empty.",
        hints_text="Look at src/foo.py",
        created_at="2026-01-01",
        patch="",
        test_patch="",
        fail_to_pass=[],
        pass_to_pass=[],
    )


class _RuntimeModelFails:
    agent_id = "test-agent"

    async def use_model(self, model_type: str, params: dict[str, object]) -> str:
        _ = model_type, params
        raise RuntimeError("Model unavailable")


@pytest.mark.asyncio
async def test_trace_recorder_persists_full_event_stream(tmp_path):
    recorder = RunTraceRecorder(
        instance_id="repo__repo-1",
        provider_id="swe-agent",
        output_dir=str(tmp_path),
    )
    recorder.set_capability_evidence(
        required=["code.read"],
        declared=["code.read", "code.shell"],
        observed=["code.read"],
        violations=[],
    )
    recorder.add("orchestrator", "analysis_request", {"prompt": "analyze this"})
    recorder.add("swe-agent", "tool_call", {"action": "SEARCH_CODE", "query": "foo"})

    trace_file = recorder.save()
    assert trace_file.endswith(".trace.json")

    with open(trace_file, encoding="utf-8") as f:
        payload = json.load(f)

    assert payload["schema_version"] == "2.0"
    assert payload["instance_id"] == "repo__repo-1"
    assert payload["provider_id"] == "swe-agent"
    assert payload["capability_evidence"]["required"] == ["code.read"]
    assert payload["event_count"] == 2
    assert payload["events"][0]["event"] == "analysis_request"
    assert payload["events"][1]["event"] == "tool_call"


@pytest.mark.asyncio
async def test_task_description_generation_fails_hard_without_fallback(tmp_path):
    runtime = _RuntimeModelFails()
    config = OrchestratedBenchmarkConfig(
        variant=SWEBenchVariant.LITE,
        workspace_dir=str(tmp_path / "workspace"),
        output_dir=str(tmp_path / "output"),
        providers=[ProviderType.SWE_AGENT],
        allow_task_description_fallback=False,
    )
    agent = OrchestratingAgent(
        runtime=runtime,
        repo_manager=RepositoryManager(str(tmp_path / "workspace")),
        config=config,
    )
    trace = RunTraceRecorder(
        instance_id="repo__repo-1",
        provider_id="swe-agent",
        output_dir=str(tmp_path / "traces"),
    )

    with pytest.raises(RuntimeError, match="Orchestrator model failed"):
        await agent._analyze_and_create_task_description(_make_instance(), trace)


@pytest.mark.asyncio
async def test_task_description_generation_can_fallback_when_explicitly_enabled(tmp_path):
    runtime = _RuntimeModelFails()
    config = OrchestratedBenchmarkConfig(
        variant=SWEBenchVariant.LITE,
        workspace_dir=str(tmp_path / "workspace"),
        output_dir=str(tmp_path / "output"),
        providers=[ProviderType.ELIZA_CODE],
        allow_task_description_fallback=True,
    )
    agent = OrchestratingAgent(
        runtime=runtime,
        repo_manager=RepositoryManager(str(tmp_path / "workspace")),
        config=config,
    )
    trace = RunTraceRecorder(
        instance_id="repo__repo-1",
        provider_id="eliza-code",
        output_dir=str(tmp_path / "traces"),
    )

    description, token_estimate = await agent._analyze_and_create_task_description(
        _make_instance(), trace
    )
    assert "Fix this issue in owner/repo:" in description
    assert "foo()" in description
    assert token_estimate > 0
