"""
Trajectory Adapter for ElizaOS plugin-trajectory-logger

Maps ART trajectories to ElizaOS trajectory format for:
- Persistent storage
- Export to HuggingFace
- GRPO grouping
- RULER scoring integration
"""

import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable

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
    ) -> None:
        """Log an LLM call within a step."""
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
    purpose: str = "action"
    action_type: str | None = None
    latency_ms: int | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None

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
        }


class ElizaTrajectoryLogger:
    """
    Adapter that wraps ART trajectory logging to ElizaOS format.
    
    When an external TrajectoryLoggerService is available, uses it.
    Otherwise, provides a standalone implementation that stores
    trajectories locally in ElizaOS-compatible format.
    """

    def __init__(
        self,
        agent_id: str,
        data_dir: str | Path = "./data/trajectories",
        external_logger: TrajectoryLoggerService | None = None,
    ):
        self.agent_id = agent_id
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._external_logger = external_logger
        
        # Active trajectories (when not using external logger)
        self._active_trajectories: dict[str, dict] = {}
        self._active_steps: dict[str, str] = {}  # trajectory_id -> current_step_id

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

        if self._external_logger:
            self._external_logger.log_llm_call(
                step_id=step_id,
                model=call_dict["model"],
                system_prompt=call_dict["systemPrompt"],
                user_prompt=call_dict["userPrompt"],
                response=call_dict["response"],
                temperature=call_dict.get("temperature", 0.7),
                max_tokens=call_dict.get("maxTokens", 2048),
                purpose=call_dict.get("purpose", "action"),
                action_type=call_dict.get("actionType"),
                latency_ms=call_dict.get("latencyMs"),
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
    ) -> None:
        """Complete a step with action outcome."""
        if self._external_logger:
            self._external_logger.complete_step(
                trajectory_id=trajectory_id,
                step_id=step_id,
                action_type=action_type,
                action_name=action_name,
                parameters=parameters,
                success=success,
                reward=reward,
                error=error,
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
                    "actionType": action_type,
                    "actionName": action_name,
                    "parameters": parameters,
                    "success": success,
                    "error": error,
                }
                if reward is not None:
                    step["reward"] = reward
                    trajectory["totalReward"] += reward
                break

        self._active_steps.pop(trajectory_id, None)

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

        # Save to file
        output_path = self.data_dir / f"{trajectory_id}.json"
        with open(output_path, "w") as f:
            json.dump(trajectory, f, indent=2)

        return trajectory

    def get_active_trajectory(self, trajectory_id: str) -> dict | None:
        """Get an active trajectory by ID."""
        return self._active_trajectories.get(trajectory_id)


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
