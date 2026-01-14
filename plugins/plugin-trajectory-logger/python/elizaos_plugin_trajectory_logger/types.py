from __future__ import annotations

from typing import Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field

# NOTE: Avoid recursive JsonValue aliases here to keep Pydantic schema generation reliable.
# Use a broad `object` value type for metadata-like fields.
JsonValue: TypeAlias = object


class LLMMessage(BaseModel):
    role: str
    content: str


LLMPurpose: TypeAlias = Literal["action", "reasoning", "evaluation", "response", "other"]


class LLMCall(BaseModel):
    call_id: str
    timestamp: int
    model: str
    model_version: str | None = None

    system_prompt: str
    user_prompt: str
    messages: list[LLMMessage] | None = None

    response: str
    reasoning: str | None = None

    temperature: float
    max_tokens: int
    top_p: float | None = None

    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    latency_ms: int | None = None

    purpose: LLMPurpose
    action_type: str | None = None


class ProviderAccess(BaseModel):
    provider_id: str
    provider_name: str
    timestamp: int

    query: dict[str, JsonValue] | None = None
    data: dict[str, JsonValue]
    purpose: str


class ActionAttempt(BaseModel):
    attempt_id: str
    timestamp: int

    action_type: str
    action_name: str
    parameters: dict[str, JsonValue]

    reasoning: str | None = None
    llm_call_id: str | None = None

    success: bool
    result: dict[str, JsonValue] | None = None
    error: str | None = None

    immediate_reward: float | None = None


class EnvironmentState(BaseModel):
    timestamp: int
    agent_balance: float
    agent_points: float
    agent_pnl: float
    open_positions: int

    active_markets: int | None = None
    portfolio_value: float | None = None

    unread_messages: int | None = None
    recent_engagement: int | None = None

    custom: dict[str, JsonValue] | None = None


class TrajectoryStep(BaseModel):
    step_id: str
    step_number: int
    timestamp: int

    environment_state: EnvironmentState
    observation: dict[str, JsonValue] = Field(default_factory=dict)

    llm_calls: list[LLMCall] = Field(default_factory=list)
    provider_accesses: list[ProviderAccess] = Field(default_factory=list)
    reasoning: str | None = None

    action: ActionAttempt

    reward: float = 0.0
    done: bool = False

    metadata: dict[str, JsonValue] | None = None


class RewardComponentsBreakdown(BaseModel):
    model_config = ConfigDict(extra="allow")

    profit_loss: float | None = None
    prediction_accuracy: float | None = None
    social_engagement: float | None = None
    risk_adjusted: float | None = None


class RewardComponents(BaseModel):
    environment_reward: float = 0.0
    ai_judge_reward: float | None = None

    components: RewardComponentsBreakdown | None = None

    judge_model: str | None = None
    judge_reasoning: str | None = None
    judge_timestamp: int | None = None


FinalStatus: TypeAlias = Literal["completed", "terminated", "error", "timeout"]


class TrajectoryMetrics(BaseModel):
    model_config = ConfigDict(extra="allow")

    episode_length: int = 0
    final_status: FinalStatus = "completed"

    final_balance: float | None = None
    final_pnl: float | None = None
    trades_executed: int | None = None
    posts_created: int | None = None
    messages_handled: int | None = None

    success_rate: float | None = None
    error_count: int | None = None


class Trajectory(BaseModel):
    trajectory_id: str
    agent_id: str

    start_time: int
    end_time: int
    duration_ms: int

    episode_id: str | None = None
    scenario_id: str | None = None
    batch_id: str | None = None
    group_index: int | None = None

    steps: list[TrajectoryStep] = Field(default_factory=list)

    total_reward: float = 0.0
    reward_components: RewardComponents = Field(default_factory=RewardComponents)
    metrics: TrajectoryMetrics = Field(default_factory=TrajectoryMetrics)
    metadata: dict[str, JsonValue] = Field(default_factory=dict)


ChatRole: TypeAlias = Literal["system", "user", "assistant"]


class ChatMessage(BaseModel):
    role: ChatRole
    content: str
    name: str | None = None


class ARTTrajectoryMetadata(BaseModel):
    model_config = ConfigDict(extra="allow")

    trajectory_id: str
    agent_id: str
    scenario_id: str | None = None
    group_index: int | None = None


class ARTTrajectory(BaseModel):
    messages: list[ChatMessage]
    reward: float
    metadata: dict[str, JsonValue]
    metrics: dict[str, float] | None = None


class TrajectoryGroup(BaseModel):
    group_id: str
    scenario_id: str
    trajectories: list[Trajectory]
    shared_prefix: list[ChatMessage] | None = None
    rankings: list[int] | None = None
    normalized_rewards: list[float] | None = None
    ruler_scores: list[float] | None = None
    created_at: int
    model_version: str | None = None


class TrainingBatch(BaseModel):
    batch_id: str
    scenario_id: str | None = None
    groups: list[TrajectoryGroup]
    created_at: int
    model_version: str
    training_config: dict[str, JsonValue] | None = None
