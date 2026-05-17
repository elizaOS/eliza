"""Cost + latency budget enforcement tests (Wave 3B).

The runner exposes ``max_cost_usd`` and ``per_scenario_timeout_s`` knobs
plus a Wave-3B-added ``abort_on_budget_exceeded`` switch. These tests
verify that:

1. ``per_scenario_timeout_s`` actually wraps each scenario via
   ``asyncio.wait_for`` and surfaces ``terminated_reason="timeout"``.
2. A single agent turn whose ``cost_usd`` blows the cap terminates the
   scenario with ``terminated_reason="cost_exceeded"`` and score 0.
3. With ``abort_on_budget_exceeded=True`` (the default), every scenario
   that hadn't started its agent_fn yet at the moment of cap-trip is
   reported as ``cost_exceeded`` and never invokes its agent.
4. Evaluator spend (simulated user + judge clients, used in LIVE mode)
   is charged against the same cap so the runner can't exit "under
   budget" while the judge ledger overflowed.

All four tests use fake agent_fn / fake clients — no real LLM calls.
"""

from __future__ import annotations

import asyncio
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
from eliza_lifeops_bench.lifeworld.entities import ReminderList
from eliza_lifeops_bench.runner import LifeOpsBenchRunner
from eliza_lifeops_bench.types import (
    Action,
    Domain,
    MessageTurn,
    Persona,
    Scenario,
    ScenarioMode,
)


# ---------------------------------------------------------------------------
# Shared fixtures: minimal scenarios + world factory the budget tests can use
# without depending on the static corpus or any snapshot file.
# ---------------------------------------------------------------------------


_PERSONA = Persona(
    id="budget",
    name="Budget Tester",
    traits=["scripted"],
    background="budget enforcement test fixture",
    communication_style="terse",
)


def _budget_world_factory(seed: int, now_iso: str) -> LifeWorld:
    """Trivial world — only what LIFE_CREATE/list_personal needs in case
    a fake agent fires that action. Most budget tests never get here, but
    we keep it consistent with the rest of the suite."""
    world = LifeWorld(seed=seed, now_iso=now_iso)
    world.add(EntityKind.REMINDER_LIST, ReminderList(id="list_personal", name="Personal"))
    return world


def _make_scenario(scenario_id: str, *, max_turns: int = 2) -> Scenario:
    """Build a tiny STATIC scenario the budget tests can run against.

    Ground-truth is a single REMINDER.create so PerfectAgent (when used)
    would score 1.0 — but the budget tests use fake agents that never
    actually run the script; they only need a structurally-valid scenario
    so the runner wraps them in `asyncio.wait_for` and the cost ledger
    fires.
    """
    return Scenario(
        id=scenario_id,
        name=scenario_id,
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="remind me",
        ground_truth_actions=[
            Action(
                name="REMINDER.create",
                kwargs={
                    "reminder_id": "rm_budget",
                    "list_id": "list_personal",
                    "title": "x",
                },
            )
        ],
        required_outputs=["done"],
        first_question_fallback=None,
        world_seed=999,
        max_turns=max_turns,
    )


def _make_turn(*, cost_usd: float = 0.0, content: str = "ok") -> MessageTurn:
    """Build an assistant MessageTurn with the runner's per-turn telemetry attrs.

    The runner reads ``cost_usd`` / ``latency_ms`` / ``input_tokens`` /
    ``output_tokens`` via ``getattr`` with a default of 0, so we set them
    directly as instance attributes.
    """
    turn = MessageTurn(role="assistant", content=content, tool_calls=None)
    turn.cost_usd = float(cost_usd)  # type: ignore[attr-defined]
    turn.latency_ms = 1  # type: ignore[attr-defined]
    turn.input_tokens = 0  # type: ignore[attr-defined]
    turn.output_tokens = 0  # type: ignore[attr-defined]
    return turn


# ---------------------------------------------------------------------------
# Test 1 — per-scenario timeout fires
# ---------------------------------------------------------------------------


async def test_per_scenario_timeout_aborts() -> None:
    """A long-running agent_fn must be cancelled after ``per_scenario_timeout_s``.

    The runner wraps ``run_one`` in ``asyncio.wait_for(timeout=…)``; on
    TimeoutError it returns a ``_failure_result`` with
    ``terminated_reason="timeout"``. We use a 1-second cap and an agent
    that sleeps 5 seconds.
    """
    invoked: list[int] = []

    async def slow_agent_fn(
        history: list[MessageTurn], tools: list[dict[str, Any]]
    ) -> MessageTurn:
        invoked.append(1)
        await asyncio.sleep(5.0)
        return _make_turn()

    scenario = _make_scenario("budget.timeout_scenario")
    runner = LifeOpsBenchRunner(
        agent_fn=slow_agent_fn,
        world_factory=_budget_world_factory,
        scenarios=[scenario],
        concurrency=1,
        seeds=1,
        max_cost_usd=1000.0,
        per_scenario_timeout_s=1,
    )

    result = await runner.run_filtered()

    assert len(result.scenarios) == 1
    sr = result.scenarios[0]
    assert sr.terminated_reason == "timeout", (
        f"expected timeout, got {sr.terminated_reason!r} (error={sr.error!r})"
    )
    assert sr.total_score == pytest.approx(0.0)
    # The agent_fn started but was cancelled; we don't strictly require
    # invocation count, only that the runner reported timeout.
    assert invoked, "slow agent_fn should have been entered before cancellation"


# ---------------------------------------------------------------------------
# Test 2 — single-scenario cost cap aborts mid-run
# ---------------------------------------------------------------------------


async def test_max_cost_usd_aborts_scenario() -> None:
    """An agent turn whose cost_usd exceeds the cap aborts with cost_exceeded.

    The runner charges ``getattr(agent_turn, "cost_usd", 0.0)`` against
    the global cap after every assistant turn, raising
    ``CostBudgetExceeded`` once the cumulative spend tops
    ``max_cost_usd``. ``_run_one_guarded`` translates that to a
    ``_failure_result(reason="cost_exceeded")``.
    """
    call_count = {"n": 0}

    async def expensive_agent_fn(
        history: list[MessageTurn], tools: list[dict[str, Any]]
    ) -> MessageTurn:
        call_count["n"] += 1
        return _make_turn(cost_usd=10.0)

    scenario = _make_scenario("budget.cost_scenario")
    runner = LifeOpsBenchRunner(
        agent_fn=expensive_agent_fn,
        world_factory=_budget_world_factory,
        scenarios=[scenario],
        concurrency=1,
        seeds=1,
        max_cost_usd=5.0,
        per_scenario_timeout_s=30,
    )

    result = await runner.run_filtered()

    assert len(result.scenarios) == 1
    sr = result.scenarios[0]
    assert sr.terminated_reason == "cost_exceeded", (
        f"expected cost_exceeded, got {sr.terminated_reason!r} (error={sr.error!r})"
    )
    assert sr.total_score == pytest.approx(0.0)
    # The agent was invoked at least once before the cap tripped.
    assert call_count["n"] >= 1
    # Aggregate cost ledger reflects the spend even though the per-scenario
    # failure result reports 0 cost (the failure-result builder is a static
    # method that doesn't see the runner's ledger). The runner overrides
    # bench_result.total_cost_usd with the agent + eval ledger total.
    assert result.total_cost_usd == pytest.approx(10.0)
    assert result.agent_cost_usd == pytest.approx(10.0)
    assert result.eval_cost_usd == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# Test 3 — abort flag short-circuits remaining scenarios
# ---------------------------------------------------------------------------


async def test_max_cost_usd_aborts_remaining_scenarios_when_flag_set() -> None:
    """With abort_on_budget_exceeded=True, scenarios queued behind the
    cap-tripping run never invoke their agent_fn.

    We hand the runner 5 scenarios and concurrency=1 so they execute
    serially. Scenario 0 burns past the cap. Scenarios 1..4 must come
    back as ``cost_exceeded`` with no agent invocations on the
    sentinel.
    """
    invoked_ids: list[str] = []

    async def expensive_agent_fn(
        history: list[MessageTurn], tools: list[dict[str, Any]]
    ) -> MessageTurn:
        # Capture the scenario instruction so we can confirm only the
        # first one ever entered the agent_fn.
        last_user = next(
            (t.content for t in reversed(history) if t.role == "user"), ""
        )
        invoked_ids.append(last_user)
        return _make_turn(cost_usd=10.0)

    scenarios = [_make_scenario(f"budget.serial_{i}") for i in range(5)]
    runner = LifeOpsBenchRunner(
        agent_fn=expensive_agent_fn,
        world_factory=_budget_world_factory,
        scenarios=scenarios,
        concurrency=1,
        seeds=1,
        max_cost_usd=5.0,
        per_scenario_timeout_s=30,
        abort_on_budget_exceeded=True,
    )

    result = await runner.run_filtered()

    assert len(result.scenarios) == 5
    # Every scenario should be marked cost_exceeded.
    reasons = [sr.terminated_reason for sr in result.scenarios]
    assert reasons == ["cost_exceeded"] * 5, reasons
    # Only ONE scenario actually drove the agent (the first one). The
    # remaining four were short-circuited by the abort flag.
    assert len(invoked_ids) == 1, (
        f"expected exactly 1 agent invocation, got {len(invoked_ids)}: {invoked_ids}"
    )
    assert all(sr.total_score == pytest.approx(0.0) for sr in result.scenarios)


async def test_no_abort_flag_lets_subsequent_scenarios_continue_charging() -> None:
    """With abort_on_budget_exceeded=False, the remaining scenarios still
    run and each independently trip the cap when they try to charge.

    This pairs with the abort-on test above — it confirms the flag
    actually controls behavior rather than being a no-op.
    """
    invoked_count = {"n": 0}

    async def expensive_agent_fn(
        history: list[MessageTurn], tools: list[dict[str, Any]]
    ) -> MessageTurn:
        invoked_count["n"] += 1
        return _make_turn(cost_usd=10.0)

    scenarios = [_make_scenario(f"budget.no_abort_{i}") for i in range(3)]
    runner = LifeOpsBenchRunner(
        agent_fn=expensive_agent_fn,
        world_factory=_budget_world_factory,
        scenarios=scenarios,
        concurrency=1,
        seeds=1,
        max_cost_usd=5.0,
        per_scenario_timeout_s=30,
        abort_on_budget_exceeded=False,
    )

    result = await runner.run_filtered()

    # All three still report cost_exceeded — the global cap stays tripped
    # so each per-scenario charge raises immediately. But unlike the
    # abort-on case, every scenario's agent_fn ran at least once first.
    reasons = [sr.terminated_reason for sr in result.scenarios]
    assert reasons == ["cost_exceeded"] * 3, reasons
    assert invoked_count["n"] >= 3, (
        f"expected each scenario to invoke its agent_fn at least once "
        f"with abort_on_budget_exceeded=False; got {invoked_count['n']}"
    )


# ---------------------------------------------------------------------------
# Test 4 — evaluator (simulated-user + judge) spend counts toward the cap
# ---------------------------------------------------------------------------


class _FixedCostClient(BaseClient):
    """Deterministic BaseClient that returns a fixed-cost response.

    Used to simulate an expensive judge / simulated-user pair without
    touching real LLM endpoints.
    """

    def __init__(self, model_name: str, *, cost_usd: float, content: str) -> None:
        self.model_name = model_name
        self._cost_usd = float(cost_usd)
        self._content = content

    async def complete(self, call: ClientCall) -> ClientResponse:
        return ClientResponse(
            content=self._content,
            tool_calls=[],
            finish_reason="stop",
            usage=Usage(prompt_tokens=10, completion_tokens=10, total_tokens=20),
            latency_ms=1,
            cost_usd=self._cost_usd,
            raw_provider_response={"fake": True},
        )


async def test_eval_cost_counted_toward_budget() -> None:
    """Simulated-user + judge spend must charge the same cap as agent spend.

    We build a LIVE scenario, a free agent_fn, and an evaluator whose
    simulated-user client costs $4 per turn and whose judge client costs
    $4 per call. With max_cost_usd=$5 the FIRST eval-bucket charge after
    turn 1 should already exceed the cap — even though the agent paid $0.
    """
    free_calls = {"n": 0}

    async def free_agent_fn(
        history: list[MessageTurn], tools: list[dict[str, Any]]
    ) -> MessageTurn:
        free_calls["n"] += 1
        # In LIVE mode we want to keep going so the simulated-user gets
        # invoked — emit a tool_call so the runner doesn't terminate
        # immediately, but use a benign one that the executor knows about.
        return MessageTurn(
            role="assistant",
            content="working on it",
            tool_calls=[
                {
                    "id": "call_x",
                    "type": "function",
                    "function": {
                        "name": "REMINDER.create",
                        "arguments": (
                            '{"reminder_id": "rm_eval", '
                            '"list_id": "list_personal", "title": "x"}'
                        ),
                    },
                }
            ],
        )

    # LIVE scenario so the evaluator is engaged on every turn.
    live_scenario = Scenario(
        id="budget.live_eval",
        name="live eval cost",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=_PERSONA,
        instruction="remind me",
        ground_truth_actions=[],
        required_outputs=["done"],
        first_question_fallback=None,
        world_seed=999,
        max_turns=4,
    )

    sim_user = _FixedCostClient(
        model_name="fake-sim-user-v1",
        cost_usd=4.0,
        content="hi, please help",
    )
    judge = _FixedCostClient(
        model_name="fake-judge-v1",
        cost_usd=4.0,
        content="NO: not satisfied yet",
    )
    evaluator = LifeOpsEvaluator(
        simulated_user_client=sim_user,
        judge_client=judge,
    )

    runner = LifeOpsBenchRunner(
        agent_fn=free_agent_fn,
        world_factory=_budget_world_factory,
        scenarios=[live_scenario],
        concurrency=1,
        seeds=1,
        max_cost_usd=5.0,
        per_scenario_timeout_s=30,
        evaluator=evaluator,
        live_judge_min_turn=99,  # judge never engages — sim-user alone tops the cap
    )

    result = await runner.run_filtered()

    sr = result.scenarios[0]
    assert sr.terminated_reason == "cost_exceeded", (
        f"expected eval spend to trip cap; got {sr.terminated_reason!r} "
        f"error={sr.error!r}"
    )
    # Eval ledger captured the spend; agent ledger stayed at zero because
    # the fake agent_fn returned cost_usd=0.
    assert result.eval_cost_usd >= 4.0
    assert result.agent_cost_usd == pytest.approx(0.0)
    # Combined wall-spend exceeded the cap.
    assert result.total_cost_usd > runner.max_cost_usd


async def test_judge_eval_cost_trips_budget_before_user_turn() -> None:
    """Judge spend must be enforced before the live loop asks for the next user turn."""

    call_counts = {"sim": 0, "judge": 0}

    async def free_agent_fn(
        history: list[MessageTurn], tools: list[dict[str, Any]]
    ) -> MessageTurn:
        return MessageTurn(role="assistant", content="working on it")

    class _CountingClient(_FixedCostClient):
        async def complete(self, call: ClientCall) -> ClientResponse:  # type: ignore[override]
            if self.model_name == "fake-sim-user-v2":
                call_counts["sim"] += 1
            elif self.model_name == "fake-judge-v2":
                call_counts["judge"] += 1
            return await super().complete(call)

    live_scenario = Scenario(
        id="budget.live_eval_judge",
        name="live eval judge cost",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=_PERSONA,
        instruction="remind me",
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=999,
        max_turns=4,
    )

    sim_user = _CountingClient(
        model_name="fake-sim-user-v2",
        cost_usd=3.0,
        content="hi, please help",
    )
    judge = _CountingClient(
        model_name="fake-judge-v2",
        cost_usd=6.0,
        content='{"satisfied": true, "reason": "done"}',
    )
    evaluator = LifeOpsEvaluator(
        simulated_user_client=sim_user,
        judge_client=judge,
    )

    runner = LifeOpsBenchRunner(
        agent_fn=free_agent_fn,
        world_factory=_budget_world_factory,
        scenarios=[live_scenario],
        concurrency=1,
        seeds=1,
        max_cost_usd=5.0,
        per_scenario_timeout_s=30,
        evaluator=evaluator,
        live_judge_min_turn=1,
    )

    result = await runner.run_filtered()

    sr = result.scenarios[0]
    assert sr.terminated_reason == "cost_exceeded", (
        f"expected judge spend to trip cap; got {sr.terminated_reason!r} "
        f"error={sr.error!r}"
    )
    assert call_counts["sim"] == 0
    assert call_counts["judge"] == 1
    assert result.eval_cost_usd == pytest.approx(6.0)
    assert result.agent_cost_usd == pytest.approx(0.0)
    assert result.total_cost_usd > runner.max_cost_usd
