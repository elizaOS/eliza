from __future__ import annotations

from benchmarks.orchestrator_lifecycle.dataset import LifecycleDataset


def test_dataset_loads_seed_scenarios() -> None:
    dataset = LifecycleDataset("benchmarks/orchestrator_lifecycle/scenarios")
    scenarios = dataset.load()
    assert len(scenarios) >= 12
    ids = {scenario.scenario_id for scenario in scenarios}
    assert "specific_request_simple" in ids
    assert "final_stakeholder_summary" in ids
