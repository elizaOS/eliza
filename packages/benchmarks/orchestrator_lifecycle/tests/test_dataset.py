from __future__ import annotations

from benchmarks.orchestrator_lifecycle.dataset import LifecycleDataset


def test_dataset_loads_seed_scenarios() -> None:
    dataset = LifecycleDataset("benchmarks/orchestrator_lifecycle/scenarios")
    scenarios = dataset.load()
    assert len(scenarios) == 132
    ids = {scenario.scenario_id for scenario in scenarios}
    assert "specific_request_simple" in ids
    assert "final_stakeholder_summary" in ids
    assert "specific_request_simple--edge-poliet" not in ids
    assert "specific_request_simple--edge-polite" in ids


def test_dataset_expands_seed_scenarios_by_exactly_10x() -> None:
    dataset = LifecycleDataset("benchmarks/orchestrator_lifecycle/scenarios")
    assert dataset.count_scenarios() == {
        "suite": "orchestrator-lifecycle",
        "existing": 12,
        "added": 120,
        "total": 132,
        "multiplierAdded": 10,
    }
    assert dataset.validate_scenarios() == {
        "valid": True,
        "total": 132,
        "uniqueIds": 132,
        "duplicateIds": [],
        "emptyTurns": [],
        "expansionMatches": True,
    }
