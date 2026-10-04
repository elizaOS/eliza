"""Solana Gauntlet agent backed by hermes-agent."""

from __future__ import annotations

from gauntlet import (
    gauntlet_types as _gauntlet_types,
    build_safety_hints as _build_safety_hints,
    parse_decision_from_response as _parse_decision_from_response,
    build_prompt as _build_prompt,
)

import json
import logging
import os
from typing import TYPE_CHECKING

from hermes_adapter.client import HermesClient

if TYPE_CHECKING:
    from gauntlet.sdk.types import AgentResponse, ScenarioContext, Task

logger = logging.getLogger(__name__)


class Agent:
    """Gauntlet agent that routes decisions through hermes-agent."""

    def __init__(self, client: HermesClient | None = None) -> None:
        self._client = client or HermesClient(
            provider=os.environ.get("BENCHMARK_MODEL_PROVIDER", "cerebras"),
            model=os.environ.get("BENCHMARK_MODEL_NAME", "gemma-4-31b"),
            timeout_s=float(os.environ.get("HERMES_TIMEOUT_S", "1200") or "1200"),
        )
        self._scenario: "ScenarioContext | None" = None
        self._last_explanation: str | None = None
        self._initialized = False
        print("    [Hermes Gauntlet Agent] Created")

    async def initialize(self, context: "ScenarioContext") -> None:
        if not self._initialized:
            self._client.wait_until_ready(timeout=120)
            self._initialized = True
            print("    [Hermes Gauntlet Agent] Hermes bridge ready")
        self._scenario = context
        print(
            f"    [Hermes Gauntlet Agent] Scenario: {context.scenario_id} (level {context.level})"
        )

    async def execute_task(self, task: "Task") -> "AgentResponse":
        AgentResponse, _, _ = _gauntlet_types()
        scenario = self._scenario
        scenario_id = scenario.scenario_id if scenario else "unknown"
        prompt = _build_prompt(task, scenario)

        try:
            self._client.reset(
                task_id=f"{scenario_id}-{task.task_id}", benchmark="gauntlet"
            )
        except Exception as exc:
            logger.debug("Hermes reset failed (continuing): %s", exc)

        response = self._client.send_message(
            text=prompt,
            context={
                "benchmark": "gauntlet",
                "task_id": task.task_id,
                "scenario_id": scenario_id,
                "level": scenario.level if scenario else 0,
                "task_type": task.type.value,
                "task_parameters": task.parameters,
                "system_prompt": "Return only the requested Gauntlet decision tags.",
            },
        )
        decision, reason, confidence = _parse_decision_from_response(
            response.text or "", response.params
        )
        self._last_explanation = reason
        print(f"    [Hermes Gauntlet Agent] {decision.upper()}: {(reason or '')[:80]}")

        if decision == "execute":
            return AgentResponse(
                action="execute",
                transaction=b"hermes_gauntlet_approved_tx",
                confidence=confidence,
            )
        return AgentResponse(
            action="refuse",
            refusal_reason=reason,
            confidence=confidence,
        )

    async def get_explanation(self) -> str:
        return self._last_explanation or "No decision made yet"


__all__ = ["Agent"]
