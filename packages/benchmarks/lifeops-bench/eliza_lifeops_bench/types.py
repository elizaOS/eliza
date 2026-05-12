"""Type definitions for LifeOpsBench."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal

DisruptionKind = Literal[
    "new_message",
    "calendar_change",
    "reminder_due",
    "rule_change",
]


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

    Per-turn telemetry (`cost_usd`, `latency_ms`, `input_tokens`,
    `output_tokens`) lives on the dataclass itself so the runner can read it
    without ``getattr`` games. All four are :data:`None` when the provider
    didn't expose the corresponding number — per AGENTS.md Cmd #8, missing
    data stays nullable rather than masquerading as ``0.0`` / ``0``. This
    matters for sub-turns that are pure user / tool messages (no model call
    happened, so there is nothing to bill or time) and for unpriced models
    where pricing tables can't compute a real cost.
    """

    role: Literal["user", "assistant", "system", "tool"]
    content: str
    name: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None
    cost_usd: float | None = None
    latency_ms: float | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None


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
class Disruption:
    """A scripted mid-run world mutation injected by the LIVE runner.

    Disruptions model REALM-Bench-style perturbations: an urgent email
    arrives mid-conversation, a meeting gets cancelled, a new reminder
    fires. Applied AFTER the agent's turn at ``at_turn`` finishes (i.e.
    the disruption is visible to the agent starting on the next turn).

    ``payload`` shape depends on ``kind``:
      - ``new_message``     — ``{message_id, thread_id, from_email, subject, body}``
      - ``calendar_change`` — ``{event_id, action: "cancel"|"move", start?, end?}``
      - ``reminder_due``    — ``{reminder_id, list_id, title, due_at}``
      - ``rule_change``     — natural-language note threaded into the
        next simulated user turn (no world mutation)
    """

    at_turn: int
    kind: DisruptionKind
    payload: dict[str, Any]
    note_for_user: str = ""


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
    success_criteria: list[str] = field(default_factory=list)
    world_assertions: list[str] = field(default_factory=list)
    disruptions: list[Disruption] = field(default_factory=list)


def attach_usage_cache_fields(turn: Any, usage: dict[str, Any]) -> None:
    """Parse OpenAI / Cerebras / Anthropic-shaped ``usage`` onto a turn.

    Sets ``input_tokens`` / ``output_tokens`` / ``cache_read_input_tokens`` /
    ``cache_creation_input_tokens`` / ``cache_supported`` as attributes on
    ``turn`` (via ``setattr``) so :class:`LifeOpsBenchRunner` can pick them
    up with ``getattr``. Cache fields stay ``None`` when the provider does
    not report them — per AGENTS.md Cmd #8, no silent ``0`` fallback.

    Used by the hermes-adapter and openclaw-adapter LifeOpsBench glue. The
    eliza-adapter receives camelCase rollups from the TS bench server and
    handles them inline (different wire shape, different boundary).

    Supported usage shapes:

    * OpenAI / Cerebras OpenAI-compat::

          {"prompt_tokens": 1234, "completion_tokens": 56,
           "prompt_tokens_details": {"cached_tokens": 800}}

    * Anthropic native usage::

          {"input_tokens": 1234, "output_tokens": 56,
           "cache_read_input_tokens": 800,
           "cache_creation_input_tokens": 200}
    """
    prompt = usage.get("prompt_tokens")
    completion = usage.get("completion_tokens")
    if not isinstance(prompt, (int, float)):
        prompt = usage.get("input_tokens")
    if not isinstance(completion, (int, float)):
        completion = usage.get("output_tokens")
    if isinstance(prompt, (int, float)):
        setattr(turn, "input_tokens", int(prompt))
    if isinstance(completion, (int, float)):
        setattr(turn, "output_tokens", int(completion))

    prompt_details = usage.get("prompt_tokens_details") or {}
    cache_read_raw = (
        prompt_details.get("cached_tokens")
        if isinstance(prompt_details, dict)
        else None
    )
    if cache_read_raw is None:
        cache_read_raw = usage.get("cache_read_input_tokens")
    cache_creation_raw = usage.get("cache_creation_input_tokens")

    cache_read_value: Optional[int] = (
        int(cache_read_raw) if isinstance(cache_read_raw, (int, float)) else None
    )
    cache_creation_value: Optional[int] = (
        int(cache_creation_raw)
        if isinstance(cache_creation_raw, (int, float))
        else None
    )
    setattr(turn, "cache_read_input_tokens", cache_read_value)
    setattr(turn, "cache_creation_input_tokens", cache_creation_value)
    # Adapters that call this helper front Cerebras / OpenAI / Anthropic —
    # all support prompt caching, so cache_supported is a hard-true. Local
    # backends bypass this helper entirely.
    setattr(turn, "cache_supported", True)


def compute_cache_hit_pct(
    input_tokens: int | None,
    cache_read_input_tokens: int | None,
    cache_creation_input_tokens: int | None,
) -> float | None:
    """Compute cache hit percentage as a fraction in [0, 1].

    Returns ``None`` when any of the three inputs is ``None`` (i.e. provider
    didn't report cache data); never returns 0.0 as a silent fallback for
    missing data. Per AGENTS.md Cmd #8: nullable cache fields stay nullable.

    Formula: ``cache_read / (input + cache_creation + cache_read)``. The
    denominator is the *full* input billed for the turn (non-cached input +
    cache write + cache read) so the percentage matches Anthropic semantics
    and round-trips with the TS pricing helper at
    ``packages/core/src/features/trajectories/pricing.ts``.
    """
    if (
        input_tokens is None
        or cache_read_input_tokens is None
        or cache_creation_input_tokens is None
    ):
        return None
    denominator = (
        int(input_tokens) + int(cache_creation_input_tokens) + int(cache_read_input_tokens)
    )
    if denominator <= 0:
        return 0.0
    return float(cache_read_input_tokens) / float(denominator)


@dataclass
class TurnResult:
    """Per-turn telemetry captured during a scenario run.

    Cache fields are deliberately nullable (``Optional[int]``): ``None`` means
    "provider did not report this number" and is distinct from ``0`` ("provider
    reports zero tokens cached"). Per AGENTS.md Cmd #8: nullable cache fields
    stay nullable, no silent ``0`` fallbacks.

    ``cost_usd`` and ``latency_ms`` are likewise nullable: ``None`` when the
    provider didn't expose the number (unpriced model in the pricing table
    for ``cost_usd``; pre-flight error for ``latency_ms``). The run-level
    ``ScenarioResult.total_cost_usd`` / ``total_latency_ms`` skip None
    entries when summing — see :class:`ScenarioResult` for the invariant.

    ``cache_supported`` is a hard boolean — set explicitly per provider, never
    inferred from missing data. Anthropic, OpenAI (with prompt cache key),
    and Cerebras ``gpt-oss-120b`` (default-on, 128-token blocks) all report
    ``True``. Local-tier providers (Ollama, LM Studio, llama.cpp) report
    ``False`` even when a particular call returned zero cached tokens.
    """

    turn_number: int
    agent_message: str
    agent_actions: list[Action]
    user_response: str
    latency_ms: int | None
    input_tokens: int
    output_tokens: int
    cost_usd: float | None
    cache_read_input_tokens: int | None = None
    cache_creation_input_tokens: int | None = None
    cache_hit_pct: float | None = None
    cache_supported: bool = True
    model_tier: str | None = None
    prompt_cache_key: str | None = None
    model_name: str | None = None


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
    """Aggregated results for a full benchmark run.

    ``total_cost_usd`` is the sum of agent + evaluator spend so existing
    consumers see the same headline number. ``agent_cost_usd`` and
    ``eval_cost_usd`` split that total so operators can answer "how much
    of this run was the executor vs. the judge / simulated user?".
    """

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
    agent_cost_usd: float = 0.0
    eval_cost_usd: float = 0.0
