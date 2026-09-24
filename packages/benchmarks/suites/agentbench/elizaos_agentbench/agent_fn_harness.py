"""AgentBench harness adapter for external agent_fn factories."""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any

from elizaos_agentbench.adapters.base import EnvironmentAdapter
from elizaos_agentbench.types import AgentBenchResult, AgentBenchTask, StepRecord

logger = logging.getLogger(__name__)

AgentFn = Callable[[str, dict[str, Any] | None], Awaitable[dict[str, Any]]]


def _extract_action(response: dict[str, Any], adapter: EnvironmentAdapter) -> str:
    raw_action = response.get("action")
    if isinstance(raw_action, str) and raw_action.strip():
        return raw_action.strip()
    text = response.get("text")
    if not isinstance(text, str) or not text.strip():
        return "think"
    cmd_match = re.search(r"<command>(.*?)</command>", text, re.DOTALL)
    if cmd_match:
        return cmd_match.group(1).strip()
    parsed = adapter.parse_action(text)
    return parsed or text.strip()


class AgentFnHarness:
    """Run AgentBench tasks through a Hermes/OpenClaw-style async agent function."""

    def __init__(self, agent_fn: AgentFn, *, harness: str) -> None:
        self._agent_fn = agent_fn
        self.harness = harness

    async def run_task(
        self,
        task: AgentBenchTask,
        adapter: EnvironmentAdapter,
    ) -> AgentBenchResult:
        start_time = time.time()
        actions: list[str] = []
        step_records: list[StepRecord] = []
        total_reward = 0.0
        error: str | None = None
        success = False

        try:
            observation = await adapter.reset(task)
            action_space = adapter.get_action_space()
            done = False
            step_num = 0

            while not done and step_num < task.max_steps:
                step_start = time.time()
                formatter = getattr(adapter, "format_prompt", None)
                if callable(formatter):
                    prompt_text = formatter(task, observation)
                elif step_num == 0:
                    prompt_text = f"Start the benchmark task: {task.goal}"
                else:
                    prompt_text = f"Continue with the benchmark task: {task.goal}"

                response = await self._agent_fn(
                    prompt_text,
                    {
                        "benchmark": "agentbench",
                        "harness": self.harness,
                        "task_id": task.id,
                        "goal": task.goal,
                        "observation": observation,
                        "action_space": action_space,
                        "environment": adapter.environment.value,
                        "step": step_num,
                    },
                )
                action = _extract_action(response, adapter)
                actions.append(action)

                observation, reward, done, info = await adapter.step(action)
                total_reward += reward
                step_metadata: dict[str, str | int | float | bool | None] = {
                    "harness": self.harness,
                }
                for key, value in info.items():
                    if isinstance(value, (str, int, float, bool, type(None))):
                        step_metadata[key] = value
                    else:
                        step_metadata[key] = str(value)
                if "model_name" in response:
                    step_metadata["model_name"] = str(response["model_name"])

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

                elapsed_ms = (time.time() - start_time) * 1000
                if elapsed_ms > task.timeout_ms:
                    error = f"Task timed out after {elapsed_ms:.0f}ms"
                    break

                if not done and await adapter.evaluate(task, actions):
                    success = True
                    done = True

            if not success:
                success = await adapter.evaluate(task, actions)
        except Exception as exc:
            error = str(exc)
            logger.exception("[agentbench-%s] Task %s failed", self.harness, task.id)

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
        """External clients own their own context reset semantics."""
        return None

