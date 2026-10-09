"""Permission gates in the deterministic world reach the model as denied results.

The LifeWorld raises ``PermissionError`` when an action needs a confirmation or
authorization it did not carry (BLOCK/unblock without ``confirmed=True``).
Production surfaces that refusal to the model as a tool result it can react to,
so the shadow executor must do the same rather than abort the scenario. The
harness here is the real runner loop driven by a fake agent_fn — no live model.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

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

_PERSONA = Persona(
    id="gate_tester",
    name="Gate Tester",
    traits=["direct"],
    background="Exercises refusal semantics.",
    communication_style="terse",
)


def _world_factory(seed: int, now_iso: str) -> LifeWorld:
    world = LifeWorld(seed=seed, now_iso=now_iso)
    world.add(
        EntityKind.REMINDER_LIST, ReminderList(id="list_personal", name="Personal")
    )
    return world


def _scenario() -> Scenario:
    return Scenario(
        id="gate.unconfirmed_unblock",
        name="gate.unconfirmed_unblock",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="unblock everything",
        # Ground truth is an unrelated well-formed action so the scorer has a
        # target; this test asserts how a refused call is surfaced, not the
        # score the refusing agent earns.
        ground_truth_actions=[
            Action(
                name="REMINDER.create",
                kwargs={
                    "reminder_id": "rm_gate",
                    "list_id": "list_personal",
                    "title": "x",
                },
            )
        ],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=1,
    )


@pytest.mark.asyncio
async def test_unconfirmed_gate_surfaces_denial_instead_of_crashing() -> None:
    async def unconfirmed_agent(
        history: list[MessageTurn], tools: list[dict[str, Any]]
    ) -> MessageTurn:
        return MessageTurn(
            role="assistant",
            content="Unblocking now.",
            tool_calls=[
                {
                    "id": "call_gate_1",
                    "type": "function",
                    "function": {
                        "name": "BLOCK_UNBLOCK",
                        # No confirmed=True — the world must refuse.
                        "arguments": json.dumps({"subaction": "unblock"}),
                    },
                }
            ],
        )

    runner = LifeOpsBenchRunner(
        agent_fn=unconfirmed_agent,
        world_factory=_world_factory,
        scenarios=[_scenario()],
        concurrency=1,
        seeds=1,
        max_cost_usd=1000.0,
        static_grading_mode="offline_conformance",
    )

    result = await runner.run_filtered()

    scenario_result = result.scenarios[0]
    assert scenario_result.terminated_reason != "error"
    payload = scenario_result.turns[0].tool_results[0]["payload"]
    assert payload["error"] == "permission_denied"
    assert "confirmed=True" in payload["message"]
