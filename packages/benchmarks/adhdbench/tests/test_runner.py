"""Tests for scenario filtering, config, and data integrity."""

from elizaos_adhdbench.config import ADHDBenchConfig
from elizaos_adhdbench.scenarios import ALL_SCENARIOS, get_scenarios, SCENARIO_BY_ID
from elizaos_adhdbench.types import ScalePoint, ScenarioLevel


def test_all_scenarios_count() -> None:
    """Verify total scenario count matches expected."""
    assert len(ALL_SCENARIOS) == 45


def test_l0_count() -> None:
    scenarios = get_scenarios(levels=(0,))
    assert len(scenarios) == 20


def test_l1_count() -> None:
    scenarios = get_scenarios(levels=(1,))
    assert len(scenarios) == 15


def test_l2_count() -> None:
    scenarios = get_scenarios(levels=(2,))
    assert len(scenarios) == 10


def test_filter_by_tags() -> None:
    scenarios = get_scenarios(tags=("memory",))
    assert len(scenarios) > 0
    for s in scenarios:
        assert "memory" in s.tags


def test_filter_by_id() -> None:
    scenarios = get_scenarios(scenario_ids=("L0-001", "L1-005"))
    assert len(scenarios) == 2
    ids = {s.id for s in scenarios}
    assert ids == {"L0-001", "L1-005"}


def test_exclude_memory_scenarios() -> None:
    all_with = get_scenarios(include_memory_scenarios=True)
    all_without = get_scenarios(include_memory_scenarios=False)
    assert len(all_without) < len(all_with)
    for s in all_without:
        assert not s.requires_advanced_memory


def test_exclude_planning_scenarios() -> None:
    all_with = get_scenarios(include_planning_scenarios=True)
    all_without = get_scenarios(include_planning_scenarios=False)
    assert len(all_without) <= len(all_with)
    for s in all_without:
        assert not s.requires_advanced_planning


def test_scenario_ids_unique() -> None:
    ids = [s.id for s in ALL_SCENARIOS]
    assert len(ids) == len(set(ids)), "Scenario IDs must be unique"


def test_all_scenarios_have_turns() -> None:
    for s in ALL_SCENARIOS:
        assert len(s.turns) > 0, f"Scenario {s.id} has no turns"


def test_all_scenarios_have_outcomes() -> None:
    """Every scenario must have at least one turn with expected outcomes."""
    for s in ALL_SCENARIOS:
        has_outcome = any(len(t.expected_outcomes) > 0 for t in s.turns)
        assert has_outcome, f"Scenario {s.id} has no expected outcomes in any turn"


def test_scenario_by_id_lookup() -> None:
    assert "L0-001" in SCENARIO_BY_ID
    assert SCENARIO_BY_ID["L0-001"].name == "Simple time question"


def test_config_defaults() -> None:
    config = ADHDBenchConfig()
    assert config.run_basic is True
    assert config.run_full is True
    assert len(config.scale_points) == 5
    assert config.config_names == ["basic", "full"]


def test_config_basic_only() -> None:
    config = ADHDBenchConfig(run_full=False)
    assert config.config_names == ["basic"]


def test_config_full_only() -> None:
    config = ADHDBenchConfig(run_basic=False)
    assert config.config_names == ["full"]
