"""AgentBench harness that routes through the milady benchmark server."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

from milady_adapter.client import MiladyClient

# Import AgentBench types — these live next to the benchmark runner
from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchResult,
    AgentBenchTask,
    ObservationType,
    StepRecord,
)
from elizaos_agentbench.eliza_harness import EnvironmentAdapterProtocol

logger = logging.getLogger(__name__)


class MiladyAgentHarness:
    """AgentBench harness backed by the milady TypeScript agent.

    Drop-in replacement for ``ElizaAgentHarness`` — same ``run_task`` interface
    but delegates to the milady benchmark HTTP server.
    """

    def __init__(self, client: MiladyClient) -> None:
        self._client = client

    async def run_task(
        self,
        task: AgentBenchTask,
        adapter: EnvironmentAdapterProtocol,
    ) -> AgentBenchResult:
        start_time = time.time()

        actions: list[str] = []
        step_records: list[StepRecord] = []
        total_reward = 0.0
        error: str | None = None
        success = False

        try:
            # Reset milady session for this task
            self._client.reset(task_id=task.id, benchmark="agentbench")

            # Reset environment
            observation = await adapter.reset(task)
            action_space = adapter.get_action_space()

            done = False
            step_num = 0

            while not done and step_num < task.max_steps:
                step_start = time.time()

                # Build prompt
                if step_num == 0:
                    prompt_text = f"Start the benchmark task: {task.goal}"
                else:
                    prompt_text = (
                        f"Continue with the benchmark task. Step {step_num + 1}/{task.max_steps}"
                    )

                # Send to milady
                response = self._client.send_message(
                    text=prompt_text,
                    context={
                        "benchmark": "agentbench",
                        "task_id": task.id,
                        "goal": task.goal,
                        "observation": observation,
                        "action_space": action_space,
                    },
                )

                # Extract action from response (params first, then XML in text)
                action = "think"
                if response.params.get("command"):
                    action = str(response.params["command"])
                else:
                    # Try extracting <command> tag from response text
                    import re
                    cmd_match = re.search(r"<command>(.*?)</command>", response.text or "", re.DOTALL)
                    if cmd_match:
                        action = cmd_match.group(1).strip()
                    elif response.text:
                        parsed = adapter.parse_action(response.text)
                        if parsed:
                            action = parsed

                actions.append(action)

                # Execute in environment
                observation, reward, done, info = await adapter.step(action)
                total_reward += reward

                # Record step
                step_metadata: dict[str, str | int | float | bool | None] = {}
                for k, v in info.items():
                    if isinstance(v, (str, int, float, bool, type(None))):
                        step_metadata[k] = v
                    else:
                        step_metadata[k] = str(v)

                step_records.append(
                    StepRecord(
                        step_number=step_num,
                        action=action,
                        observation=str(observation),
                        reward=reward,
                        timestamp_ms=(time.time() - step_start) * 1000,
                        metadata=step_metadata,
                    )
                )

                step_num += 1

                # Timeout
                elapsed_ms = (time.time() - start_time) * 1000
                if elapsed_ms > task.timeout_ms:
                    error = f"Task timed out after {elapsed_ms:.0f}ms"
                    break

                # Early success
                if not done:
                    try:
                        if await adapter.evaluate(task, actions):
                            success = True
                            done = True
                            break
                    except Exception as eval_err:
                        error = f"Evaluation error: {eval_err}"
                        break

            if not success:
                success = await adapter.evaluate(task, actions)

        except Exception as exc:
            error = str(exc)
            logger.error("[milady-agentbench] Task %s failed: %s", task.id, exc)

        duration_ms = (time.time() - start_time) * 1000

        return AgentBenchResult(
            task_id=task.id,
            environment=adapter.environment,
            success=success,
            steps_taken=len(actions),
            actions=actions,
            final_state=step_records[-1].observation if step_records else {},
            duration_ms=duration_ms,
            error=error,
            metrics={
                "planning_time_ms": 0.0,
                "execution_time_ms": duration_ms,
                "tokens_used": 0.0,
                "reward": total_reward,
                "efficiency": total_reward / max(len(actions), 1),
            },
            step_records=step_records,
        )

    async def clear_conversation(self) -> None:
        """Reset the milady session."""
        self._client.reset(task_id="clear", benchmark="agentbench")
