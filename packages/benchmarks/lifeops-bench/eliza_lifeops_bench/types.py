"""Type definitions for LifeOpsBench."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal


class Domain(Enum):
    """Life-assistant task domain."""

    CALENDAR = "calendar"
    MAIL = "mail"
    MESSAGES = "messages"
    CONTACTS = "contacts"
    REMINDERS = "reminders"
    FINANCE = "finance"
    TRAVEL = "travel"
    HEALTH = "health"
    SLEEP = "sleep"
    FOCUS = "focus"


class ScenarioMode(Enum):
    """How a scenario drives the user side of the conversation."""

    STATIC = "static"
    LIVE = "live"


@dataclass(frozen=True)
class Action:
    """A tool call requested by the agent. Mirrors tau-bench's Action."""

    name: str
    kwargs: dict[str, Any] = field(default_factory=dict)


@dataclass
class MessageTurn:
    """A single chat turn in standard chat-completions shape.

    `tool_calls` is the raw assistant tool-call payload (when role == "assistant").
    `tool_call_id` and `name` correlate a `role == "tool"` turn back to the call.
    """

    role: Literal["user", "assistant", "system", "tool"]
    content: str
    name: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None


@dataclass(frozen=True)
class Persona:
    """User persona that drives the simulated user side. Tau-bench-inspired."""

    id: str
    name: str
    traits: list[str]
    background: str
    communication_style: str
    patience_turns: int = 50


@dataclass(frozen=True)
class FirstQuestionFallback:
    """Canned answer used in STATIC mode when the agent opens with a clarifier.

    `applies_when` is a natural-language predicate the evaluator inspects to
    decide whether the agent's first message is a clarifying question that the
    fallback can answer.
    """

    canned_answer: str
    applies_when: str


@dataclass(frozen=True)
class Scenario:
    """A single benchmark scenario."""

    id: str
    name: str
    domain: Domain
    mode: ScenarioMode
    persona: Persona
    instruction: str
    ground_truth_actions: list[Action]
    required_outputs: list[str]
    first_question_fallback: FirstQuestionFallback | None
    world_seed: int
    max_turns: int = 50
    description: str = ""
    now_iso: str = "2026-05-10T12:00:00Z"


@dataclass
class TurnResult:
    """Per-turn telemetry captured during a scenario run."""

    turn_number: int
    agent_message: str
    agent_actions: list[Action]
    user_response: str
    latency_ms: int
    input_tokens: int
    output_tokens: int
    cost_usd: float


@dataclass
class ScenarioResult:
    """Outcome of running a single scenario at a single seed."""

    scenario_id: str
    seed: int
    turns: list[TurnResult]
    state_hash_match: bool
    output_substring_matches: list[bool]
    total_score: float
    max_score: float
    terminated_reason: Literal[
        "respond", "satisfied", "max_turns", "error", "timeout", "cost_exceeded"
    ]
    total_cost_usd: float
    total_latency_ms: int
    error: str | None = None


@dataclass
class BenchmarkResult:
    """Aggregated results for a full benchmark run."""

    scenarios: list[ScenarioResult]
    pass_at_1: float
    pass_at_k: float
    mean_score_per_domain: dict[str, float]
    total_cost_usd: float
    total_latency_ms: int
    model_name: str
    judge_model_name: str
    timestamp: str
    seeds: int
