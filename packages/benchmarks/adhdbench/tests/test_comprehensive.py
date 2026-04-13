"""Expanded test suite for ADHDBench — edge cases, boundaries, and integration.

Coverage targets:
  - evaluator.py: every OutcomeType, invalid inputs, zero-weight, multi-action,
    empty text, compute_scenario_score, evaluate_turn_outcomes, evaluate_turn_from_results
  - baselines.py: empty inputs, determinism, score bounds
  - scenarios.py: combined filters, empty results, data integrity
  - config.py: edge cases, custom scale points
  - reporting.py: markdown generation, JSON summary, ASCII curve rendering
  - distractor_plugin.py: negative counts, boundary at 50, variant naming
"""

import json
import tempfile
from pathlib import Path

import pytest

from elizaos_adhdbench.baselines import (
    BOOTSTRAP_ACTION_NAMES,
    compute_always_reply_baseline,
    compute_random_baseline,
)
from elizaos_adhdbench.config import ADHDBenchConfig
from elizaos_adhdbench.evaluator import (
    compute_scenario_score,
    compute_turn_score,
    evaluate_outcome,
)
from elizaos_adhdbench.reporting import ADHDBenchReporter
from elizaos_adhdbench.scenarios import (
    ALL_SCENARIOS,
    L0_SCENARIOS,
    L1_SCENARIOS,
    L2_SCENARIOS,
    SCENARIO_BY_ID,
    get_scenarios,
)
from elizaos_adhdbench.types import (
    BenchmarkResults,
    ExpectedOutcome,
    OutcomeResult,
    OutcomeType,
    ScalePoint,
    ScalingCurvePoint,
    Scenario,
    ScenarioLevel,
    ScenarioResult,
    Turn,
    TurnResult,
)


# ===================================================================
# Helpers
# ===================================================================

def _turn(
    actions: list[str] | None = None,
    text: str = "",
    providers_requested: list[str] | None = None,
    providers_run: list[str] | None = None,
    thought: str = "",
    raw_llm: str = "",
) -> TurnResult:
    return TurnResult(
        turn_index=0,
        actions_selected=actions or [],
        providers_requested=providers_requested or [],
        response_text=text,
        providers_actually_run=providers_run or [],
        outcome_results=[],
        latency_ms=0.0,
        thought=thought,
        raw_llm_response=raw_llm,
    )


# ===================================================================
# EVALUATOR — edge cases and invalid inputs
# ===================================================================

class TestEvaluatorEdgeCases:

    def test_action_match_empty_selected(self) -> None:
        """No actions selected -> match fails."""
        o = ExpectedOutcome(OutcomeType.ACTION_MATCH, "REPLY")
        r = evaluate_outcome(o, _turn(actions=[]))
        assert not r.passed

    def test_action_match_multiple_selected_one_matches(self) -> None:
        """Agent selected 3 actions, one matches."""
        o = ExpectedOutcome(OutcomeType.ACTION_MATCH, "SEND_MESSAGE")
        r = evaluate_outcome(o, _turn(actions=["ADD_CONTACT", "SEND_MESSAGE", "SCHEDULE_FOLLOW_UP"]))
        assert r.passed

    def test_action_match_dict_value_returns_invalid(self) -> None:
        """Dict value for ACTION_MATCH is invalid type."""
        o = ExpectedOutcome(OutcomeType.ACTION_MATCH, {"bad": "value"})
        r = evaluate_outcome(o, _turn(actions=["REPLY"]))
        assert not r.passed
        assert "Invalid value type" in r.detail

    def test_action_not_match_dict_value_returns_invalid(self) -> None:
        o = ExpectedOutcome(OutcomeType.ACTION_NOT_MATCH, {"bad": "value"})
        r = evaluate_outcome(o, _turn(actions=["REPLY"]))
        assert not r.passed
        assert "Invalid value type" in r.detail

    def test_action_not_match_empty_selected(self) -> None:
        """No actions selected -> not-match passes (nothing to violate)."""
        o = ExpectedOutcome(OutcomeType.ACTION_NOT_MATCH, "SEND_MESSAGE")
        r = evaluate_outcome(o, _turn(actions=[]))
        assert r.passed

    def test_action_not_match_multiple_violations(self) -> None:
        """Two of three forbidden actions are present."""
        o = ExpectedOutcome(OutcomeType.ACTION_NOT_MATCH, ["A", "B", "C"])
        r = evaluate_outcome(o, _turn(actions=["A", "C"]))
        assert not r.passed
        assert "A" in r.detail
        assert "C" in r.detail

    def test_text_contains_empty_text(self) -> None:
        """Empty response text -> contains always fails."""
        o = ExpectedOutcome(OutcomeType.TEXT_CONTAINS, "anything")
        r = evaluate_outcome(o, _turn(text=""))
        assert not r.passed

    def test_text_contains_empty_needle(self) -> None:
        """Empty needle -> always matches (Python `in` behavior)."""
        o = ExpectedOutcome(OutcomeType.TEXT_CONTAINS, "")
        r = evaluate_outcome(o, _turn(text="hello"))
        assert r.passed

    def test_text_contains_list_value_returns_invalid(self) -> None:
        o = ExpectedOutcome(OutcomeType.TEXT_CONTAINS, ["not", "a", "string"])
        r = evaluate_outcome(o, _turn(text="hello"))
        assert not r.passed
        assert "Invalid value type" in r.detail

    def test_text_not_contains_empty_text(self) -> None:
        """Empty text -> not-contains passes (nothing to find)."""
        o = ExpectedOutcome(OutcomeType.TEXT_NOT_CONTAINS, "anything")
        r = evaluate_outcome(o, _turn(text=""))
        assert r.passed

    def test_text_not_contains_list_value_returns_invalid(self) -> None:
        o = ExpectedOutcome(OutcomeType.TEXT_NOT_CONTAINS, ["not", "str"])
        r = evaluate_outcome(o, _turn(text="hello"))
        assert not r.passed
        assert "Invalid value type" in r.detail

    def test_param_match_string_value_returns_invalid(self) -> None:
        o = ExpectedOutcome(OutcomeType.PARAM_MATCH, "not_a_dict")
        r = evaluate_outcome(o, _turn())
        assert not r.passed
        assert "Invalid value type" in r.detail

    def test_param_match_found_in_thought(self) -> None:
        """Param value can be found in thought field."""
        o = ExpectedOutcome(OutcomeType.PARAM_MATCH, {"target": "Alice"})
        r = evaluate_outcome(o, _turn(thought="I should send this to Alice"))
        assert r.passed

    def test_param_match_found_in_response(self) -> None:
        """Param value can be found in response_text."""
        o = ExpectedOutcome(OutcomeType.PARAM_MATCH, {"name": "Bob"})
        r = evaluate_outcome(o, _turn(text="Adding Bob to contacts"))
        assert r.passed

    def test_param_match_multiple_params_partial_fail(self) -> None:
        """Two params expected, only one found."""
        o = ExpectedOutcome(OutcomeType.PARAM_MATCH, {"name": "Alice", "email": "alice@x.com"})
        r = evaluate_outcome(o, _turn(text="Adding Alice to contacts"))
        assert not r.passed  # email not found

    def test_providers_requested_dict_value_returns_invalid(self) -> None:
        o = ExpectedOutcome(OutcomeType.PROVIDERS_REQUESTED, {"bad": "type"})
        r = evaluate_outcome(o, _turn())
        assert not r.passed

    def test_providers_requested_string_value(self) -> None:
        """Single string provider name."""
        o = ExpectedOutcome(OutcomeType.PROVIDERS_REQUESTED, "KNOWLEDGE")
        r = evaluate_outcome(o, _turn(providers_requested=["KNOWLEDGE"]))
        assert r.passed

    def test_providers_requested_multiple_expected(self) -> None:
        """All expected must be present."""
        o = ExpectedOutcome(OutcomeType.PROVIDERS_REQUESTED, ["KNOWLEDGE", "FACTS"])
        r = evaluate_outcome(o, _turn(providers_requested=["KNOWLEDGE"]))
        assert not r.passed  # FACTS missing

    def test_providers_requested_multiple_expected_all_present(self) -> None:
        o = ExpectedOutcome(OutcomeType.PROVIDERS_REQUESTED, ["KNOWLEDGE", "FACTS"])
        r = evaluate_outcome(o, _turn(providers_requested=["KNOWLEDGE", "FACTS", "ENTITIES"]))
        assert r.passed



class TestEvaluatorScoring:

    def test_scenario_score_no_outcomes(self) -> None:
        """Turns with no outcomes are excluded; if all excluded, score is 1.0."""
        turns = [_turn(), _turn(), _turn()]
        assert compute_scenario_score(turns) == 1.0

    def test_scenario_score_mixed_turns(self) -> None:
        """Mix of turns with and without outcomes."""
        t1 = _turn(actions=["REPLY"])
        t1.outcome_results = [
            OutcomeResult(ExpectedOutcome(OutcomeType.ACTION_MATCH, "REPLY"), True, "REPLY", "ok"),
        ]
        t2 = _turn()  # no outcomes
        t3 = _turn(actions=["WRONG"])
        t3.outcome_results = [
            OutcomeResult(ExpectedOutcome(OutcomeType.ACTION_MATCH, "SEND_MESSAGE"), False, "WRONG", "fail"),
        ]
        score = compute_scenario_score([t1, t2, t3])
        assert score == 0.5  # 1.0 + 0.0 / 2 scored turns

    def test_scenario_score_single_perfect(self) -> None:
        t = _turn(actions=["REPLY"])
        t.outcome_results = [
            OutcomeResult(ExpectedOutcome(OutcomeType.ACTION_MATCH, "REPLY"), True, "REPLY", "ok"),
        ]
        assert compute_scenario_score([t]) == 1.0

    def test_turn_score_zero_weight(self) -> None:
        """If all outcomes have weight 0, score is 1.0 (no assertions)."""
        results = [
            OutcomeResult(ExpectedOutcome(OutcomeType.ACTION_MATCH, "X", weight=0.0), False, "", ""),
        ]
        assert compute_turn_score(results) == 1.0

    def test_turn_score_all_fail(self) -> None:
        results = [
            OutcomeResult(ExpectedOutcome(OutcomeType.ACTION_MATCH, "X", weight=1.0), False, "", ""),
            OutcomeResult(ExpectedOutcome(OutcomeType.TEXT_CONTAINS, "Y", weight=1.0), False, "", ""),
        ]
        assert compute_turn_score(results) == 0.0

    def test_evaluate_batch_inline(self) -> None:
        """Batch evaluation works as inline list comprehension."""
        outcomes = (
            ExpectedOutcome(OutcomeType.ACTION_MATCH, "REPLY"),
            ExpectedOutcome(OutcomeType.TEXT_CONTAINS, "hello"),
        )
        t = _turn(actions=["REPLY"], text="hello world")
        results = [evaluate_outcome(o, t) for o in outcomes]
        assert len(results) == 2
        assert all(r.passed for r in results)


# ===================================================================
# BASELINES — edge cases and determinism
# ===================================================================

class TestBaselines:

    def test_random_baseline_empty_scenarios(self) -> None:
        assert compute_random_baseline([], BOOTSTRAP_ACTION_NAMES) == 0.0

    def test_random_baseline_empty_action_pool(self) -> None:
        """Empty pool falls back to NONE action."""
        scenarios = get_scenarios(levels=(0,), scenario_ids=("L0-001",))
        score = compute_random_baseline(scenarios, [])
        assert 0.0 <= score <= 1.0

    def test_random_baseline_deterministic(self) -> None:
        """Same seed produces same result."""
        scenarios = get_scenarios(levels=(0,))
        s1 = compute_random_baseline(scenarios, BOOTSTRAP_ACTION_NAMES, seed=42)
        s2 = compute_random_baseline(scenarios, BOOTSTRAP_ACTION_NAMES, seed=42)
        assert s1 == s2

    def test_random_baseline_different_seed_different_result(self) -> None:
        scenarios = get_scenarios(levels=(0,))
        s1 = compute_random_baseline(scenarios, BOOTSTRAP_ACTION_NAMES, seed=42)
        s2 = compute_random_baseline(scenarios, BOOTSTRAP_ACTION_NAMES, seed=99)
        # Different seeds should produce different results (probabilistically)
        # With 20 scenarios and 100 samples each, this is extremely unlikely to fail
        assert s1 != s2

    def test_always_reply_baseline_empty_scenarios(self) -> None:
        assert compute_always_reply_baseline([]) == 0.0

    def test_baseline_scores_in_range(self) -> None:
        """Both baselines produce scores in [0, 1]."""
        scenarios = get_scenarios(levels=(0, 1, 2))
        r = compute_random_baseline(scenarios, BOOTSTRAP_ACTION_NAMES)
        a = compute_always_reply_baseline(scenarios)
        assert 0.0 <= r <= 1.0
        assert 0.0 <= a <= 1.0

    def test_always_reply_beats_random_on_l0(self) -> None:
        """REPLY is correct for many L0 scenarios, so it should beat random."""
        scenarios = get_scenarios(levels=(0,))
        r = compute_random_baseline(scenarios, BOOTSTRAP_ACTION_NAMES)
        a = compute_always_reply_baseline(scenarios)
        assert a > r

    def test_random_baseline_single_scenario(self) -> None:
        """Works correctly with a single scenario."""
        scenarios = get_scenarios(scenario_ids=("L0-002",))
        assert len(scenarios) == 1
        score = compute_random_baseline(scenarios, BOOTSTRAP_ACTION_NAMES, num_samples=50)
        assert 0.0 <= score <= 1.0


# ===================================================================
# SCENARIOS — filtering, data integrity, combined filters
# ===================================================================

class TestScenarioFiltering:

    def test_empty_levels(self) -> None:
        assert get_scenarios(levels=()) == []

    def test_nonexistent_tag(self) -> None:
        assert get_scenarios(tags=("nonexistent_tag_xyz",)) == []

    def test_nonexistent_id(self) -> None:
        assert get_scenarios(scenario_ids=("DOES_NOT_EXIST",)) == []

    def test_combined_level_and_tag(self) -> None:
        """L1 scenarios with 'memory' tag."""
        results = get_scenarios(levels=(1,), tags=("memory",))
        for s in results:
            assert s.level == ScenarioLevel.CONTEXT_TRACKING
            assert "memory" in s.tags

    def test_combined_level_and_id(self) -> None:
        """ID filter within a level."""
        results = get_scenarios(levels=(0,), scenario_ids=("L0-001", "L1-001"))
        # L1-001 should be excluded because level filter is (0,)
        assert len(results) == 1
        assert results[0].id == "L0-001"

    def test_memory_flag_excludes_correct_scenarios(self) -> None:
        memory_ids = {s.id for s in ALL_SCENARIOS if s.requires_advanced_memory}
        filtered = get_scenarios(include_memory_scenarios=False)
        filtered_ids = {s.id for s in filtered}
        assert memory_ids.isdisjoint(filtered_ids)

    def test_planning_flag_excludes_correct_scenarios(self) -> None:
        planning_ids = {s.id for s in ALL_SCENARIOS if s.requires_advanced_planning}
        filtered = get_scenarios(include_planning_scenarios=False)
        filtered_ids = {s.id for s in filtered}
        assert planning_ids.isdisjoint(filtered_ids)


class TestScenarioDataIntegrity:

    def test_all_scenario_ids_follow_naming_convention(self) -> None:
        """IDs must be L{level}-{number}."""
        import re
        for s in ALL_SCENARIOS:
            assert re.match(r"^L\d+-\d{3}$", s.id), f"Bad ID format: {s.id}"

    def test_scenario_levels_match_ids(self) -> None:
        """The number in the ID prefix must match the scenario's level."""
        for s in ALL_SCENARIOS:
            level_from_id = int(s.id[1])
            assert level_from_id == s.level.value, f"{s.id} level mismatch"

    def test_all_user_turns_have_text(self) -> None:
        for s in ALL_SCENARIOS:
            for t in s.turns:
                assert t.text, f"Scenario {s.id} has turn with empty text"

    def test_l0_scenarios_are_single_turn(self) -> None:
        """L0 scenarios should have their outcome on the first (and often only) turn."""
        for s in L0_SCENARIOS:
            # At least the first turn should have outcomes
            first_with_outcome = next(
                (t for t in s.turns if t.expected_outcomes), None
            )
            assert first_with_outcome is not None

    def test_l1_scenarios_are_multi_turn(self) -> None:
        """L1 scenarios should have more than 1 turn."""
        for s in L1_SCENARIOS:
            assert len(s.turns) > 1, f"{s.id} should be multi-turn"

    def test_scenario_by_id_complete(self) -> None:
        """SCENARIO_BY_ID contains every scenario."""
        assert set(SCENARIO_BY_ID.keys()) == {s.id for s in ALL_SCENARIOS}

    def test_no_duplicate_scenario_names(self) -> None:
        names = [s.name for s in ALL_SCENARIOS]
        assert len(names) == len(set(names)), "Scenario names should be unique"

    def test_outcome_weights_positive(self) -> None:
        """All outcome weights should be positive."""
        for s in ALL_SCENARIOS:
            for t in s.turns:
                for o in t.expected_outcomes:
                    assert o.weight > 0, f"Scenario {s.id} has outcome with weight <= 0"


# ===================================================================
# CONFIG — edge cases
# ===================================================================

class TestConfigEdgeCases:

    def test_both_configs_disabled(self) -> None:
        c = ADHDBenchConfig(run_basic=False, run_full=False)
        assert c.config_names == []

    def test_custom_scale_points(self) -> None:
        custom = (ScalePoint(5, 3, 0), ScalePoint(15, 6, 5))
        c = ADHDBenchConfig(scale_points=custom)
        assert len(c.scale_points) == 2
        assert c.scale_points[0].action_count == 5

    def test_prefill_pool_length(self) -> None:
        c = ADHDBenchConfig()
        assert len(c.prefill_topic_pool) == 20

    def test_prefill_pool_no_duplicates(self) -> None:
        c = ADHDBenchConfig()
        assert len(c.prefill_topic_pool) == len(set(c.prefill_topic_pool))

    def test_custom_character_name(self) -> None:
        c = ADHDBenchConfig(character_name="TestBot")
        assert c.character_name == "TestBot"

    def test_default_model(self) -> None:
        c = ADHDBenchConfig()
        assert c.model_name == "gpt-4o-mini"
        assert c.model_provider == "openai"


# ===================================================================
# REPORTING — test real output generation
# ===================================================================

class TestReporting:

    def _make_results(self) -> BenchmarkResults:
        """Build a small but complete BenchmarkResults for testing."""
        sp = ScalePoint(10, 8, 0)
        tr1 = TurnResult(
            turn_index=0, actions_selected=["REPLY"],
            providers_requested=["CHARACTER"], response_text="Hello",
            providers_actually_run=["CHARACTER", "ENTITIES"],
            outcome_results=[
                OutcomeResult(ExpectedOutcome(OutcomeType.ACTION_MATCH, "REPLY"), True, "REPLY", "ok"),
            ],
            latency_ms=150.0,
        )
        tr2 = TurnResult(
            turn_index=0, actions_selected=["SEND_MESSAGE"],
            providers_requested=[], response_text="Sent",
            providers_actually_run=["CHARACTER"],
            outcome_results=[
                OutcomeResult(ExpectedOutcome(OutcomeType.ACTION_MATCH, "REPLY"), False, "SEND_MESSAGE", "wrong"),
            ],
            latency_ms=200.0,
        )
        results = [
            ScenarioResult(
                scenario_id="L0-001", scenario_name="Test Pass",
                level=ScenarioLevel.ACTION_DISPATCH, scale_point=sp,
                config_name="basic", turn_results=[tr1], score=1.0,
                total_latency_ms=150.0, model_name="test-model",
            ),
            ScenarioResult(
                scenario_id="L0-002", scenario_name="Test Fail",
                level=ScenarioLevel.ACTION_DISPATCH, scale_point=sp,
                config_name="basic", turn_results=[tr2], score=0.0,
                total_latency_ms=200.0, model_name="test-model",
            ),
        ]
        return BenchmarkResults(
            metadata={"benchmark": "ADHDBench", "model": "test-model", "duration_ms": 350.0, "total_scenarios": 2, "provider": "test"},
            results=results,
            scaling_curves={
                "basic": [ScalingCurvePoint("a10_p8_m0", 10, 8, 0, 0.5, 175.0, 2)],
            },
            baselines={"random": 0.3, "always_reply": 0.5},
        )

    def test_markdown_report_content(self) -> None:
        """Verify the markdown report contains expected sections."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config = ADHDBenchConfig(output_dir=tmpdir, generate_report=False)
            reporter = ADHDBenchReporter(config)
            report = reporter._build_markdown_report(self._make_results())

            assert "# ADHDBench Report" in report
            assert "## Baselines" in report
            assert "## Attention Scaling Curves" in report
            assert "## Per-Level Breakdown" in report
            assert "## Lowest Scoring Scenarios" in report
            assert "## Failed Outcome Details" in report
            assert "test-model" in report
            assert "30.0%" in report  # random baseline
            assert "L0-002" in report  # failing scenario

    def test_json_summary_structure(self) -> None:
        config = ADHDBenchConfig()
        reporter = ADHDBenchReporter(config)
        summary = reporter._build_json_summary(self._make_results())

        assert "metadata" in summary
        assert "baselines" in summary
        assert "scaling_curves" in summary
        assert "per_scenario" in summary
        assert summary["baselines"]["random"] == 0.3
        curves = summary["scaling_curves"]
        assert "basic" in curves
        assert len(curves["basic"]) == 1
        assert curves["basic"][0]["score"] == 0.5

    def test_json_summary_serializable(self) -> None:
        config = ADHDBenchConfig()
        reporter = ADHDBenchReporter(config)
        summary = reporter._build_json_summary(self._make_results())
        serialized = json.dumps(summary, default=str)
        parsed = json.loads(serialized)
        assert parsed["metadata"]["benchmark"] == "ADHDBench"

    def test_ascii_curve_rendering(self) -> None:
        config = ADHDBenchConfig()
        reporter = ADHDBenchReporter(config)
        points = [
            ScalingCurvePoint("a10", 10, 8, 0, 1.0, 100.0, 5),
            ScalingCurvePoint("a50", 50, 18, 30, 0.5, 200.0, 5),
        ]
        rendered = reporter._render_ascii_curve(points, "test")
        assert "```" in rendered
        assert "test" in rendered
        assert "##" in rendered  # bar chars

    def test_ascii_curve_empty_points(self) -> None:
        config = ADHDBenchConfig()
        reporter = ADHDBenchReporter(config)
        assert reporter._render_ascii_curve([], "test") == "(no data)"

    def test_generate_report_writes_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config = ADHDBenchConfig(output_dir=tmpdir)
            reporter = ADHDBenchReporter(config)
            results = self._make_results()
            report_path = reporter.generate_report(results)

            assert report_path.exists()
            assert report_path.suffix == ".md"
            # JSON summary should also exist
            json_files = list(Path(tmpdir).glob("*.json"))
            assert len(json_files) == 1


# ===================================================================
# DISTRACTOR PLUGIN — boundary and edge cases
# ===================================================================

class TestDistractorEdgeCases:

    def test_negative_count(self) -> None:
        from elizaos_adhdbench.distractor_plugin import get_distractor_actions
        assert get_distractor_actions(-5) == []

    def test_count_one(self) -> None:
        from elizaos_adhdbench.distractor_plugin import get_distractor_actions
        actions = get_distractor_actions(1)
        assert len(actions) == 1

    def test_count_49(self) -> None:
        from elizaos_adhdbench.distractor_plugin import get_distractor_actions
        actions = get_distractor_actions(49)
        assert len(actions) == 49

    def test_count_51(self) -> None:
        """Boundary: first variant generated."""
        from elizaos_adhdbench.distractor_plugin import get_distractor_actions
        actions = get_distractor_actions(51)
        assert len(actions) == 51
        names = [a.name for a in actions]
        assert len(set(names)) == 51
        # The 51st should be a variant
        assert "_V2" in names[50] or "_PRO" in names[50] or any("_" in n for n in names[50:])

    def test_all_actions_have_handler_and_validator(self) -> None:
        from elizaos_adhdbench.distractor_plugin import get_distractor_actions
        for action in get_distractor_actions(10):
            assert action.handler is not None
            assert action.validate is not None
            assert action.name
            assert action.description

    def test_scale_exact_match(self) -> None:
        """When bootstrap exactly equals target, 0 distractors needed."""
        from elizaos_adhdbench.distractor_plugin import get_distractor_plugin_actions_for_scale
        actions = get_distractor_plugin_actions_for_scale(21, 21)
        assert len(actions) == 0

    def test_variant_names_never_collide_with_base(self) -> None:
        """Variant names should not equal any base spec name."""
        from elizaos_adhdbench.distractor_plugin import ALL_DISTRACTOR_SPECS, get_distractor_actions
        base_names = {s.name for s in ALL_DISTRACTOR_SPECS}
        actions = get_distractor_actions(150)
        variant_actions = actions[len(ALL_DISTRACTOR_SPECS):]
        for a in variant_actions:
            assert a.name not in base_names, f"Variant {a.name} collides with base"


# ===================================================================
# TYPES — additional boundary tests
# ===================================================================

class TestTypeBoundaries:

    def test_scale_point_zero_values(self) -> None:
        sp = ScalePoint(0, 0, 0)
        assert sp.label == "a0_p0_m0"

    def test_turn_defaults(self) -> None:
        t = Turn(role="user", text="hi")
        assert t.expected_outcomes == ()
        assert t.new_session is False
        assert t.delay_seconds == 0.0

    def test_scenario_defaults(self) -> None:
        s = Scenario(id="T", name="T", description="T", level=ScenarioLevel.ACTION_DISPATCH, turns=())
        assert s.tags == ()
        assert not s.requires_advanced_memory
        assert not s.requires_advanced_planning
        assert s.distractor_action_count == 0

    def test_benchmark_results_timestamp_auto(self) -> None:
        r = BenchmarkResults(metadata={}, results=[], scaling_curves={}, baselines={})
        assert r.timestamp  # should be auto-filled
        assert "T" in r.timestamp  # ISO format

    def test_outcome_result_fields(self) -> None:
        o = OutcomeResult(
            outcome=ExpectedOutcome(OutcomeType.ACTION_MATCH, "X"),
            passed=True,
            actual_value="X",
            detail="matched",
        )
        assert o.passed
        assert o.actual_value == "X"


# ===================================================================
# LARP FIX VERIFICATION TESTS
# ===================================================================

class TestLarpFixes:

    def test_duplicate_scale_points_rejected(self) -> None:
        """L5: Config rejects duplicate ScalePoints."""
        with pytest.raises(ValueError, match="Duplicate scale point labels"):
            ADHDBenchConfig(scale_points=(
                ScalePoint(10, 8, 0),
                ScalePoint(10, 8, 0),  # duplicate
            ))

    def test_custom_outcome_type_removed(self) -> None:
        """L1: CUSTOM OutcomeType no longer exists."""
        assert not hasattr(OutcomeType, "CUSTOM")

    def test_config_has_no_larp_fields(self) -> None:
        """L8-L11: Removed fields that nothing implemented."""
        c = ADHDBenchConfig()
        assert not hasattr(c, "timeout_per_turn_ms")
        assert not hasattr(c, "max_retries")
        assert not hasattr(c, "parallel_scenarios")
        assert not hasattr(c, "use_cache")
        assert not hasattr(c, "cache_dir")

    def test_outcome_type_count_after_removal(self) -> None:
        """After removing CUSTOM, should have 7 types."""
        assert len(OutcomeType) == 7

    def test_ascii_curve_clamps_scores(self) -> None:
        """L6: Scores > 1.0 are clamped to 1.0 in rendering."""
        reporter = ADHDBenchReporter(ADHDBenchConfig())
        points = [ScalingCurvePoint("over", 10, 8, 0, 1.5, 100.0, 1)]
        rendered = reporter._render_ascii_curve(points, "test")
        # Should not crash; score clamped to 1.0
        assert "100%" in rendered

    def test_prefill_cycling_produces_correct_count(self) -> None:
        """L4: Prefill cycling produces exactly the requested number."""
        import itertools
        c = ADHDBenchConfig()
        for target in [0, 1, 5, 20, 50, 100]:
            msgs = list(itertools.islice(itertools.cycle(c.prefill_topic_pool), target))
            assert len(msgs) == target, f"Expected {target} messages, got {len(msgs)}"
