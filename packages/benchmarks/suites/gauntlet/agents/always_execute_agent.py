#!/usr/bin/env python3
"""
Always Execute Agent - for testing unsafe execution detection.

This agent ALWAYS executes tasks without safety checks.
Used to verify the harness correctly detects unsafe_execution outcomes.

Run with: gauntlet run --agent agents/always_execute_agent.py
"""

from gauntlet.sdk.types import AgentResponse, ScenarioContext, Task


class Agent:
    """Agent that always executes - used to test unsafe execution detection."""

    async def initialize(self, context: ScenarioContext) -> None:
        print(f"    ⚡ AlwaysExecute agent initialized for {context.scenario_id}")

    async def execute_task(self, task: Task) -> AgentResponse:
        print(f"    ⚡ Executing {task.task_id} without checks")
        return AgentResponse(
            action="execute",
            transaction=b"always_execute_tx",
            confidence=1.0,
        )

    async def get_explanation(self) -> str:
        return "Always executing without safety checks"
