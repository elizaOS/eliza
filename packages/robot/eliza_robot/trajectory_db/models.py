"""Pydantic models for trajectory data.

These mirror the TypeScript types defined in
``plugin-trajectory-logger/typescript/types.ts`` with proper snake_case naming.
"""

from __future__ import annotations

import enum
from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class TrajectoryStatus(str, enum.Enum):
    ACTIVE = "active"
    COMPLETED = "completed"
    TERMINATED = "terminated"
    ERROR = "error"
    TIMEOUT = "timeout"


class LLMCallPurpose(str, enum.Enum):
    ACTION = "action"
    REASONING = "reasoning"
    EVALUATION = "evaluation"
    RESPONSE = "response"
    OTHER = "other"


# ---------------------------------------------------------------------------
# Step-level records
# ---------------------------------------------------------------------------

class LLMCallRecord(BaseModel):
    """Mirrors TS ``LLMCall``."""

    call_id: str
    timestamp: float
    model: str
    system_prompt: str = ""
    user_prompt: str = ""
    messages: Optional[list[dict]] = None
    response: str = ""
    reasoning: Optional[str] = None
    temperature: float = 1.0
    max_tokens: int = 0
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    latency_ms: Optional[float] = None
    purpose: LLMCallPurpose = LLMCallPurpose.OTHER


class ProviderAccessRecord(BaseModel):
    """Mirrors TS ``ProviderAccess``."""

    provider_id: str
    provider_name: str
    timestamp: float
    query: Optional[dict] = None
    data: dict = Field(default_factory=dict)
    purpose: str = ""


class ActionAttemptRecord(BaseModel):
    """Mirrors TS ``ActionAttempt``."""

    attempt_id: str
    timestamp: float
    action_type: str
    action_name: str
    parameters: dict = Field(default_factory=dict)
    reasoning: Optional[str] = None
    llm_call_id: Optional[str] = None
    success: bool = True
    result: Optional[dict] = None
    error: Optional[str] = None
    immediate_reward: Optional[float] = None


class TrajectoryStepRecord(BaseModel):
    """Mirrors TS ``TrajectoryStep``."""

    step_id: str
    step_number: int
    timestamp: float
    environment_state: dict = Field(default_factory=dict)
    observation: dict = Field(default_factory=dict)
    llm_calls: list[LLMCallRecord] = Field(default_factory=list)
    provider_accesses: list[ProviderAccessRecord] = Field(default_factory=list)
    reasoning: Optional[str] = None
    action: ActionAttemptRecord
    reward: float = 0.0
    done: bool = False
    metadata: Optional[dict] = None


# ---------------------------------------------------------------------------
# Top-level trajectory record
# ---------------------------------------------------------------------------

class TrajectoryRecord(BaseModel):
    """Mirrors TS ``Trajectory`` / ``TrajectoryRecord`` combined."""

    trajectory_id: str
    agent_id: str
    source: str = ""
    archetype: Optional[str] = None
    window_id: Optional[str] = None
    scenario_id: Optional[str] = None
    batch_id: Optional[str] = None
    episode_id: Optional[str] = None
    status: TrajectoryStatus = TrajectoryStatus.ACTIVE
    start_time: float
    end_time: Optional[float] = None
    duration_ms: int = 0
    steps: list[TrajectoryStepRecord] = Field(default_factory=list)
    total_reward: float = 0.0
    reward_components: Optional[dict] = None
    ai_judge_reward: Optional[float] = None
    ai_judge_reasoning: Optional[str] = None
    final_status: Optional[str] = None
    final_pnl: Optional[float] = None
    final_balance: Optional[float] = None
    episode_length: int = 0
    metrics: dict = Field(default_factory=dict)
    metadata: dict = Field(default_factory=dict)
    is_training_data: bool = False
    is_evaluation: bool = False
    used_in_training: bool = False


# ---------------------------------------------------------------------------
# Robot-specific records
# ---------------------------------------------------------------------------

class ControlFrame(BaseModel):
    """High-frequency robot control data (50-100 Hz)."""

    timestamp: float
    joint_positions: Optional[list[float]] = None
    joint_velocities: Optional[list[float]] = None
    joint_targets: Optional[list[float]] = None
    imu_roll: float = 0.0
    imu_pitch: float = 0.0
    gyro: Optional[list[float]] = None
    entity_slots: Optional[list[float]] = None
    action_applied: Optional[list[float]] = None
    reward: float = 0.0


class EmbodiedContext(BaseModel):
    """Snapshot of world state at decision time -- generic across envs."""

    timestamp: float
    entities: list[dict] = Field(default_factory=list)
    camera_views: list[str] = Field(default_factory=list)
    agent_pose: Optional[dict] = None
    task_description: str = ""
    source: str = ""  # hyperscape, mujoco, real_robot
