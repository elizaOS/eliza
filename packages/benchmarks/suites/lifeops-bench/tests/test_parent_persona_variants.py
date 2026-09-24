"""Structural and real-LifeWorld checks for the parent counterfactual scenario matrix."""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace

from eliza_lifeops_bench.__main__ import _build_world_factory
from eliza_lifeops_bench.agents import PerfectAgent, WrongAgent
from eliza_lifeops_bench.runner import (
    LifeOpsBenchRunner,
    _execute_action,
    build_tool_manifest,
    state_hash,
    supported_actions,
)
from eliza_lifeops_bench.scenarios._personas import ALL_PERSONAS
from eliza_lifeops_bench.scenarios.parent_persona_variants import (
    DEFAULT_PARENT_POLICY_CRITERIA,
    PARENT_PERSONA_VARIANT_MATRIX,
    PARENT_PERSONA_VARIANT_SCENARIOS,
    PARENT_PERSONA_VARIANTS_BY_AXIS,
    REQUIRED_PARENT_PERSONA_AXES,
)
from eliza_lifeops_bench.scorer import score_scenario
from eliza_lifeops_bench.types import Action, ScenarioMode, ScenarioResult


EXPECTED_EDGE_COVERAGE = {
    "rotating_shift_hourly": {
        "ambiguity",
        "mid_thread_correction",
        "source_degradation",
    },
    "single_rural_transit_limited": {"ambiguity", "source_degradation"},
    "high_conflict_survivor_coparent": {
        "ambiguity",
        "adversarial_instruction",
        "source_degradation",
        "consent_boundary",
    },
    "father_default_parent": {"ambiguity", "mid_thread_correction"},
    "nonbinary_default_parent": {
        "ambiguity",
        "mid_thread_correction",
        "adversarial_instruction",
    },
    "limited_english_low_literacy_voice_first": {
        "ambiguity",
        "mid_thread_correction",
        "source_degradation",
    },
    "disability_iep_access_needs": {
        "ambiguity",
        "mid_thread_correction",
        "source_degradation",
    },
    "multi_parent_guardian": {
        "ambiguity",
        "adversarial_instruction",
        "consent_boundary",
    },
    "teen_privacy": {
        "ambiguity",
        "adversarial_instruction",
        "consent_boundary",
    },
}


def _world():
    return _build_world_factory()(2026, "2026-05-10T12:00:00Z")


def _action_scaffold(variant):
    return replace(
        variant.scenario,
        id=f"{variant.scenario.id}.action_scaffold",
        mode=ScenarioMode.STATIC,
        ground_truth_actions=list(variant.context_actions),
        required_outputs=[],
        success_criteria=[],
        world_assertions=[],
        disruptions=[],
        expected_world_mutation="unchanged",
        opening_mode="authored",
    )


def test_matrix_covers_every_parent_axis_with_unique_live_scenarios() -> None:
    assert {variant.axis for variant in PARENT_PERSONA_VARIANT_MATRIX} == set(
        REQUIRED_PARENT_PERSONA_AXES
    )
    assert len(PARENT_PERSONA_VARIANT_MATRIX) == len(REQUIRED_PARENT_PERSONA_AXES)
    assert PARENT_PERSONA_VARIANT_SCENARIOS == [
        variant.scenario for variant in PARENT_PERSONA_VARIANT_MATRIX
    ]
    assert set(PARENT_PERSONA_VARIANTS_BY_AXIS) == set(REQUIRED_PARENT_PERSONA_AXES)

    scenario_ids = [variant.scenario.id for variant in PARENT_PERSONA_VARIANT_MATRIX]
    persona_ids = [
        variant.scenario.persona.id for variant in PARENT_PERSONA_VARIANT_MATRIX
    ]
    assert len(scenario_ids) == len(set(scenario_ids))
    assert len(persona_ids) == len(set(persona_ids))

    for variant in PARENT_PERSONA_VARIANT_MATRIX:
        scenario = variant.scenario
        assert scenario.mode is ScenarioMode.LIVE
        assert scenario.opening_mode == "simulated"
        assert scenario.first_question_fallback is None
        assert scenario.required_outputs == []
        assert scenario.world_seed == 2026
        assert scenario.max_turns >= 20
        assert scenario.tier == "T4"
        assert scenario.ground_truth_actions == []
        assert variant.context_actions
        assert scenario.success_criteria
        assert scenario.world_assertions
        assert scenario.disruptions
        assert scenario.trusted_evidence_requirement is None


def test_persona_catalog_contains_every_counterfactual_persona() -> None:
    catalog_by_id = {persona.id: persona for persona in ALL_PERSONAS}
    assert len(catalog_by_id) == len(ALL_PERSONAS)

    for variant in PARENT_PERSONA_VARIANT_MATRIX:
        persona = variant.scenario.persona
        assert catalog_by_id[persona.id] is persona
        assert len(persona.traits) >= 4
        assert persona.background
        assert persona.communication_style
        assert persona.patience_turns >= 16


def test_edge_and_safety_contracts_are_first_class_matrix_data() -> None:
    assert set(EXPECTED_EDGE_COVERAGE) == set(REQUIRED_PARENT_PERSONA_AXES)

    for variant in PARENT_PERSONA_VARIANT_MATRIX:
        assert EXPECTED_EDGE_COVERAGE[variant.axis] <= set(variant.edge_conditions)
        assert variant.safety_criteria
        assert all(
            criterion in variant.scenario.success_criteria
            for criterion in variant.safety_criteria
        )
        assert len(variant.scenario.success_criteria) > len(variant.safety_criteria)
        assert len(variant.scenario.world_assertions) >= 3
        assert all(
            1 <= disruption.at_turn < variant.scenario.max_turns
            and disruption.note_for_user
            for disruption in variant.scenario.disruptions
        )


def test_default_parent_counterfactuals_share_policy_and_action_contract() -> None:
    father = PARENT_PERSONA_VARIANTS_BY_AXIS["father_default_parent"]
    nonbinary = PARENT_PERSONA_VARIANTS_BY_AXIS["nonbinary_default_parent"]

    assert father.policy_equivalence_key == "default_parent_counterfactual"
    assert nonbinary.policy_equivalence_key == father.policy_equivalence_key
    assert father.context_actions == nonbinary.context_actions
    assert all(
        criterion in father.scenario.success_criteria
        and criterion in nonbinary.scenario.success_criteria
        for criterion in DEFAULT_PARENT_POLICY_CRITERIA
    )
    assert father.scenario.persona.id != nonbinary.scenario.persona.id


def test_actions_use_supported_tool_shapes_and_seeded_world_references() -> None:
    world = _world()
    manifest = {
        tool["function"]["name"]: tool["function"]["parameters"]
        for tool in build_tool_manifest(world)
    }
    executable = supported_actions()
    discriminator_by_action = {
        "CALENDAR": "subaction",
        "CALENDAR_SOURCES": "operation",
        "ENTITY": "subaction",
        "MESSAGE": "operation",
    }

    for variant in PARENT_PERSONA_VARIANT_MATRIX:
        for reference in variant.world_references:
            collection = getattr(world, reference.collection)
            assert reference.entity_id in collection

        for action in variant.context_actions:
            assert action.name in executable
            schema = manifest[action.name]
            assert set(schema.get("required", ())) <= set(action.kwargs)
            discriminator = discriminator_by_action[action.name]
            assert discriminator in action.kwargs
            allowed = schema["properties"][discriminator]["enum"]
            assert action.kwargs[discriminator] in allowed


def test_every_expected_action_executes_against_a_fresh_real_snapshot() -> None:
    for variant in PARENT_PERSONA_VARIANT_MATRIX:
        world = _world()
        before = state_hash(world)
        results = [_execute_action(action, world) for action in variant.context_actions]

        assert results
        assert all(result.get("ok") is not False for result in results)
        assert state_hash(world) == before


def test_perfect_agent_replays_each_supported_action_then_terminates() -> None:
    async def replay() -> None:
        for variant in PARENT_PERSONA_VARIANT_MATRIX:
            scenario = _action_scaffold(variant)
            world = _world()
            agent = PerfectAgent(scenario)
            tool_call_ids: set[str] = set()

            for expected in scenario.ground_truth_actions:
                turn = await agent([], build_tool_manifest(world))
                assert turn.tool_calls is not None
                assert len(turn.tool_calls) == 1
                tool_call = turn.tool_calls[0]
                assert tool_call["id"] not in tool_call_ids
                tool_call_ids.add(tool_call["id"])
                function = tool_call["function"]
                actual = Action(
                    name=function["name"],
                    kwargs=json.loads(function["arguments"]),
                )
                assert actual == expected
                result = _execute_action(actual, world)
                assert result.get("ok") is not False

            terminal = await agent([], build_tool_manifest(world))
            assert terminal.tool_calls == []
            assert terminal.content

    asyncio.run(replay())


def test_action_scaffolds_preserve_perfect_one_wrong_zero_scores() -> None:
    scaffolds = [_action_scaffold(variant) for variant in PARENT_PERSONA_VARIANT_MATRIX]

    async def score(agent_factory):
        runner = LifeOpsBenchRunner(
            agent_factory=agent_factory,
            world_factory=_build_world_factory(),
            scenarios=scaffolds,
            concurrency=1,
            seeds=1,
            max_cost_usd=1.0,
            per_scenario_timeout_s=15,
            static_grading_mode="offline_conformance",
        )
        result = await runner.run_all()
        return [scenario_result.total_score for scenario_result in result.scenarios]

    perfect_scores = asyncio.run(score(lambda scenario: PerfectAgent(scenario)))
    wrong_scores = asyncio.run(
        score(lambda scenario: WrongAgent(scenario, mode="garbage_text"))
    )

    assert perfect_scores == [1.0] * len(scaffolds)
    assert wrong_scores == [0.0] * len(scaffolds)


def test_wrong_agent_response_cannot_pass_live_satisfaction_gate() -> None:
    async def exercise() -> None:
        for variant in PARENT_PERSONA_VARIANT_MATRIX:
            scenario = variant.scenario
            turn = await WrongAgent(
                scenario=scenario,
                mode="garbage_text",
            )([], [])
            assert turn.tool_calls == []
            assert turn.content

            result = ScenarioResult(
                scenario_id=scenario.id,
                seed=2026,
                static_grading_mode=None,
                turns=[],
                state_hash_match=True,
                output_substring_matches=[],
                total_score=0.0,
                max_score=1.0,
                terminated_reason="respond",
                total_cost_usd=0.0,
                total_latency_ms=0,
            )
            assert score_scenario(result, scenario) == 0.0

    asyncio.run(exercise())
