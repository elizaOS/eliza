"""
Shared type definitions for RL training.
Strong, validated types.
"""

from typing import Dict, List, Literal
from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime
from pydantic.alias_generators import to_camel

# Type alias for JSON-serializable values
JsonDict = Dict[str, object]

# Type alias for chat messages with known structure
ChatMessage = Dict[str, str]  # {"role": str, "content": str}

# Base config for camelCase conversion, to be used by all models
camel_case_config = ConfigDict(
    alias_generator=to_camel,
    populate_by_name=True,
)


class EnvironmentState(BaseModel):
    """Environment state at a given point"""
    model_config = camel_case_config

    agent_balance: float
    # Explicit alias for the 'agentPnL' field from the JSON data
    agent_pnl: float = Field(..., alias='agentPnL')
    open_positions: int
    active_markets: int = 0


class ProviderAccess(BaseModel):
    """Data accessed from a provider"""
    # Combines camelCase conversion with allowing extra fields
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="allow"
    )

    provider_name: str
    data: JsonDict
    purpose: str


class LLMCall(BaseModel):
    """
    Single LLM call record.
    Matches the TypeScript LLMCall interface in plugin-trajectory-logger/types.ts
    """
    model_config = camel_case_config

    model: str
    model_version: str | None = None
    system_prompt: str
    user_prompt: str
    response: str
    reasoning: str | None = None
    temperature: float
    max_tokens: int
    latency_ms: int | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    purpose: Literal['action', 'reasoning', 'evaluation', 'response', 'other']
    action_type: str | None = None


class Action(BaseModel):
    """Action taken by agent"""
    # Combines camelCase conversion with allowing extra fields
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="allow"
    )

    action_type: str
    parameters: JsonDict
    success: bool
    result: JsonDict | None = None
    error: str | None = None
    reasoning: str | None = None


class TrajectoryStep(BaseModel):
    """Single step in a trajectory"""
    model_config = camel_case_config

    step_number: int
    timestamp: int
    environment_state: EnvironmentState
    provider_accesses: List[ProviderAccess] = Field(default_factory=list)
    llm_calls: List[LLMCall] = Field(default_factory=list)
    action: Action | None = None
    reward: float = 0.0


class TrainingTrajectory(BaseModel):
    """Complete trajectory from database"""
    # Combines camelCase conversion with mutability
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        frozen=False
    )

    trajectory_id: str
    agent_id: str

    id: str = ""
    window_id: str = "default"
    start_time: datetime | None = None
    end_time: datetime | None = None
    duration_ms: int = 0
    scenario_id: str | None = None
    episode_id: str | None = None
    steps: List[TrajectoryStep] = Field(default_factory=list)
    total_reward: float = 0.0
    final_pnl: float = 0.0
    final_balance: float | None = None
    trades_executed: int = 0
    successful_trades: int = 0
    failed_trades: int = 0
    posts_created: int = 0
    provider_accesses: int = 0
    episode_length: int = 0
    final_status: str = "completed"
    archetype: str | None = None


class StockOutcome(BaseModel):
    """Market outcome for a stock"""
    model_config = camel_case_config
    ticker: str
    start_price: float
    end_price: float
    change_percent: float
    sentiment: Literal['BULLISH', 'BEARISH', 'NEUTRAL'] | None = None
    news_events: List[str] = Field(default_factory=list)


class PredictionOutcome(BaseModel):
    """Outcome for a prediction market"""
    model_config = camel_case_config
    market_id: str
    question: str
    outcome: Literal['YES', 'NO', 'UNRESOLVED']
    final_probability: float


class MarketOutcomes(BaseModel):
    """All market outcomes for a window"""
    model_config = camel_case_config
    window_id: str
    window_start: datetime
    window_end: datetime
    stocks: dict[str, StockOutcome] = Field(default_factory=dict)
    predictions: dict[str, PredictionOutcome] = Field(default_factory=dict)
    overall_trend: Literal['BULLISH', 'BEARISH', 'NEUTRAL'] | None = None
    volatility: Literal['HIGH', 'MEDIUM', 'LOW'] | None = None


class WindowStatistics(BaseModel):
    """Statistics for a training window"""
    model_config = camel_case_config
    window_id: str
    agent_count: int
    trajectory_count: int
    total_actions: int
    avg_pnl: float
    min_pnl: float
    max_pnl: float
    start_time: datetime
    end_time: datetime


class TrainingBatchSummary(BaseModel):
    """Summary of a training batch"""
    model_config = camel_case_config
    windows: int
    total_trajectories: int
    avg_trajectories_per_window: float
    score_min: float
    score_max: float
    score_avg: float
    pnl_min: float
    pnl_max: float
    pnl_avg: float


# =============================================================================
# Atropos-compatible types
# =============================================================================


class AtroposScoredItem(BaseModel):
    """Single scored item for Atropos training"""
    model_config = camel_case_config
    tokens: List[int]
    masks: List[int]
    score: float
    logprobs: List[float] = Field(default_factory=list)
    messages: List[ChatMessage] = Field(default_factory=list)


class AtroposScoredGroup(BaseModel):
    """Group of scored items for Atropos GRPO training"""
    model_config = camel_case_config
    tokens: List[List[int]]
    masks: List[List[int]]
    scores: List[float]
    inference_logprobs: List[List[float]] = Field(default_factory=list)
    messages: List[List[ChatMessage]] = Field(default_factory=list)
    env_id: int | None = None

    @property
    def group_size(self) -> int:
        return len(self.tokens)


class TrajectoryGroup(BaseModel):
    """Group of trajectories for relative comparison"""
    model_config = camel_case_config
    group_key: str
    window_id: str
    scenario_id: str | None = None
    trajectories: List[TrainingTrajectory]

    @property
    def size(self) -> int:
        return len(self.trajectories)

    def get_pnl_stats(self) -> dict:
        """Get P&L statistics for the group"""
        pnls = [t.final_pnl for t in self.trajectories]
        return {
            "min": min(pnls) if pnls else 0,
            "max": max(pnls) if pnls else 0,
            "mean": sum(pnls) / len(pnls) if pnls else 0,
        }


class JudgeScore(BaseModel):
    """Score from LLM judge for a trajectory"""
    model_config = camel_case_config
    trajectory_id: str
    score: float = Field(ge=0.0, le=1.0)
    explanation: str
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class JudgeResponse(BaseModel):
    """Response from LLM judge for a group of trajectories"""
    model_config = camel_case_config
    reasoning: str
    scores: List[JudgeScore]

    def get_score_for(self, trajectory_id: str) -> float | None:
        """Get score for a specific trajectory"""
        for score in self.scores:
            if score.trajectory_id == trajectory_id:
                return score.score
        return None


# Backward compatibility alias while downstream code migrates.
BabylonTrajectory = TrainingTrajectory


class TrainingMetrics(BaseModel):
    """Metrics from a training step"""
    model_config = camel_case_config
    step: int
    loss: float
    grad_norm: float
    learning_rate: float
    pos_logp: float = 0.0
    neg_logp: float = 0.0
    num_samples: int = 0
    timestamp: datetime = Field(default_factory=datetime.now)
