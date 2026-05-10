"""Scaffold smoke tests — confirm the package imports and core types instantiate."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest


def test_package_imports() -> None:
    import eliza_lifeops_bench

    assert hasattr(eliza_lifeops_bench, "LifeOpsBenchRunner")
    assert hasattr(eliza_lifeops_bench, "Scenario")
    assert hasattr(eliza_lifeops_bench, "BenchmarkResult")


def test_core_types_instantiate() -> None:
    from eliza_lifeops_bench import (
        Action,
        BenchmarkResult,
        Domain,
        FirstQuestionFallback,
        MessageTurn,
        Persona,
        Scenario,
        ScenarioMode,
    )

    action = Action(name="calendar.create_event", kwargs={"title": "test"})
    assert action.name == "calendar.create_event"
    assert action.kwargs["title"] == "test"

    fallback = FirstQuestionFallback(
        canned_answer="primary",
        applies_when="agent asks for calendar",
    )

    persona = Persona(
        id="p1",
        name="Tester",
        traits=["concise"],
        background="bg",
        communication_style="terse",
    )

    scenario = Scenario(
        id="s1",
        name="test",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=persona,
        instruction="do thing",
        ground_truth_actions=[action],
        required_outputs=["done"],
        first_question_fallback=fallback,
        world_seed=42,
    )
    assert scenario.id == "s1"
    assert scenario.mode is ScenarioMode.STATIC

    turn = MessageTurn(role="assistant", content="ok")
    assert turn.role == "assistant"

    result = BenchmarkResult(
        scenarios=[],
        pass_at_1=0.0,
        pass_at_k=0.0,
        mean_score_per_domain={},
        total_cost_usd=0.0,
        total_latency_ms=0,
        model_name="gpt-oss-120b",
        judge_model_name="claude-opus-4-7",
        timestamp="2026-05-10T00:00:00Z",
        seeds=1,
    )
    assert result.seeds == 1


def test_smoke_scenarios_load() -> None:
    from eliza_lifeops_bench.scenarios import (
        ALL_SCENARIOS,
        SCENARIOS_BY_DOMAIN,
        SCENARIOS_BY_ID,
    )
    from eliza_lifeops_bench.types import Domain, ScenarioMode

    assert len(ALL_SCENARIOS) >= 2
    assert "smoke_static_calendar_01" in SCENARIOS_BY_ID
    assert "smoke_live_mail_01" in SCENARIOS_BY_ID

    static = SCENARIOS_BY_ID["smoke_static_calendar_01"]
    live = SCENARIOS_BY_ID["smoke_live_mail_01"]
    assert static.mode is ScenarioMode.STATIC
    assert live.mode is ScenarioMode.LIVE
    assert static.first_question_fallback is not None

    assert Domain.CALENDAR in SCENARIOS_BY_DOMAIN
    assert Domain.MAIL in SCENARIOS_BY_DOMAIN


def test_runner_instantiates_with_noop_agent_fn() -> None:
    from eliza_lifeops_bench import LifeOpsBenchRunner, MessageTurn
    from eliza_lifeops_bench.scenarios import ALL_SCENARIOS

    noop_agent_fn = AsyncMock(return_value=MessageTurn(role="assistant", content=""))

    def world_factory(seed: int) -> object:
        raise NotImplementedError("LifeWorld stub — not invoked by this test")

    runner = LifeOpsBenchRunner(
        agent_fn=noop_agent_fn,
        world_factory=world_factory,  # type: ignore[arg-type]
        scenarios=ALL_SCENARIOS,
        concurrency=2,
        seeds=1,
        max_cost_usd=0.01,
        per_scenario_timeout_s=5,
    )
    assert runner.concurrency == 2
    assert runner.seeds == 1
    assert len(runner.scenarios) == len(ALL_SCENARIOS)
    assert runner.evaluator_model == "gpt-oss-120b"
    assert runner.judge_model == "claude-opus-4-7"


def test_pass_at_k_formula() -> None:
    from eliza_lifeops_bench.scorer import pass_at_k

    assert pass_at_k(c=0, n=10, k=1) == 0.0
    assert pass_at_k(c=10, n=10, k=1) == 1.0
    # 5 correct of 10, k=1 → 50% chance one sample is correct
    assert pass_at_k(c=5, n=10, k=1) == pytest.approx(0.5)
    # 1 correct of 10, k=10 → certain to include it
    assert pass_at_k(c=1, n=10, k=10) == 1.0


def test_compare_actions_partial_credit() -> None:
    from eliza_lifeops_bench.scorer import compare_actions
    from eliza_lifeops_bench.types import Action

    gt = [Action(name="calendar.create_event", kwargs={"title": "x", "duration": 30})]
    exact = [Action(name="calendar.create_event", kwargs={"title": "x", "duration": 30})]
    arg_mismatch = [Action(name="calendar.create_event", kwargs={"title": "y"})]
    wrong_name = [Action(name="mail.send", kwargs={})]

    assert compare_actions(exact, gt) == 1.0
    assert compare_actions(arg_mismatch, gt) == 0.5
    assert compare_actions(wrong_name, gt) == 0.0
    assert compare_actions([], []) == 1.0
    assert compare_actions([Action(name="foo", kwargs={})], []) == 0.0
