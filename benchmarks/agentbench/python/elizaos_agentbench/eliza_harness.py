"""
Full ElizaOS Agent Harness for AgentBench.

This module provides a canonical ElizaOS integration that uses:
- Memory objects for all messages
- message_service.handle_message() for the full pipeline
- Provider context gathering (compose_state)
- Custom benchmark Actions registered with the runtime
- Proper message storage and conversation history

This is the correct way to integrate with ElizaOS - no shortcuts or bypasses.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from uuid6 import uuid7

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime
    from elizaos.types import Action, Memory

from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchResult,
    AgentBenchTask,
    ObservationType,
    StepRecord,
)

logger = logging.getLogger(__name__)


@dataclass
class BenchmarkContext:
    """Context for a running benchmark task."""

    task: AgentBenchTask
    environment: AgentBenchEnvironment
    room_id: str = field(default_factory=lambda: str(uuid7()))
    user_id: str = field(default_factory=lambda: str(uuid7()))
    observations: list[ObservationType] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)
    step_records: list[StepRecord] = field(default_factory=list)
    current_observation: ObservationType = field(default_factory=dict)
    total_reward: float = 0.0
    done: bool = False
    error: str | None = None


class ElizaAgentHarness:
    """
    Full ElizaOS agent harness for running AgentBench evaluations.

    This harness uses the canonical ElizaOS message processing pipeline:
    1. Creates Memory objects for each turn
    2. Calls message_service.handle_message() for full processing
    3. Provider context is gathered via compose_state()
    4. Actions are registered and can be called
    5. Message history is preserved

    Usage:
        runtime = AgentRuntime(character=character, plugins=[...])
        await runtime.initialize()

        harness = ElizaAgentHarness(runtime)
        result = await harness.run_task(task, adapter)
    """

    def __init__(self, runtime: AgentRuntime) -> None:
        """
        Initialize the harness with a fully configured ElizaOS runtime.

        Args:
            runtime: Initialized AgentRuntime with plugins loaded.
        """
        self._runtime = runtime
        self._context: BenchmarkContext | None = None

    @property
    def runtime(self) -> AgentRuntime:
        """Get the ElizaOS runtime."""
        return self._runtime

    async def run_task(
        self,
        task: AgentBenchTask,
        adapter: "EnvironmentAdapterProtocol",
    ) -> AgentBenchResult:
        """
        Run a single benchmark task through the full ElizaOS pipeline.

        This method:
        1. Resets the environment to get initial observation
        2. Creates a Memory with the formatted prompt
        3. Calls message_service.handle_message() for full processing
        4. Parses the action from the agent's response
        5. Executes the action in the environment
        6. Repeats until done or max_steps reached
        7. Evaluates success

        Args:
            task: The benchmark task to run.
            adapter: Environment adapter for the task.

        Returns:
            AgentBenchResult with success status, actions, metrics.
        """
        from elizaos import ChannelType, Content, Memory

        start_time = time.time()

        # Create benchmark context with unique IDs for this task
        self._context = BenchmarkContext(
            task=task,
            environment=adapter.environment,
        )

        actions: list[str] = []
        step_records: list[StepRecord] = []
        total_reward = 0.0
        error: str | None = None
        success = False

        try:
            # Validate task
            if not task.id:
                raise ValueError("Task ID cannot be empty")
            if task.max_steps <= 0:
                raise ValueError(f"max_steps must be positive, got {task.max_steps}")

            # Reset environment to get initial observation
            observation = await adapter.reset(task)
            self._context.current_observation = observation

            # Convert room_id and user_id to UUID format
            from elizaos.types.primitives import as_uuid

            room_id = as_uuid(self._context.room_id)
            user_id = as_uuid(self._context.user_id)

            done = False
            step_num = 0

            while not done and step_num < task.max_steps:
                step_start = time.time()

                # Format the prompt for the current state
                prompt = adapter.format_prompt(task, observation)

                # Create a proper Memory object for the message
                message = Memory(
                    entity_id=user_id,
                    room_id=room_id,
                    content=Content(
                        text=prompt,
                        source="agentbench",
                        channel_type=ChannelType.API.value,
                    ),
                )

                # Use the full message service pipeline
                # This calls compose_state() to gather provider context,
                # generates response via the model, and stores in memory
                result = await self._runtime.message_service.handle_message(
                    self._runtime, message
                )

                # Extract the response text
                response_text = ""
                if result.response_content and result.response_content.text:
                    response_text = result.response_content.text

                # Parse the action from the agent's response
                action = adapter.parse_action(response_text)

                # Fallback to 'think' if no action parsed
                if not action:
                    action = "think"

                actions.append(action)
                self._context.actions.append(action)

                # Execute the action in the environment
                observation, reward, done, info = await adapter.step(action)
                total_reward += reward
                self._context.current_observation = observation

                # Record step with sanitized metadata
                step_metadata: dict[str, str | int | float | bool | None] = {}
                for k, v in info.items():
                    if isinstance(v, (str, int, float, bool, type(None))):
                        step_metadata[k] = v
                    else:
                        step_metadata[k] = str(v)

                step_record = StepRecord(
                    step_number=step_num,
                    action=action,
                    observation=str(observation),
                    reward=reward,
                    timestamp_ms=(time.time() - step_start) * 1000,
                    metadata=step_metadata,
                )
                step_records.append(step_record)
                self._context.step_records.append(step_record)

                step_num += 1

                # Check timeout
                elapsed_ms = (time.time() - start_time) * 1000
                if elapsed_ms > task.timeout_ms:
                    error = f"Task timed out after {elapsed_ms:.0f}ms"
                    break

                # Early success check
                if not done:
                    try:
                        if await adapter.evaluate(task, actions):
                            success = True
                            done = True
                            break
                    except Exception as eval_err:
                        error = f"Evaluation error: {eval_err}"
                        break

            # Final evaluation if not already successful
            if not success:
                success = await adapter.evaluate(task, actions)

        except Exception as e:
            error = str(e)
            logger.error(f"[{adapter.environment.value}] Task {task.id} failed: {e}")

        duration_ms = (time.time() - start_time) * 1000

        return AgentBenchResult(
            task_id=task.id,
            environment=adapter.environment,
            success=success,
            steps_taken=len(actions),
            actions=actions,
            final_state=self._context.current_observation if self._context else {},
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
        """Clear conversation state for a fresh start."""
        self._context = None
        # Clear the runtime's state cache to ensure fresh provider context
        if hasattr(self._runtime, "_state_cache"):
            self._runtime._state_cache.clear()


class EnvironmentAdapterProtocol:
    """Protocol for environment adapters compatible with the harness."""

    environment: AgentBenchEnvironment

    async def reset(self, task: AgentBenchTask) -> ObservationType:
        """Reset environment for a new task."""
        ...

    async def step(
        self, action: str
    ) -> tuple[ObservationType, float, bool, dict[str, str | int | float | bool | None]]:
        """Execute an action and return result."""
        ...

    async def evaluate(self, task: AgentBenchTask, trajectory: list[str]) -> bool:
        """Evaluate task success."""
        ...

    def format_prompt(self, task: AgentBenchTask, observation: ObservationType) -> str:
        """Format observation into a prompt."""
        ...

    def parse_action(self, response: str) -> str:
        """Parse action from response."""
        ...


def create_benchmark_character(name: str = "BenchmarkAgent") -> "Character":
    """
    Create a character optimized for benchmark tasks.

    This character has a system prompt designed for agentic task execution
    with clear instruction following.
    """
    from elizaos import Character

    return Character(
        name=name,
        username=name.lower().replace(" ", "_"),
        bio=[
            "An expert AI agent specialized in solving complex tasks.",
            "Excels at following instructions precisely and executing actions step by step.",
            "Always analyzes the current state before deciding on the next action.",
        ],
        system="""You are an expert AI agent executing benchmark tasks.

IMPORTANT RULES:
1. Read the task description and current state carefully.
2. Output ONLY the action in the exact format specified.
3. Do not add explanations or commentary outside the action format.
4. If you need to think, use the 'think' action.
5. Execute one action per turn - be decisive.
6. Analyze observations to track progress toward the goal.

Your responses should contain ONLY the action command, nothing else.""",
        settings={
            "checkShouldRespond": False,  # Always respond in benchmark mode
        },
    )


async def create_benchmark_runtime(
    character: "Character | None" = None,
    plugins: "list | None" = None,
) -> "AgentRuntime":
    """
    Create and initialize an ElizaOS runtime for benchmarking.

    This sets up the runtime with:
    - Bootstrap plugin for basic capabilities
    - OpenAI plugin (or provided plugins) for model access
    - Benchmark-optimized character

    Args:
        character: Optional custom character. Defaults to benchmark character.
        plugins: Optional list of plugins. Defaults to [bootstrap, openai].

    Returns:
        Initialized AgentRuntime ready for benchmark execution.
    """
    import os

    from elizaos.runtime import AgentRuntime
    from elizaos.bootstrap import bootstrap_plugin

    if character is None:
        character = create_benchmark_character()

    if plugins is None:
        plugins = [bootstrap_plugin]

        # Add OpenAI plugin if API key is available
        if os.environ.get("OPENAI_API_KEY"):
            try:
                from elizaos_plugin_openai import get_openai_plugin

                plugins.append(get_openai_plugin())
            except ImportError:
                logger.warning("OpenAI plugin not available")

    runtime = AgentRuntime(character=character, plugins=plugins)
    await runtime.initialize()

    return runtime
