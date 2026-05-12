"""
Base environment adapter for AgentBench.
"""

import logging
import time
from abc import ABC, abstractmethod

from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchTask,
    AgentBenchResult,
    AgentRuntimeProtocol,
    EnvironmentConfig,
    ObservationType,
    StepRecord,
)

logger = logging.getLogger(__name__)


class EnvironmentAdapter(ABC):
    """
    Abstract base class for environment adapters.

    Each environment adapter implements the interface between the ElizaOS
    runtime and a specific AgentBench environment.
    """

    environment: AgentBenchEnvironment

    def __init__(
        self,
        runtime: AgentRuntimeProtocol | None = None,
        config: EnvironmentConfig | None = None,
    ) -> None:
        self.runtime = runtime
        self.config = config or EnvironmentConfig()
        self._initialized = False
        self._current_task: AgentBenchTask | None = None
        self._current_state: ObservationType = {}
        self._step_history: list[StepRecord] = []

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize the environment (e.g., start Docker containers)."""
        pass

    @abstractmethod
    async def reset(self, task: AgentBenchTask) -> ObservationType:
        """
        Reset environment to initial state for a new task.

        Returns:
            Initial observation/state dictionary.
        """
        pass

    @abstractmethod
    async def step(self, action: str) -> tuple[ObservationType, float, bool, dict[str, str | int | float | bool | None]]:
        """
        Execute an action and return the result.

        Args:
            action: The action to execute (environment-specific format).

        Returns:
            Tuple of (observation, reward, done, info).
        """
        pass

    @abstractmethod
    async def evaluate(self, task: AgentBenchTask, trajectory: list[str]) -> bool:
        """
        Evaluate if the task was completed successfully.

        Args:
            task: The task being evaluated.
            trajectory: List of actions taken.

        Returns:
            True if task was completed successfully.
        """
        pass

    @abstractmethod
    async def cleanup(self) -> None:
        """Clean up resources (e.g., stop containers)."""
        pass

    @abstractmethod
    def get_action_space(self) -> list[str]:
        """Get the list of available actions in this environment."""
        pass

    @abstractmethod
    def format_prompt(self, task: AgentBenchTask, observation: ObservationType) -> str:
        """
        Format the observation into a prompt for the LLM.

        Args:
            task: Current task.
            observation: Current environment observation.

        Returns:
            Formatted prompt string.
        """
        pass

    @abstractmethod
    def parse_action(self, response: str) -> str:
        """
        Parse the LLM response to extract the action.

        Args:
            response: LLM response text.

        Returns:
            Extracted action string.
        """
        pass

    async def run_task(self, task: AgentBenchTask) -> AgentBenchResult:
        """
        Run a single task through the environment.

        Args:
            task: The task to run.

        Returns:
            Result of the task execution.
        """
        start_time = time.time()
        self._current_task = task
        self._step_history = []
        actions: list[str] = []
        total_reward = 0.0
        error: str | None = None
        success = False

        try:
            # Validate task before execution
            if not task.id:
                raise ValueError("Task ID cannot be empty")
            if task.max_steps <= 0:
                raise ValueError(f"max_steps must be positive, got {task.max_steps}")

            # Reset environment
            observation = await self.reset(task)
            self._current_state = observation

            # Run task loop
            done = False
            step_num = 0

            while not done and step_num < task.max_steps:
                step_start = time.time()

                # Get action from agent
                prompt = self.format_prompt(task, observation)
                response = await self._get_agent_response(prompt)
                action = self.parse_action(response)

                # Validate action is not empty
                if not action:
                    action = "think"  # Default fallback action

                actions.append(action)

                # Execute action
                observation, reward, done, info = await self.step(action)
                total_reward += reward
                self._current_state = observation

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
                self._step_history.append(step_record)

                step_num += 1

                # Check timeout
                elapsed_ms = (time.time() - start_time) * 1000
                if elapsed_ms > task.timeout_ms:
                    error = f"Task timed out after {elapsed_ms:.0f}ms"
                    break

                # Early success check: if environment didn't signal done, allow evaluation to stop early.
                # This avoids running to max_steps for environments where "done" is implicit (e.g., DB).
                if not done:
                    try:
                        if await self.evaluate(task, actions):
                            success = True
                            done = True
                            break
                    except Exception as eval_err:
                        error = f"Evaluation error: {eval_err}"
                        break

            # Evaluate success
            if not success:
                success = await self.evaluate(task, actions)

        except Exception as e:
            error = str(e)
            logger.error(f"[{self.environment.value}] Task {task.id} failed: {e}")

        duration_ms = (time.time() - start_time) * 1000

        return AgentBenchResult(
            task_id=task.id,
            environment=self.environment,
            success=success,
            steps_taken=len(actions),
            actions=actions,
            final_state=self._current_state,
            duration_ms=duration_ms,
            error=error,
            metrics={
                "planning_time_ms": 0.0,
                "execution_time_ms": duration_ms,
                "tokens_used": 0.0,
                "reward": total_reward,
                "efficiency": total_reward / max(len(actions), 1),
            },
            step_records=self._step_history,
        )

    async def _get_agent_response(self, prompt: str) -> str:
        """
        Get response from the agent/LLM.

        This can be overridden to use different LLM backends.
        """
        if not prompt:
            raise ValueError("Prompt cannot be empty")

        if self.runtime is not None:
            # Use ElizaOS runtime for text generation
            result = await self.runtime.generate_text(prompt)
            return result.text
        else:
            # Return a placeholder for testing
            return "action: think"

    def _is_initialized(self) -> bool:
        """Check if the adapter has been initialized."""
        return self._initialized
