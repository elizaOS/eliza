"""Core types for ADHDBench."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Literal


class ScenarioLevel(Enum):
    """Which cognitive level this scenario targets."""

    ACTION_DISPATCH = 0     # Single-turn: did the right action fire?
    CONTEXT_TRACKING = 1    # Multi-turn: can the agent maintain context?
    COMPLEX_EXECUTION = 2   # Multi-step: can the agent plan and execute?


class OutcomeType(Enum):
    """How to evaluate one assertion about the agent's response."""

    ACTION_MATCH = "action_match"
    """Expected action(s) were selected by the agent."""

    ACTION_NOT_MATCH = "action_not_match"
    """Expected action(s) were NOT selected (negative test)."""

    TEXT_CONTAINS = "text_contains"
    """Response text contains the specified substring (case-insensitive)."""

    TEXT_NOT_CONTAINS = "text_not_contains"
    """Response text does NOT contain the specified substring."""

    PARAM_MATCH = "param_match"
    """Action parameters contain expected key-value pairs (partial match)."""

    MEMORY_RECALLED = "memory_recalled"
    """A fact from earlier in the conversation appears in the response text."""

    PROVIDERS_REQUESTED = "providers_requested"
    """Specific providers were requested in the LLM's provider selection."""


@dataclass(frozen=True)
class ExpectedOutcome:
    """One assertion about the agent's response after a turn."""

    outcome_type: OutcomeType
    value: str | list[str] | dict[str, str]
    """
    Interpretation depends on outcome_type:
      - ACTION_MATCH / ACTION_NOT_MATCH: str or list[str] of action names.
      - TEXT_CONTAINS / TEXT_NOT_CONTAINS / MEMORY_RECALLED: str substring.
      - PARAM_MATCH: dict[str, str] mapping param_name -> expected_value.
      - PROVIDERS_REQUESTED: str or list[str] of provider names.
    """

    weight: float = 1.0
    """Contribution of this outcome to the turn's score.  Relative within a turn."""


@dataclass(frozen=True)
class Turn:
    """One message in a benchmark conversation."""

    role: Literal["user", "system"]
    """Who sends this turn.  'system' injects context without triggering agent
    response (used for conversation pre-fill)."""

    text: str
    """The message content."""

    expected_outcomes: tuple[ExpectedOutcome, ...] = ()
    """Outcomes to check AFTER this turn's response.  Empty for system turns
    and turns where we only care about setting up context."""

    new_session: bool = False
    """If True, start a new room_id before this turn.  The entity_id (user)
    stays the same, simulating the user returning in a new session."""

    delay_seconds: float = 0.0
    """Optional delay before sending this turn.  Allows the runtime's
    background evaluators (summarization, long-term extraction) to run."""


@dataclass(frozen=True)
class Scenario:
    """A complete test scenario with one or more turns."""

    id: str
    name: str
    description: str
    level: ScenarioLevel
    turns: tuple[Turn, ...]

    tags: tuple[str, ...] = ()
    """For filtering scenarios (e.g. 'memory', 'planning', 'contact_mgmt')."""

    requires_advanced_memory: bool = False
    requires_advanced_planning: bool = False

    distractor_action_count: int = 0
    """How many distractor actions to register beyond bootstrap defaults.
    0 means only bootstrap actions are present."""


@dataclass(frozen=True)
class ScalePoint:
    """Defines the context load for a benchmark run."""

    action_count: int
    """Total actions registered (bootstrap + distractors)."""

    provider_count: int
    """Total providers registered (bootstrap + any extras)."""

    conversation_prefill: int
    """Messages pre-filled in the conversation before the test starts."""

    @property
    def label(self) -> str:
        return f"a{self.action_count}_p{self.provider_count}_m{self.conversation_prefill}"


DEFAULT_SCALE_POINTS: tuple[ScalePoint, ...] = (
    ScalePoint(action_count=10,  provider_count=8,  conversation_prefill=0),
    ScalePoint(action_count=25,  provider_count=12, conversation_prefill=10),
    ScalePoint(action_count=50,  provider_count=18, conversation_prefill=30),
    ScalePoint(action_count=100, provider_count=24, conversation_prefill=60),
    ScalePoint(action_count=200, provider_count=30, conversation_prefill=100),
)


@dataclass
class OutcomeResult:
    """Whether one expected outcome was met."""

    outcome: ExpectedOutcome
    passed: bool
    actual_value: str
    detail: str


@dataclass
class TurnResult:
    """Result of processing one turn."""

    turn_index: int
    actions_selected: list[str]
    providers_requested: list[str]
    response_text: str
    providers_actually_run: list[str]
    outcome_results: list[OutcomeResult]
    latency_ms: float
    raw_llm_response: str = ""
    thought: str = ""


@dataclass
class ScenarioResult:
    """Result of running one scenario at one scale point and config."""

    scenario_id: str
    scenario_name: str
    level: ScenarioLevel
    scale_point: ScalePoint
    config_name: str
    turn_results: list[TurnResult]
    score: float
    total_latency_ms: float
    model_name: str
    error: str | None = None


@dataclass
class ScalingCurvePoint:
    """One data point on the attention scaling curve."""

    scale_label: str
    action_count: int
    provider_count: int
    conversation_prefill: int
    score: float
    latency_ms: float
    scenario_count: int


@dataclass
class BenchmarkResults:
    """Complete benchmark output."""

    metadata: dict[str, str | int | float]
    results: list[ScenarioResult]
    scaling_curves: dict[str, list[ScalingCurvePoint]]
    baselines: dict[str, float]
    timestamp: str = field(default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ"))
