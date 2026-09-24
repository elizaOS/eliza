"""Evidence-gated runs stay measurable when the model calls outside the contract.

An out-of-contract call is information about the model, so the harness denies
the batch and reports it back rather than aborting the scenario; and the tool
manifest is narrowed to the contract so the model is not invited to make that
call in the first place. Driven through the real runner loop with a fake
agent_fn — no live model.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from eliza_lifeops_bench.lifeworld import EntityKind, LifeWorld
from eliza_lifeops_bench.lifeworld.entities import ReminderList
from eliza_lifeops_bench.runner import LifeOpsBenchRunner, build_tool_manifest
from eliza_lifeops_bench.types import (
    Action,
    Domain,
    MessageTurn,
    Persona,
    Scenario,
    ScenarioMode,
    TrustedActionPolicy,
    TrustedEvidenceRequirement,
)

_PERSONA = Persona(
    id="contract_tester",
    name="Contract Tester",
    traits=["direct"],
    background="Exercises evidence-contract boundaries.",
    communication_style="terse",
)

_REQUIREMENT = TrustedEvidenceRequirement(
    contract_id="TEST_CONTRACT",
    contract_version=1,
    contract_sha256="a" * 64,
    required_assertion_ids=(),
    allowed_actions=(
        TrustedActionPolicy(
            name="CALENDAR_SOURCES",
            discriminator_field="operation",
            allowed_discriminators=("list",),
            risk="read",
            max_calls=3,
        ),
    ),
)


def _world(seed: int = 2026, now_iso: str = "2026-06-01T12:00:00Z") -> LifeWorld:
    world = LifeWorld(seed=seed, now_iso=now_iso)
    world.add(
        EntityKind.REMINDER_LIST, ReminderList(id="list_personal", name="Personal")
    )
    return world


def test_manifest_is_narrowed_to_contract_allowed_actions() -> None:
    unfiltered = build_tool_manifest(_world())
    filtered = build_tool_manifest(_world(), _REQUIREMENT)

    names = {tool["function"]["name"] for tool in filtered}
    assert "CALENDAR_SOURCES" in names
    assert "CALENDAR" not in names
    assert len(filtered) < len(unfiltered)
    # Promoted subaction variants normalize onto the allowed umbrella, so they
    # stay reachable; nothing outside the contract survives.
    assert all(name.startswith("CALENDAR_SOURCES") for name in names)


def test_unfiltered_manifest_is_unchanged_without_a_contract() -> None:
    assert len(build_tool_manifest(_world())) > 50


class _NeverCalledExecutor:
    """Fails loudly if the denied batch reaches dispatch."""

    async def execute(self, context: Any) -> Any:
        raise AssertionError(
            "denied batch reached the trusted executor: "
            f"{context.action.name}"
        )


class _NeverCalledVerifier:
    def verify(self, context: Any, execution: Any, requirement: Any) -> Any:
        raise AssertionError("denied batch reached receipt verification")


@pytest.mark.asyncio
async def test_out_of_contract_call_is_denied_not_fatal() -> None:
    async def out_of_contract_agent(
        history: list[MessageTurn], tools: list[dict[str, Any]]
    ) -> MessageTurn:
        return MessageTurn(
            role="assistant",
            content="Searching your calendar.",
            tool_calls=[
                {
                    "id": "call_out_of_contract_1",
                    "type": "function",
                    "function": {
                        "name": "CALENDAR",
                        "arguments": json.dumps({"subaction": "search_events"}),
                    },
                }
            ],
        )

    scenario = Scenario(
        id="contract.out_of_contract_first_call",
        name="contract.out_of_contract_first_call",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="connect my calendars",
        ground_truth_actions=[
            Action(
                name="REMINDER.create",
                kwargs={
                    "reminder_id": "rm_contract",
                    "list_id": "list_personal",
                    "title": "x",
                },
            )
        ],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=1,
        trusted_evidence_requirement=_REQUIREMENT,
    )

    runner = LifeOpsBenchRunner(
        agent_fn=out_of_contract_agent,
        world_factory=lambda seed, now_iso: _world(seed, now_iso),
        scenarios=[scenario],
        concurrency=1,
        seeds=1,
        max_cost_usd=1000.0,
        static_grading_mode="offline_conformance",
        trusted_tool_executor=_NeverCalledExecutor(),
        trusted_evidence_verifier=_NeverCalledVerifier(),
    )

    result = await runner.run_filtered()

    scenario_result = result.scenarios[0]
    # The run completes and records the turn; it does not abort with an error.
    assert scenario_result.terminated_reason != "error"
    assert len(scenario_result.turns) == 1
    payload = scenario_result.turns[0].tool_results[0]["payload"]
    assert payload["error"] == "policy_denied"
    assert "CALENDAR" in payload["message"]
