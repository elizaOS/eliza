"""
Trajectory Adapter for ElizaOS plugin-trajectory-logger

Maps ART trajectories to ElizaOS trajectory format for:
- Persistent storage
- Export to HuggingFace
- GRPO grouping
- RULER scoring integration

This adapter provides end-to-end capture of the entire ElizaOS flow:
- All LLM calls (prompts, responses, latency, tokens)
- Provider accesses (game state, context, etc.)
- Action executions (parameters, results, rewards)
- Environment state at each step
"""

import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol, runtime_checkable

from elizaos_art.base import EpisodeResult, State, Trajectory


@runtime_checkable
class TrajectoryLoggerService(Protocol):
    """Protocol matching ElizaOS TrajectoryLoggerService interface."""

    def start_trajectory(
        self,
        agent_id: str,
        scenario_id: str | None = None,
        episode_id: str | None = None,
        batch_id: str | None = None,
        group_index: int | None = None,
        metadata: dict | None = None,
    ) -> str:
        """Start a new trajectory, returns trajectory_id."""
        ...

    def start_step(
        self,
        trajectory_id: str,
        env_state: dict,
    ) -> str:
        """Start a new step, returns step_id."""
        ...

    def log_llm_call(
        self,
        step_id: str,
        model: str,
        system_prompt: str,
        user_prompt: str,
        response: str,
        temperature: float,
        max_tokens: int,
        purpose: str,
        action_type: str | None = None,
        latency_ms: int | None = None,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        reasoning: str | None = None,
        messages: list[dict] | None = None,
    ) -> None:
        """Log an LLM call within a step."""
        ...

    def log_provider_access(
        self,
        step_id: str,
        provider_name: str,
        data: dict,
        purpose: str,
        query: dict | None = None,
    ) -> None:
        """Log a provider access within a step."""
        ...

    def complete_step(
        self,
        trajectory_id: str,
        step_id: str,
        action_type: str,
        action_name: str,
        parameters: dict,
        success: bool,
        reward: float | None = None,
        error: str | None = None,
        result: dict | None = None,
        reasoning: str | None = None,
    ) -> None:
        """Complete a step with action outcome."""
        ...

    def end_trajectory(
        self,
        trajectory_id: str,
        status: str,
        final_metrics: dict | None = None,
    ) -> None:
        """End and persist the trajectory."""
        ...


@dataclass
class ElizaEnvironmentState:
    """
    Environment state in ElizaOS format.
    
    Maps to EnvironmentState from plugin-trajectory-logger.
    """

    timestamp: int
    agent_balance: float = 0.0
    agent_points: float = 0.0
    agent_pnl: float = 0.0
    open_positions: int = 0
    active_markets: int | None = None
    portfolio_value: float | None = None
    custom: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp,
            "agentBalance": self.agent_balance,
            "agentPoints": self.agent_points,
            "agentPnL": self.agent_pnl,
            "openPositions": self.open_positions,
            "activeMarkets": self.active_markets,
            "portfolioValue": self.portfolio_value,
            "custom": self.custom,
        }


@dataclass
class ElizaLLMCall:
    """LLM call in ElizaOS format."""

    model: str
    system_prompt: str
    user_prompt: str
    response: str
    temperature: float = 0.7
    max_tokens: int = 2048
    purpose: str = "action"  # "action" | "reasoning" | "evaluation" | "response" | "other"
    action_type: str | None = None
    latency_ms: int | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    reasoning: str | None = None
    messages: list[dict] | None = None

    def to_dict(self) -> dict:
        return {
            "model": self.model,
            "systemPrompt": self.system_prompt,
            "userPrompt": self.user_prompt,
            "response": self.response,
            "temperature": self.temperature,
            "maxTokens": self.max_tokens,
            "purpose": self.purpose,
            "actionType": self.action_type,
            "latencyMs": self.latency_ms,
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "reasoning": self.reasoning,
            "messages": self.messages,
        }


@dataclass
class ElizaProviderAccess:
    """Provider access in ElizaOS format."""

    provider_name: str
    data: dict
    purpose: str
    query: dict | None = None
    timestamp: int | None = None

    def to_dict(self) -> dict:
        return {
            "providerName": self.provider_name,
            "data": self.data,
            "purpose": self.purpose,
            "query": self.query,
            "timestamp": self.timestamp or int(time.time() * 1000),
        }


@dataclass
class ElizaActionAttempt:
    """Action attempt in ElizaOS format."""

    action_type: str
    action_name: str
    parameters: dict
    success: bool
    result: dict | None = None
    error: str | None = None
    reasoning: str | None = None
    immediate_reward: float | None = None

    def to_dict(self) -> dict:
        return {
            "actionType": self.action_type,
            "actionName": self.action_name,
            "parameters": self.parameters,
            "success": self.success,
            "result": self.result,
            "error": self.error,
            "reasoning": self.reasoning,
            "immediateReward": self.immediate_reward,
        }


class ElizaTrajectoryLogger:
    """
    Adapter that wraps ART trajectory logging to ElizaOS format.
    
    When an external TrajectoryLoggerService is available, uses it.
    Otherwise, provides a standalone implementation that stores
    trajectories locally in ElizaOS-compatible format.
    
    This adapter provides end-to-end capture of:
    - All LLM calls (prompts, responses, latency, tokens)
    - Provider accesses (game state, context, etc.)
    - Action executions (parameters, results, rewards)
    - Environment state at each step
    """

    def __init__(
        self,
        agent_id: str,
        data_dir: str | Path = "./data/trajectories",
        external_logger: TrajectoryLoggerService | None = None,
        auto_persist: bool = True,
    ):
        self.agent_id = agent_id
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._external_logger = external_logger
        self._auto_persist = auto_persist
        
        # Active trajectories (when not using external logger)
        self._active_trajectories: dict[str, dict] = {}
        self._active_steps: dict[str, str] = {}  # trajectory_id -> current_step_id
        
        # Hooks for intercepting LLM calls
        self._llm_call_hooks: list[Callable] = []
        self._provider_hooks: list[Callable] = []
        self._action_hooks: list[Callable] = []

    def register_llm_hook(self, hook: Callable) -> None:
        """Register a hook to intercept LLM calls."""
        self._llm_call_hooks.append(hook)

    def register_provider_hook(self, hook: Callable) -> None:
        """Register a hook to intercept provider accesses."""
        self._provider_hooks.append(hook)

    def register_action_hook(self, hook: Callable) -> None:
        """Register a hook to intercept action executions."""
        self._action_hooks.append(hook)

    def start_trajectory(
        self,
        scenario_id: str | None = None,
        episode_id: str | None = None,
        batch_id: str | None = None,
        group_index: int | None = None,
        metadata: dict | None = None,
    ) -> str:
        """Start a new trajectory."""
        if self._external_logger:
            return self._external_logger.start_trajectory(
                agent_id=self.agent_id,
                scenario_id=scenario_id,
                episode_id=episode_id,
                batch_id=batch_id,
                group_index=group_index,
                metadata=metadata,
            )

        # Standalone implementation
        trajectory_id = str(uuid.uuid4())
        now = int(time.time() * 1000)

        self._active_trajectories[trajectory_id] = {
            "trajectoryId": trajectory_id,
            "agentId": self.agent_id,
            "startTime": now,
            "endTime": now,
            "durationMs": 0,
            "episodeId": episode_id,
            "scenarioId": scenario_id,
            "batchId": batch_id,
            "groupIndex": group_index,
            "steps": [],
            "totalReward": 0.0,
            "rewardComponents": {"environmentReward": 0.0},
            "metrics": {"episodeLength": 0, "finalStatus": "in_progress"},
            "metadata": metadata or {},
        }

        return trajectory_id

    def start_step(
        self,
        trajectory_id: str,
        env_state: ElizaEnvironmentState | dict,
    ) -> str:
        """Start a new step in the trajectory."""
        if isinstance(env_state, ElizaEnvironmentState):
            env_state = env_state.to_dict()

        if self._external_logger:
            return self._external_logger.start_step(trajectory_id, env_state)

        trajectory = self._active_trajectories.get(trajectory_id)
        if not trajectory:
            raise ValueError(f"Trajectory {trajectory_id} not found")

        step_id = str(uuid.uuid4())
        step = {
            "stepId": step_id,
            "stepNumber": len(trajectory["steps"]),
            "timestamp": env_state.get("timestamp", int(time.time() * 1000)),
            "environmentState": env_state,
            "observation": {},
            "llmCalls": [],
            "providerAccesses": [],
            "action": {
                "attemptId": "",
                "timestamp": 0,
                "actionType": "pending",
                "actionName": "pending",
                "parameters": {},
                "success": False,
            },
            "reward": 0.0,
            "done": False,
        }

        trajectory["steps"].append(step)
        self._active_steps[trajectory_id] = step_id
        return step_id

    def get_current_step_id(self, trajectory_id: str) -> str | None:
        """Get the current active step ID for a trajectory."""
        return self._active_steps.get(trajectory_id)

    def log_llm_call(
        self,
        step_id: str,
        llm_call: ElizaLLMCall | dict,
    ) -> None:
        """Log an LLM call within a step."""
        if isinstance(llm_call, ElizaLLMCall):
            call_dict = llm_call.to_dict()
        else:
            call_dict = llm_call

        # Notify hooks
        for hook in self._llm_call_hooks:
            try:
                hook(step_id, call_dict)
            except Exception:
                pass

        if self._external_logger:
            self._external_logger.log_llm_call(
                step_id=step_id,
                model=call_dict.get("model", "unknown"),
                system_prompt=call_dict.get("systemPrompt", ""),
                user_prompt=call_dict.get("userPrompt", ""),
                response=call_dict.get("response", ""),
                temperature=call_dict.get("temperature", 0.7),
                max_tokens=call_dict.get("maxTokens", 2048),
                purpose=call_dict.get("purpose", "action"),
                action_type=call_dict.get("actionType"),
                latency_ms=call_dict.get("latencyMs"),
                prompt_tokens=call_dict.get("promptTokens"),
                completion_tokens=call_dict.get("completionTokens"),
                reasoning=call_dict.get("reasoning"),
                messages=call_dict.get("messages"),
            )
            return

        # Find the step
        for trajectory in self._active_trajectories.values():
            for step in trajectory["steps"]:
                if step["stepId"] == step_id:
                    call_dict["callId"] = str(uuid.uuid4())
                    call_dict["timestamp"] = int(time.time() * 1000)
                    step["llmCalls"].append(call_dict)
                    return

    def log_llm_call_by_trajectory_id(
        self,
        trajectory_id: str,
        llm_call: ElizaLLMCall | dict,
    ) -> None:
        """Log an LLM call using trajectory ID (uses current step)."""
        step_id = self._active_steps.get(trajectory_id)
        if step_id:
            self.log_llm_call(step_id, llm_call)

    def log_provider_access(
        self,
        step_id: str,
        provider_access: ElizaProviderAccess | dict,
    ) -> None:
        """Log a provider access within a step."""
        if isinstance(provider_access, ElizaProviderAccess):
            access_dict = provider_access.to_dict()
        else:
            access_dict = provider_access

        # Notify hooks
        for hook in self._provider_hooks:
            try:
                hook(step_id, access_dict)
            except Exception:
                pass

        if self._external_logger:
            self._external_logger.log_provider_access(
                step_id=step_id,
                provider_name=access_dict.get("providerName", "unknown"),
                data=access_dict.get("data", {}),
                purpose=access_dict.get("purpose", "context"),
                query=access_dict.get("query"),
            )
            return

        # Find the step
        for trajectory in self._active_trajectories.values():
            for step in trajectory["steps"]:
                if step["stepId"] == step_id:
                    access_dict["providerId"] = str(uuid.uuid4())
                    access_dict["timestamp"] = int(time.time() * 1000)
                    step["providerAccesses"].append(access_dict)
                    return

    def log_provider_access_by_trajectory_id(
        self,
        trajectory_id: str,
        provider_access: ElizaProviderAccess | dict,
    ) -> None:
        """Log a provider access using trajectory ID (uses current step)."""
        step_id = self._active_steps.get(trajectory_id)
        if step_id:
            self.log_provider_access(step_id, provider_access)

    def complete_step(
        self,
        trajectory_id: str,
        step_id: str,
        action: ElizaActionAttempt | dict,
        reward: float | None = None,
        done: bool = False,
    ) -> None:
        """Complete a step with action outcome."""
        if isinstance(action, ElizaActionAttempt):
            action_dict = action.to_dict()
        else:
            action_dict = action

        # Notify hooks
        for hook in self._action_hooks:
            try:
                hook(trajectory_id, step_id, action_dict, reward)
            except Exception:
                pass

        if self._external_logger:
            self._external_logger.complete_step(
                trajectory_id=trajectory_id,
                step_id=step_id,
                action_type=action_dict.get("actionType", "unknown"),
                action_name=action_dict.get("actionName", "unknown"),
                parameters=action_dict.get("parameters", {}),
                success=action_dict.get("success", True),
                reward=reward,
                error=action_dict.get("error"),
                result=action_dict.get("result"),
                reasoning=action_dict.get("reasoning"),
            )
            return

        trajectory = self._active_trajectories.get(trajectory_id)
        if not trajectory:
            return

        for step in trajectory["steps"]:
            if step["stepId"] == step_id:
                step["action"] = {
                    "attemptId": str(uuid.uuid4()),
                    "timestamp": int(time.time() * 1000),
                    **action_dict,
                }
                step["done"] = done
                if reward is not None:
                    step["reward"] = reward
                    trajectory["totalReward"] += reward
                break

        self._active_steps.pop(trajectory_id, None)

    def complete_current_step(
        self,
        trajectory_id: str,
        action: ElizaActionAttempt | dict,
        reward: float | None = None,
        done: bool = False,
    ) -> None:
        """Complete the current step for a trajectory."""
        step_id = self._active_steps.get(trajectory_id)
        if step_id:
            self.complete_step(trajectory_id, step_id, action, reward, done)

    def end_trajectory(
        self,
        trajectory_id: str,
        status: str = "completed",
        final_metrics: dict | None = None,
    ) -> dict:
        """End and persist the trajectory. Returns the trajectory data."""
        if self._external_logger:
            self._external_logger.end_trajectory(
                trajectory_id=trajectory_id,
                status=status,
                final_metrics=final_metrics,
            )
            return {}

        trajectory = self._active_trajectories.pop(trajectory_id, None)
        if not trajectory:
            return {}

        now = int(time.time() * 1000)
        trajectory["endTime"] = now
        trajectory["durationMs"] = now - trajectory["startTime"]
        trajectory["metrics"]["finalStatus"] = status
        trajectory["metrics"]["episodeLength"] = len(trajectory["steps"])

        if final_metrics:
            trajectory["metrics"].update(final_metrics)

        # Save to file if auto-persist is enabled
        if self._auto_persist:
            output_path = self.data_dir / f"{trajectory_id}.json"
            with open(output_path, "w") as f:
                json.dump(trajectory, f, indent=2)

        return trajectory

    def get_active_trajectory(self, trajectory_id: str) -> dict | None:
        """Get an active trajectory by ID."""
        return self._active_trajectories.get(trajectory_id)

    def get_all_active_trajectories(self) -> list[dict]:
        """Get all active trajectories."""
        return list(self._active_trajectories.values())

    def load_trajectory(self, trajectory_id: str) -> dict | None:
        """Load a persisted trajectory from disk."""
        path = self.data_dir / f"{trajectory_id}.json"
        if path.exists():
            with open(path) as f:
                return json.load(f)
        return None

    def list_trajectories(self) -> list[str]:
        """List all persisted trajectory IDs."""
        return [p.stem for p in self.data_dir.glob("*.json")]


def convert_to_eliza_trajectory(
    art_trajectory: Trajectory,
    agent_id: str,
) -> dict:
    """
    Convert an ART Trajectory to ElizaOS trajectory format.
    
    This enables using trajectories collected by ART with the
    plugin-trajectory-logger export functions.
    """
    steps = []

    for i, msg_pair in enumerate(_pair_messages(art_trajectory.messages)):
        step = {
            "stepId": str(uuid.uuid4()),
            "stepNumber": i,
            "timestamp": int(time.time() * 1000),
            "environmentState": {
                "timestamp": int(time.time() * 1000),
                "agentBalance": 0,
                "agentPoints": 0,
                "agentPnL": 0,
                "openPositions": 0,
                "custom": {},
            },
            "observation": {},
            "llmCalls": [],
            "providerAccesses": [],
            "action": {
                "attemptId": str(uuid.uuid4()),
                "timestamp": int(time.time() * 1000),
                "actionType": "respond",
                "actionName": "respond",
                "parameters": {},
                "success": True,
            },
            "reward": 0.0,
            "done": False,
        }

        # Add LLM call from message pair
        if msg_pair.get("user") and msg_pair.get("assistant"):
            step["llmCalls"].append({
                "callId": str(uuid.uuid4()),
                "timestamp": int(time.time() * 1000),
                "model": art_trajectory.metadata.get("model", "unknown"),
                "systemPrompt": msg_pair.get("system", ""),
                "userPrompt": msg_pair["user"],
                "response": msg_pair["assistant"],
                "temperature": 0.7,
                "maxTokens": 2048,
                "purpose": "action",
            })

        steps.append(step)

    return {
        "trajectoryId": art_trajectory.trajectory_id,
        "agentId": agent_id,
        "startTime": int(time.time() * 1000),
        "endTime": int(time.time() * 1000),
        "durationMs": 0,
        "episodeId": None,
        "scenarioId": art_trajectory.scenario_id,
        "batchId": None,
        "groupIndex": None,
        "steps": steps,
        "totalReward": art_trajectory.reward,
        "rewardComponents": {"environmentReward": art_trajectory.reward},
        "metrics": {
            "episodeLength": len(steps),
            "finalStatus": "completed",
            **art_trajectory.metrics,
        },
        "metadata": art_trajectory.metadata,
    }


def _pair_messages(messages: list[dict]) -> list[dict]:
    """Pair user/assistant messages from flat message list."""
    pairs = []
    current_pair: dict = {}

    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")

        if role == "system":
            current_pair["system"] = content
        elif role == "user":
            current_pair["user"] = content
        elif role == "assistant":
            current_pair["assistant"] = content
            pairs.append(current_pair)
            current_pair = {"system": current_pair.get("system", "")}

    return pairs


# Context manager for trajectory logging
class TrajectoryLoggingContext:
    """
    Context manager for automatic trajectory lifecycle management.
    
    Usage:
        ```python
        logger = ElizaTrajectoryLogger(agent_id="my-agent")
        
        async with TrajectoryLoggingContext(
            logger,
            scenario_id="game-scenario-1",
            metadata={"game": "2048"},
        ) as ctx:
            # ctx.trajectory_id is available
            # Steps are automatically created/completed
            await run_episode(ctx)
        # Trajectory is automatically ended
        ```
    """

    def __init__(
        self,
        logger: ElizaTrajectoryLogger,
        scenario_id: str | None = None,
        episode_id: str | None = None,
        batch_id: str | None = None,
        group_index: int | None = None,
        metadata: dict | None = None,
    ):
        self._logger = logger
        self._scenario_id = scenario_id
        self._episode_id = episode_id
        self._batch_id = batch_id
        self._group_index = group_index
        self._metadata = metadata
        self.trajectory_id: str = ""
        self._final_status = "completed"

    async def __aenter__(self) -> "TrajectoryLoggingContext":
        self.trajectory_id = self._logger.start_trajectory(
            scenario_id=self._scenario_id,
            episode_id=self._episode_id,
            batch_id=self._batch_id,
            group_index=self._group_index,
            metadata=self._metadata,
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        if exc_type is not None:
            self._final_status = "error"
        self._logger.end_trajectory(self.trajectory_id, self._final_status)

    def set_status(self, status: str) -> None:
        """Set the final status before exit."""
        self._final_status = status

    def start_step(self, env_state: ElizaEnvironmentState | dict) -> str:
        """Start a new step in the trajectory."""
        return self._logger.start_step(self.trajectory_id, env_state)

    def log_llm_call(self, step_id: str, llm_call: ElizaLLMCall | dict) -> None:
        """Log an LLM call within a step."""
        self._logger.log_llm_call(step_id, llm_call)

    def log_provider_access(
        self, step_id: str, provider_access: ElizaProviderAccess | dict
    ) -> None:
        """Log a provider access within a step."""
        self._logger.log_provider_access(step_id, provider_access)

    def complete_step(
        self,
        step_id: str,
        action: ElizaActionAttempt | dict,
        reward: float | None = None,
        done: bool = False,
    ) -> None:
        """Complete a step with action outcome."""
        self._logger.complete_step(self.trajectory_id, step_id, action, reward, done)
