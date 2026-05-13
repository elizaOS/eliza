"""Tests for the Wave 2B live (dual-agent) scenario corpus.

Covers:

* Loading + shape: ``ALL_LIVE_SCENARIOS`` is at least the 15-scenario
  baseline, every entry is LIVE, has empty ``ground_truth_actions``, a
  populated persona, populated ``success_criteria``, and a valid world seed.
* Evaluator construction: the simulated-user client and the judge client
  must be different instances and have different model identifiers, to
  prevent self-agreement bias.
* Mocked end-to-end: a fake-agent ``agent_fn`` plus a mocked judge that
  always returns satisfied=true exits the runner with
  ``terminated_reason="satisfied"``.
* Disruption injection: a scenario with ``Disruption(at_turn=3, kind=...)``
  mutates the world correctly between turns 3 and 4.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import pytest

from eliza_lifeops_bench.clients.base import (
    BaseClient,
    ClientCall,
    ClientResponse,
    Usage,
)
from eliza_lifeops_bench.evaluator import LifeOpsEvaluator
from eliza_lifeops_bench.lifeworld import EntityKind, LifeWorld
from eliza_lifeops_bench.lifeworld.entities import (
    Calendar,
    Conversation,
    EmailMessage,
    EmailThread,
    ReminderList,
)
from eliza_lifeops_bench.runner import LifeOpsBenchRunner
from eliza_lifeops_bench.scenarios.live import ALL_LIVE_SCENARIOS, LIVE_SCENARIOS_BY_ID
from eliza_lifeops_bench.types import (
    Disruption,
    Domain,
    MessageTurn,
    Persona,
    Scenario,
    ScenarioMode,
)


# ---------------------------------------------------------------------------
# Mocked client used by every test in this module — no real LLM traffic.
# ---------------------------------------------------------------------------


@dataclass
class _MockClient(BaseClient):
    """Returns a fixed ``ClientResponse`` for every call.

    ``model_name`` is set by the constructor so two instances can simulate
    different providers without going near a network.
    """

    model_name: str
    fixed_content: str = "OK"
    cost_usd: float = 0.0001
    call_count: int = 0
    last_call: ClientCall | None = None

    async def complete(self, call: ClientCall) -> ClientResponse:  # type: ignore[override]
        self.call_count += 1
        self.last_call = call
        return ClientResponse(
            content=self.fixed_content,
            tool_calls=[],
            finish_reason="stop",
            usage=Usage(prompt_tokens=10, completion_tokens=5, total_tokens=15),
            latency_ms=1,
            cost_usd=self.cost_usd,
            raw_provider_response={},
        )


def _make_evaluator(
    *,
    judge_says_yes: bool = False,
) -> tuple[LifeOpsEvaluator, _MockClient, _MockClient]:
    sim = _MockClient(
        model_name="mock-cerebras",
        fixed_content="alright, what's next?",
    )
    judge = _MockClient(
        model_name="mock-anthropic",
        fixed_content=(
            "YES: executor handled the request."
            if judge_says_yes
            else "NO: still waiting on follow-up."
        ),
    )
    return LifeOpsEvaluator(simulated_user_client=sim, judge_client=judge), sim, judge


# ---------------------------------------------------------------------------
# Loading + shape
# ---------------------------------------------------------------------------


def test_live_scenarios_meet_minimum_count() -> None:
    assert len(ALL_LIVE_SCENARIOS) >= 15, (
        f"Wave 2B baseline is 15 hand-authored live scenarios; "
        f"have {len(ALL_LIVE_SCENARIOS)}"
    )


def test_all_live_scenarios_have_unique_ids() -> None:
    ids = [s.id for s in ALL_LIVE_SCENARIOS]
    assert len(ids) == len(set(ids)), "duplicate live scenario ids"


def test_every_live_scenario_is_well_formed() -> None:
    bad: list[str] = []
    for scenario in ALL_LIVE_SCENARIOS:
        if scenario.mode is not ScenarioMode.LIVE:
            bad.append(f"{scenario.id}: mode is {scenario.mode}, expected LIVE")
        if scenario.ground_truth_actions:
            bad.append(
                f"{scenario.id}: live scenarios must have empty ground_truth_actions"
            )
        if not scenario.persona.id or not scenario.persona.name:
            bad.append(f"{scenario.id}: missing persona fields")
        if not scenario.persona.traits:
            bad.append(f"{scenario.id}: persona has no traits")
        if not scenario.persona.communication_style:
            bad.append(f"{scenario.id}: persona has no communication style")
        if not scenario.success_criteria:
            bad.append(
                f"{scenario.id}: live scenarios must declare success_criteria "
                "for the judge to use as evidence"
            )
        if not scenario.instruction.strip():
            bad.append(f"{scenario.id}: empty instruction")
        if scenario.world_seed not in (42, 2026):
            bad.append(
                f"{scenario.id}: world_seed {scenario.world_seed} not in "
                "(42, 2026); add a snapshot or pick an existing seed"
            )
        if scenario.max_turns < 5 or scenario.max_turns > 50:
            bad.append(
                f"{scenario.id}: max_turns {scenario.max_turns} out of [5, 50]"
            )
    assert not bad, "live scenario shape issues:\n" + "\n".join(bad)


def test_all_ten_domains_have_at_least_one_live_scenario() -> None:
    by_domain: dict[Domain, int] = {}
    for s in ALL_LIVE_SCENARIOS:
        by_domain[s.domain] = by_domain.get(s.domain, 0) + 1
    missing = [d.value for d in Domain if d not in by_domain]
    assert not missing, f"live corpus missing domains: {missing}"


def test_live_index_matches_list() -> None:
    assert set(LIVE_SCENARIOS_BY_ID) == {s.id for s in ALL_LIVE_SCENARIOS}


# ---------------------------------------------------------------------------
# Evaluator construction guards
# ---------------------------------------------------------------------------


def test_evaluator_rejects_same_client_instance() -> None:
    shared = _MockClient(model_name="mock-shared")
    with pytest.raises(ValueError, match="must be different instances"):
        LifeOpsEvaluator(simulated_user_client=shared, judge_client=shared)


def test_evaluator_rejects_same_model_identifier() -> None:
    a = _MockClient(model_name="same-model")
    b = _MockClient(model_name="same-model")
    with pytest.raises(ValueError, match="different model identifiers"):
        LifeOpsEvaluator(simulated_user_client=a, judge_client=b)


def test_evaluator_cost_ledger_splits_simulated_user_and_judge() -> None:
    evaluator, sim, judge = _make_evaluator(judge_says_yes=True)
    sim.cost_usd = 0.002
    judge.cost_usd = 0.005

    async def run() -> None:
        scenario = ALL_LIVE_SCENARIOS[0]
        await evaluator.simulate_user_turn(scenario, [], _empty_world())
        await evaluator.judge_satisfaction(scenario, [], _empty_world())

    asyncio.run(run())
    assert evaluator.simulated_user_cost_usd == pytest.approx(0.002)
    assert evaluator.judge_cost_usd == pytest.approx(0.005)
    assert evaluator.cost_usd == pytest.approx(0.007)


# ---------------------------------------------------------------------------
# End-to-end with mocked judge + fake agent
# ---------------------------------------------------------------------------


def _empty_world() -> LifeWorld:
    """Tiny world with the minimum entities the live scenarios reference."""
    world = LifeWorld(seed=2026, now_iso="2026-05-10T12:00:00Z")
    world.add(
        EntityKind.CALENDAR,
        Calendar(
            id="cal_main",
            name="Main",
            color="#000",
            owner="me@example.test",
            source="google",
            is_primary=True,
        ),
    )
    world.add(EntityKind.REMINDER_LIST, ReminderList(id="rl_main", name="Inbox"))
    world.add(
        EntityKind.CONVERSATION,
        Conversation(
            id="cv_main",
            channel="imessage",
            participants=["+15551111111", "+15552222222"],
            title=None,
            last_activity_at="2026-05-10T12:00:00Z",
            is_group=False,
        ),
    )
    return world


def _world_factory(seed: int, now_iso: str) -> LifeWorld:
    return _empty_world()


async def _agent_says_done(history: list[MessageTurn], tools: list[dict[str, Any]]) -> MessageTurn:
    return MessageTurn(role="assistant", content="Done!")


def test_runner_terminates_with_satisfied_when_judge_says_yes() -> None:
    """Mocked end-to-end: judge returns YES -> runner exits with terminated_reason='satisfied'."""
    evaluator, _sim, _judge = _make_evaluator(judge_says_yes=True)
    scenario = Scenario(
        id="live.test.fixture",
        name="fixture for runner termination",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.LIVE,
        persona=Persona(
            id="p_test",
            name="Test User",
            traits=["test"],
            background="test fixture",
            communication_style="terse",
        ),
        instruction="say done",
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=10,
        success_criteria=["executor says done"],
    )

    runner = LifeOpsBenchRunner(
        agent_fn=_agent_says_done,
        world_factory=_world_factory,
        scenarios=[scenario],
        concurrency=1,
        seeds=1,
        max_cost_usd=10.0,
        per_scenario_timeout_s=5,
        evaluator=evaluator,
        live_judge_min_turn=1,
    )
    result = asyncio.run(runner.run_one(scenario, scenario.world_seed))
    assert result.terminated_reason == "satisfied", (
        f"expected 'satisfied', got {result.terminated_reason!r} "
        f"(error={result.error!r})"
    )


def test_runner_raises_when_live_scenario_has_no_evaluator() -> None:
    scenario = ALL_LIVE_SCENARIOS[0]
    runner = LifeOpsBenchRunner(
        agent_fn=_agent_says_done,
        world_factory=_world_factory,
        scenarios=[scenario],
        concurrency=1,
        seeds=1,
        max_cost_usd=1.0,
        per_scenario_timeout_s=5,
    )
    with pytest.raises(RuntimeError, match="LIVE but no evaluator"):
        asyncio.run(runner.run_one(scenario, scenario.world_seed))


def test_runner_splits_agent_and_eval_cost_in_result() -> None:
    """The benchmark result must distinguish agent spend from evaluator spend."""
    evaluator, sim, judge = _make_evaluator(judge_says_yes=True)
    sim.cost_usd = 0.01
    judge.cost_usd = 0.02
    scenario = Scenario(
        id="live.test.cost_split",
        name="cost split fixture",
        domain=Domain.MAIL,
        mode=ScenarioMode.LIVE,
        persona=Persona(
            id="p_test",
            name="Test User",
            traits=["test"],
            background="test fixture",
            communication_style="terse",
        ),
        instruction="say done",
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        success_criteria=["executor says done"],
    )

    async def costed_agent(history, tools):
        turn = MessageTurn(role="assistant", content="Done!")
        turn.cost_usd = 0.05  # type: ignore[attr-defined]
        return turn

    runner = LifeOpsBenchRunner(
        agent_fn=costed_agent,
        world_factory=_world_factory,
        scenarios=[scenario],
        concurrency=1,
        seeds=1,
        max_cost_usd=10.0,
        per_scenario_timeout_s=5,
        evaluator=evaluator,
        live_judge_min_turn=1,
    )
    bench = asyncio.run(runner.run_filtered())
    assert bench.agent_cost_usd > 0, "agent cost ledger empty after live run"
    assert bench.eval_cost_usd > 0, "eval cost ledger empty after live run"
    assert bench.total_cost_usd == pytest.approx(
        bench.agent_cost_usd + bench.eval_cost_usd
    ), "total_cost_usd must equal agent + eval"


def test_live_evaluator_prompts_include_world_snapshot_and_heartbeat() -> None:
    evaluator, sim, judge = _make_evaluator(judge_says_yes=False)
    scenario = Scenario(
        id="live.test.prompt_snapshot",
        name="prompt snapshot fixture",
        domain=Domain.MAIL,
        mode=ScenarioMode.LIVE,
        persona=Persona(
            id="p_test",
            name="Test User",
            traits=["test"],
            background="test fixture",
            communication_style="terse",
        ),
        instruction="Watch for new mail and summarize it.",
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        success_criteria=["surface the latest inbox change"],
    )
    world = _empty_world()
    world.add(
        EntityKind.EMAIL,
        EmailMessage(
            id="email_prompt_snapshot",
            thread_id="thread_prompt_snapshot",
            folder="inbox",
            from_email="compliance@example.test",
            to_emails=["owner@example.test"],
            cc_emails=[],
            subject="URGENT: SOC2 audit evidence due today",
            body_plain="Please upload the evidence by 5pm.",
            sent_at="2026-05-10T11:50:00Z",
            received_at="2026-05-10T11:51:00Z",
            is_read=False,
            is_starred=False,
            labels=["urgent"],
            attachments=[],
        ),
    )

    async def run() -> None:
        await evaluator.simulate_user_turn(scenario, [], world)
        await evaluator.judge_satisfaction(scenario, [], world)

    asyncio.run(run())

    assert sim.last_call is not None
    assert judge.last_call is not None
    user_prompt = sim.last_call.messages[0]["content"]
    judge_prompt = judge.last_call.messages[0]["content"]
    assert "Live heartbeat: turn 1" in user_prompt
    assert "Benchmark clock: 2026-05-10T12:00:00Z" in user_prompt
    assert "URGENT: SOC2 audit evidence due today" in user_prompt
    assert "Live heartbeat: turn 1" in judge_prompt
    assert "Benchmark clock: 2026-05-10T12:00:00Z" in judge_prompt
    assert "URGENT: SOC2 audit evidence due today" in judge_prompt


def test_judge_parses_json_verdicts() -> None:
    evaluator, sim, judge = _make_evaluator(judge_says_yes=False)
    judge.fixed_content = '```json\n{"satisfied": true, "reason": "executor completed the task."}\n```'
    scenario = ALL_LIVE_SCENARIOS[0]

    async def run() -> tuple[bool, str]:
        await evaluator.simulate_user_turn(scenario, [], _empty_world())
        return await evaluator.judge_satisfaction(scenario, [], _empty_world())

    satisfied, reason = asyncio.run(run())
    assert satisfied is True
    assert "executor completed the task" in reason
    assert judge.last_call is not None
    assert "satisfied" in judge.last_call.messages[0]["content"].lower()


# ---------------------------------------------------------------------------
# Disruption injection
# ---------------------------------------------------------------------------


def test_disruption_mutates_world_between_named_turns() -> None:
    """A new_message disruption at turn 3 must add the email between turns 3 and 4."""
    captured_email_counts: list[int] = []

    async def counting_agent(history, tools):
        # snapshot the world's email count via the ambient closure-bound runner
        captured_email_counts.append(len(_world.emails))
        return MessageTurn(role="assistant", content="processing...")

    _world = _empty_world()

    def factory(seed: int, now_iso: str) -> LifeWorld:
        return _world

    evaluator, _sim, _judge = _make_evaluator(judge_says_yes=False)
    scenario = Scenario(
        id="live.test.disruption",
        name="disruption fixture",
        domain=Domain.MAIL,
        mode=ScenarioMode.LIVE,
        persona=Persona(
            id="p_test",
            name="Test User",
            traits=["test"],
            background="test fixture",
            communication_style="terse",
        ),
        instruction="watch for new mail",
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        success_criteria=["executor adapts"],
        disruptions=[
            Disruption(
                at_turn=3,
                kind="new_message",
                payload={
                    "message_id": "email_disrupt_test",
                    "thread_id": "thread_disrupt_test",
                    "from_email": "alert@example.test",
                    "subject": "incoming",
                    "body": "fyi",
                    "labels": ["urgent"],
                },
                note_for_user="[new urgent email]",
            ),
        ],
    )

    runner = LifeOpsBenchRunner(
        agent_fn=counting_agent,
        world_factory=factory,
        scenarios=[scenario],
        concurrency=1,
        seeds=1,
        max_cost_usd=10.0,
        per_scenario_timeout_s=5,
        evaluator=evaluator,
        live_judge_min_turn=99,  # never let the judge end the run
    )
    asyncio.run(runner.run_one(scenario, scenario.world_seed))

    # Agent-call N sees the world *before* turn N's disruption fires.
    # So turn 1, 2, 3 should see 0 emails, and turn 4 should see 1.
    assert len(captured_email_counts) >= 4, (
        f"agent called {len(captured_email_counts)} times; need >=4 to verify disruption"
    )
    assert captured_email_counts[0] == 0, "world started with non-empty inbox"
    assert captured_email_counts[2] == 0, (
        "disruption at_turn=3 must apply AFTER turn 3, not before"
    )
    assert captured_email_counts[3] == 1, (
        f"disruption did not insert the email by turn 4; "
        f"counts were {captured_email_counts}"
    )
    assert "email_disrupt_test" in _world.emails, "disruption payload not in world"


def test_live_disruption_is_visible_to_the_simulated_user_prompt() -> None:
    evaluator, sim, _judge = _make_evaluator(judge_says_yes=False)
    _world = _empty_world()

    def factory(seed: int, now_iso: str) -> LifeWorld:
        return _world

    scenario = Scenario(
        id="live.test.disruption_prompt",
        name="disruption prompt fixture",
        domain=Domain.MAIL,
        mode=ScenarioMode.LIVE,
        persona=Persona(
            id="p_test",
            name="Test User",
            traits=["test"],
            background="test fixture",
            communication_style="terse",
        ),
        instruction="Watch for urgent inbound mail.",
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=1,
        success_criteria=["surface the urgent email"],
        disruptions=[
            Disruption(
                at_turn=1,
                kind="new_message",
                payload={
                    "message_id": "email_disrupt_test",
                    "thread_id": "thread_disrupt_test",
                    "from_email": "alert@example.test",
                    "subject": "Disruption: urgent compliance update",
                    "body": "fyi",
                    "labels": ["urgent"],
                },
                note_for_user="[new urgent email]",
            ),
        ],
    )

    async def run() -> None:
        runner = LifeOpsBenchRunner(
            agent_fn=_agent_says_done,
            world_factory=factory,
            scenarios=[scenario],
            concurrency=1,
            seeds=1,
            max_cost_usd=10.0,
            per_scenario_timeout_s=5,
            evaluator=evaluator,
            live_judge_min_turn=99,
        )
        await runner.run_one(scenario, scenario.world_seed)

    asyncio.run(run())

    assert sim.last_call is not None
    prompt = sim.last_call.messages[0]["content"]
    assert "Live heartbeat: turn 2" in prompt
    assert "Disruption: urgent compliance update" in prompt
    assert "Benchmark clock: 2026-05-10T12:00:00Z" in prompt


def test_three_live_scenarios_use_a_disruption() -> None:
    """Spec requires at least 3 of the 15 live scenarios to exercise mid-run disruption."""
    with_disruption = [s for s in ALL_LIVE_SCENARIOS if s.disruptions]
    assert len(with_disruption) >= 3, (
        f"only {len(with_disruption)} live scenarios use a disruption; spec requires >= 3"
    )
