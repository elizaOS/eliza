from __future__ import annotations

from benchmarks.orchestrator_lifecycle.dataset import (
    LifecycleDataset,
    scenario_corpus_sha256,
)


def test_dataset_loads_seed_scenarios() -> None:
    dataset = LifecycleDataset("suites/orchestrator_lifecycle/scenarios")
    scenarios = dataset.load()
    assert len(scenarios) == 132
    ids = {scenario.scenario_id for scenario in scenarios}
    assert "specific_request_simple" in ids
    assert "final_stakeholder_summary" in ids
    assert "specific_request_simple--edge-poliet" not in ids
    assert "specific_request_simple--edge-polite" in ids


def test_dataset_expands_seed_scenarios_by_exactly_10x() -> None:
    dataset = LifecycleDataset("suites/orchestrator_lifecycle/scenarios")
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


def test_expanded_messages_do_not_disclose_benchmark_identity() -> None:
    scenarios = LifecycleDataset("suites/orchestrator_lifecycle/scenarios").load()
    model_visible_text = "\n".join(
        turn.message
        for scenario in scenarios
        for turn in scenario.turns
        if turn.actor in {"user", "assistant"}
    ).lower()

    assert "orchestrator lifecycle benchmark" not in model_visible_text
    assert "expected_behaviors" not in model_visible_text
    assert "forbidden_behaviors" not in model_visible_text


def test_corpus_digest_is_order_independent_and_content_sensitive() -> None:
    scenarios = LifecycleDataset("suites/orchestrator_lifecycle/scenarios").load()
    expected = scenario_corpus_sha256(scenarios)

    assert scenario_corpus_sha256(list(reversed(scenarios))) == expected
    scenarios[0].turns[0].message += " changed"
    assert scenario_corpus_sha256(scenarios) != expected


def test_intake_scenarios_do_not_require_status_for_unexecuted_spawns() -> None:
    by_id = {
        scenario.scenario_id: scenario
        for scenario in LifecycleDataset(
            "suites/orchestrator_lifecycle/scenarios"
        ).load_base()
    }

    for scenario_id in (
        "specific_request_simple",
        "code_request_requires_shell",
        "research_request_requires_web",
    ):
        assert by_id[scenario_id].turns[0].expected_behaviors == ["spawn_subagent"]
