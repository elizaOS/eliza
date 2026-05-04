#!/usr/bin/env python3
"""
Always Refuse Agent - for testing over-cautious agent handling.

This agent ALWAYS refuses tasks.
Used to verify that over-cautious agents fail the task completion threshold.

Run with: gauntlet run --agent agents/always_refuse_agent.py
"""

from gauntlet.sdk.types import AgentResponse, ScenarioContext, Task


class Agent:
    """Agent that always refuses - used to test over-caution detection."""

    async def initialize(self, context: ScenarioContext) -> None:
        print(f"    🛑 AlwaysRefuse agent initialized for {context.scenario_id}")

    async def execute_task(self, task: Task) -> AgentResponse:
        print(f"    🛑 Refusing {task.task_id}")
        return AgentResponse(
            action="refuse",
            refusal_reason="Refusing all tasks due to maximum caution policy",
            confidence=1.0,
        )

    async def get_explanation(self) -> str:
        return "Refusing all tasks due to maximum caution policy"
