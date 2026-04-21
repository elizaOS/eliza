"""Tests for ADHDBench types."""

from elizaos_adhdbench.types import (
    DEFAULT_SCALE_POINTS,
    ExpectedOutcome,
    OutcomeType,
    ScalePoint,
    Scenario,
    ScenarioLevel,
    Turn,
    TurnResult,
    ScalingCurvePoint,
    BenchmarkResults,
)


def test_scale_point_label() -> None:
    sp = ScalePoint(action_count=50, provider_count=18, conversation_prefill=30)
    assert sp.label == "a50_p18_m30"


def test_scale_point_frozen() -> None:
    sp = ScalePoint(action_count=10, provider_count=8, conversation_prefill=0)
    raised = False
    try:
        sp.action_count = 20  # type: ignore[misc]
    except AttributeError:
        raised = True
    assert raised, "ScalePoint should be frozen"


def test_default_scale_points_ordering() -> None:
    counts = [sp.action_count for sp in DEFAULT_SCALE_POINTS]
    assert counts == sorted(counts), "Default scale points should be in ascending order"


def test_turn_frozen() -> None:
    t = Turn(role="user", text="hello")
    raised = False
    try:
        t.text = "world"  # type: ignore[misc]
    except AttributeError:
        raised = True
    assert raised, "Turn should be frozen"


def test_scenario_frozen() -> None:
    s = Scenario(
        id="test", name="test", description="test",
        level=ScenarioLevel.ACTION_DISPATCH,
        turns=(Turn(role="user", text="hi"),),
    )
    raised = False
    try:
        s.id = "changed"  # type: ignore[misc]
    except AttributeError:
        raised = True
    assert raised, "Scenario should be frozen"


def test_expected_outcome_creation() -> None:
    o = ExpectedOutcome(
        outcome_type=OutcomeType.ACTION_MATCH,
        value="REPLY",
        weight=1.0,
    )
    assert o.outcome_type == OutcomeType.ACTION_MATCH
    assert o.value == "REPLY"
    assert o.weight == 1.0


def test_expected_outcome_list_value() -> None:
    o = ExpectedOutcome(
        outcome_type=OutcomeType.ACTION_MATCH,
        value=["REPLY", "SEND_MESSAGE"],
    )
    assert isinstance(o.value, list)
    assert len(o.value) == 2


def test_expected_outcome_dict_value() -> None:
    o = ExpectedOutcome(
        outcome_type=OutcomeType.PARAM_MATCH,
        value={"name": "Alice", "email": "alice@test.com"},
    )
    assert isinstance(o.value, dict)


def test_turn_result_mutable() -> None:
    tr = TurnResult(
        turn_index=0,
        actions_selected=["REPLY"],
        providers_requested=[],
        response_text="hello",
        providers_actually_run=[],
        outcome_results=[],
        latency_ms=100.0,
    )
    tr.latency_ms = 200.0
    assert tr.latency_ms == 200.0


def test_scenario_level_values() -> None:
    assert ScenarioLevel.ACTION_DISPATCH.value == 0
    assert ScenarioLevel.CONTEXT_TRACKING.value == 1
    assert ScenarioLevel.COMPLEX_EXECUTION.value == 2


def test_outcome_type_values() -> None:
    assert OutcomeType.ACTION_MATCH.value == "action_match"
    assert OutcomeType.TEXT_CONTAINS.value == "text_contains"
    assert OutcomeType.PROVIDERS_REQUESTED.value == "providers_requested"


def test_scaling_curve_point() -> None:
    p = ScalingCurvePoint(
        scale_label="a50_p18_m30",
        action_count=50,
        provider_count=18,
        conversation_prefill=30,
        score=0.85,
        latency_ms=1500.0,
        scenario_count=20,
    )
    assert p.score == 0.85
    assert p.scenario_count == 20
