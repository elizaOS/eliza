from __future__ import annotations

import pytest
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
_ORCH_PKG = _ROOT / "plugins" / "plugin-agent-orchestrator" / "python"
if _ORCH_PKG.exists():
    sys.path.insert(0, str(_ORCH_PKG))

from elizaos_gaia.orchestrator.runner import OrchestratedGAIARunner
from elizaos_gaia.types import GAIAConfig


@pytest.mark.asyncio
async def test_orchestrated_runner_enforces_strict_capabilities(tmp_path) -> None:
    config = GAIAConfig(
        dataset_source="sample",
        split="validation",
        max_questions=1,
        output_dir=str(tmp_path),
        orchestrated=True,
        execution_mode="orchestrated",
        provider_set=["swe-agent"],
        required_capabilities=["research.web_search", "research.nonexistent"],
        strict_capabilities=True,
    )
    runner = OrchestratedGAIARunner(config)
    report = await runner.run_benchmark()

    result = report.by_provider["swe-agent"][0]
    assert result.capability_violations
    assert "research.nonexistent" in result.capability_violations
    assert not result.gaia_result.is_correct
