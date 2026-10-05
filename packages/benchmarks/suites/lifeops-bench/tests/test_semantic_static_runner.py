"""Semantic STATIC execution with deterministic clients at the model boundary."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from eliza_lifeops_bench.clients.base import (
    BaseClient,
    ClientCall,
    ClientResponse,
    Usage,
)
from eliza_lifeops_bench.evaluator import LifeOpsEvaluator
from eliza_lifeops_bench.lifeworld import LifeWorld
from eliza_lifeops_bench.runner import (
    LifeOpsBenchRunner,
    _has_complete_static_semantic_trace,
    _opening_leaks_hidden_goal,
)
from eliza_lifeops_bench.scenarios import (
    CORE_SCENARIOS,
    EDGE_EXPANDED_SCENARIOS,
    EDGE_VARIANTS,
)
from eliza_lifeops_bench.types import (
    BenchmarkResult,
    Disruption,
    Domain,
    MessageTurn,
    Persona,
    Scenario,
    ScenarioMode,
)


class _FixedClient(BaseClient):
    """Return one fixed model response while retaining the exact call."""

    def __init__(self, model_name: str, content: str) -> None:
        self.model_name = model_name
        self.content = content
        self.calls: list[ClientCall] = []

    async def complete(self, call: ClientCall) -> ClientResponse:
        self.calls.append(call)
        return ClientResponse(
            content=self.content,
            tool_calls=[],
            finish_reason="stop",
            usage=Usage(prompt_tokens=10, completion_tokens=5, total_tokens=15),
            latency_ms=1,
            cost_usd=0.001,
            raw_provider_response={"fixture": True},
        )


_PERSONA = Persona(
    id="semantic_runner",
    name="Mara",
    traits=["busy", "informal"],
    background="A parent coordinating a crowded weekday.",
    communication_style="short mobile messages with occasional fragments",
)


def _scenario(*, opening_mode: str = "simulated") -> Scenario:
    return Scenario(
        id="semantic.static.fixture",
        name="semantic static fixture",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction=(
            "Confirm that the pediatric appointment is tomorrow at 2:30 PM "
            "without changing the calendar."
        ),
        ground_truth_actions=[],
        required_outputs=["the appointment remains tomorrow at 2:30 PM"],
        first_question_fallback=None,
        world_seed=9,
        max_turns=2,
        expected_world_mutation="unchanged",
        opening_mode=opening_mode,  # type: ignore[arg-type]
        opening_challenge=(
            "Use an indirect referent and withhold the appointment type until asked."
        ),
    )


def _world(seed: int, now_iso: str) -> LifeWorld:
    return LifeWorld(seed=seed, now_iso=now_iso)


def _evaluator(
    *,
    opening: str,
    criterion_met: bool,
    response_quote: str,
) -> tuple[LifeOpsEvaluator, _FixedClient, _FixedClient]:
    sim = _FixedClient("persona-model", opening)
    judge = _FixedClient(
        "independent-judge",
        (
            '{"criteria": [{"id": "output_1", '
            f'"met": {str(criterion_met).lower()}, '
            '"evidence_line_id": "executor-1", '
            f'"evidence": "{response_quote}"}}], '
            f'"satisfied": {str(criterion_met).lower()}, '
            '"reason": "fixture semantic verdict"}'
        ),
    )
    return LifeOpsEvaluator(sim, judge), sim, judge


async def _run_static(
    *,
    scenario: Scenario,
    response: str,
    evaluator: LifeOpsEvaluator,
) -> tuple[Any, list[str]]:
    openings: list[str] = []

    async def agent(
        history: list[MessageTurn],
        _tools: list[dict[str, Any]],
    ) -> MessageTurn:
        openings.append(history[0].content)
        return MessageTurn(role="assistant", content=response)

    runner = LifeOpsBenchRunner(
        agent_fn=agent,
        world_factory=_world,
        scenarios=[scenario],
        evaluator=evaluator,
        concurrency=1,
        seeds=1,
        max_cost_usd=10.0,
        static_grading_mode="semantic",
    )
    return await runner.run_one(scenario, scenario.world_seed), openings


def test_semantic_static_accepts_paraphrase_without_string_matching() -> None:
    scenario = _scenario()
    evaluator, sim, judge = _evaluator(
        opening="Could you double-check that kid thing tomorrow? The afternoon one.",
        criterion_met=True,
        response_quote="half past two tomorrow",
    )
    result, openings = asyncio.run(
        _run_static(
            scenario=scenario,
            response="It is still set for half past two tomorrow.",
            evaluator=evaluator,
        )
    )

    assert result.total_score == pytest.approx(1.0)
    assert result.output_substring_matches == []
    assert result.static_grading_mode == "semantic"
    assert [entry.judge_kind for entry in result.evaluator_trace] == [
        None,
        "static_semantic",
    ]
    assert scenario.instruction not in openings[0]
    assert sim.calls
    assert scenario.opening_challenge in sim.calls[0].messages[0]["content"]
    assert judge.calls
    assert _has_complete_static_semantic_trace(result, scenario) is True

    verdicts = result.evaluator_trace[-1].criterion_verdicts
    assert verdicts is not None
    verdicts.append(dict(verdicts[0]))
    assert _has_complete_static_semantic_trace(result, scenario) is False


def test_semantic_static_rejects_keyword_stuffing_and_wrong_fact() -> None:
    scenario = _scenario()
    evaluator, _sim, _judge = _evaluator(
        opening="Can you check that afternoon appointment?",
        criterion_met=False,
        response_quote="2:30 PM",
    )
    result, _openings = asyncio.run(
        _run_static(
            scenario=scenario,
            response=(
                "The words 2:30 PM appear here, but the appointment is actually "
                "at 9:00 PM."
            ),
            evaluator=evaluator,
        )
    )

    assert result.total_score == pytest.approx(0.0)
    assert result.output_substring_matches == []
    verdict = result.evaluator_trace[-1]
    assert verdict.judge_kind == "static_semantic"
    assert verdict.criterion_verdicts is not None
    assert verdict.criterion_verdicts[0]["met"] is False


def test_static_authored_opening_does_not_call_persona_model() -> None:
    scenario = _scenario(opening_mode="authored")
    evaluator, sim, _judge = _evaluator(
        opening="this response must never be used",
        criterion_met=True,
        response_quote="remains tomorrow at 2:30 PM",
    )
    result, openings = asyncio.run(
        _run_static(
            scenario=scenario,
            response="Confirmed: it remains tomorrow at 2:30 PM.",
            evaluator=evaluator,
        )
    )

    assert result.total_score == pytest.approx(1.0)
    assert sim.calls == []
    assert scenario.instruction in openings[0]


@pytest.mark.parametrize(
    ("opening", "leaks"),
    [
        (
            "Please help: Confirm that the pediatric appointment is tomorrow "
            "at 2:30 PM without changing the calendar.",
            True,
        ),
        (
            "Confirm that the dental appointment is tomorrow at 2:30 PM "
            "without changing the calendar.",
            True,
        ),
        ("Could you check the kid thing tomorrow afternoon?", False),
    ],
)
def test_hidden_goal_leak_detector_rejects_wrappers_and_near_copies(
    opening: str,
    leaks: bool,
) -> None:
    assert _opening_leaks_hidden_goal(opening, _scenario().instruction) is leaks


def test_runner_rejects_near_verbatim_generated_opening_before_agent_call() -> None:
    scenario = _scenario()
    evaluator, _sim, _judge = _evaluator(
        opening=(
            "Confirm that the dental appointment is tomorrow at 2:30 PM "
            "without changing the calendar."
        ),
        criterion_met=True,
        response_quote="2:30 PM",
    )
    agent_called = False

    async def agent(
        _history: list[MessageTurn],
        _tools: list[dict[str, Any]],
    ) -> MessageTurn:
        nonlocal agent_called
        agent_called = True
        return MessageTurn(role="assistant", content="done")

    runner = LifeOpsBenchRunner(
        agent_fn=agent,
        world_factory=_world,
        scenarios=[scenario],
        evaluator=evaluator,
    )
    with pytest.raises(ValueError, match="exposed the hidden goal"):
        asyncio.run(runner.run_one(scenario, scenario.world_seed))
    assert agent_called is False


def test_edge_variants_preserve_hidden_goal_and_use_dynamic_challenges() -> None:
    by_id = {scenario.id: scenario for scenario in CORE_SCENARIOS}
    challenge_ids = {variant_id for variant_id, _description, _prompt in EDGE_VARIANTS}

    assert challenge_ids == {
        "vague",
        "referential",
        "correction",
        "colloquial",
        "noisy",
        "code-switch",
        "underspecified",
        "stressed",
        "relative-time",
        "handoff",
    }
    for variant in EDGE_EXPANDED_SCENARIOS:
        base_id, marker, challenge_id = variant.id.rpartition("--edge-")
        assert marker
        base = by_id[base_id]
        assert challenge_id in challenge_ids
        assert variant.instruction == base.instruction
        assert variant.opening_mode == "simulated"
        assert variant.opening_challenge
        assert "{instruction}" not in variant.opening_challenge


def test_invalid_disruption_fails_instead_of_emitting_false_note() -> None:
    scenario = _scenario(opening_mode="authored")

    async def agent(
        _history: list[MessageTurn],
        _tools: list[dict[str, Any]],
    ) -> MessageTurn:
        return MessageTurn(role="assistant", content="done")

    runner = LifeOpsBenchRunner(
        agent_fn=agent,
        world_factory=_world,
        scenarios=[scenario],
        static_grading_mode="offline_conformance",
    )
    disruption = Disruption(
        at_turn=1,
        kind="calendar_change",
        payload={"event_id": "missing", "action": "cancel"},
        note_for_user="It was cancelled.",
    )
    with pytest.raises(KeyError):
        asyncio.run(
            runner._apply_disruptions([disruption], _world(9, scenario.now_iso))
        )


def test_publish_rejects_missing_semantic_judge_coverage(tmp_path: Path) -> None:
    result = BenchmarkResult(
        scenarios=[],
        pass_at_1=0.0,
        pass_at_k=0.0,
        mean_score_per_domain={},
        total_cost_usd=0.0,
        total_latency_ms=0,
        model_name="persona-model",
        judge_model_name="independent-judge",
        timestamp="2026-07-27T00:00:00Z",
        seeds=1,
        agent_model_name="executor-model",
        agent_adapter="fixture",
        agent_provider="fixture",
        expected_run_count=1,
        completed_run_count=1,
        successful_run_count=1,
        complete=True,
        workload_sha256="a" * 64,
        evaluator_provider="fixture",
        judge_provider="fixture",
        static_grading_mode="semantic",
        static_run_count=1,
        semantic_static_run_count=1,
        semantic_static_judged_count=0,
    )

    with pytest.raises(RuntimeError, match="semantic judge coverage"):
        LifeOpsBenchRunner.save_results(result, output_dir=str(tmp_path))

    offline = replace(
        result,
        static_grading_mode="offline_conformance",
        semantic_static_run_count=0,
    )
    with pytest.raises(RuntimeError, match="offline_conformance"):
        LifeOpsBenchRunner.save_results(offline, output_dir=str(tmp_path))
