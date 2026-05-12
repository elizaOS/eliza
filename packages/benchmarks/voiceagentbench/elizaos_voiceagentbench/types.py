"""Type definitions for VoiceAgentBench.

The chat-turn primitive is :class:`MessageTurn`, a subclass of
:class:`eliza_lifeops_bench.types.MessageTurn` that adds two additive
fields:

  * ``audio_input: bytes | None`` - raw audio bytes for voice-in turns.
  * ``audio_output: bytes | None`` - raw audio bytes for direct-audio
    responses (reserved for future direct-audio adapters).

Because :class:`MessageTurn` *is a* base ``MessageTurn``, every adapter
that types its argument against the LifeOpsBench / tau-bench base
accepts our extended instances unchanged. This is the non-breaking,
backward-compatible extension required by the AgentFn contract.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal

# Base chat-turn from LifeOpsBench. We subclass it here (instead of
# editing the upstream dataclass) so the shared cross-bench primitive
# stays byte-for-byte stable while VoiceAgentBench gains the two audio
# fields it needs. Adapters targeting LifeOpsBench / tau-bench
# MessageTurn keep working because every VoiceAgentBench MessageTurn
# is-a LifeOpsBench MessageTurn at the type level.
from eliza_lifeops_bench.types import MessageTurn as _BaseMessageTurn


@dataclass
class MessageTurn(_BaseMessageTurn):
    """LifeOpsBench :class:`MessageTurn` extended with audio fields.

    ``audio_input`` carries raw audio bytes for the voice-in path.
    ``audio_output`` is reserved for future direct-audio response
    adapters and is unused by the cascaded STT baseline. Both default
    to :data:`None` so every existing text-path caller keeps working.

    Adapters without direct-audio support MUST transcribe ``audio_input``
    to text via STT (Groq Whisper baseline) and feed the resulting
    ``content`` into their text path; direct-audio adapters may consume
    ``audio_input`` bytes themselves. The runner is the only writer
    for ``audio_input`` (loaded from the dataset).
    """

    audio_input: bytes | None = None
    audio_output: bytes | None = None


class Suite(Enum):
    """The six VoiceAgentBench task suites."""

    SINGLE = "single"
    PARALLEL = "parallel"
    SEQUENTIAL = "sequential"
    MULTI_TURN = "multi-turn"
    SAFETY = "safety"
    MULTILINGUAL = "multilingual"


class SafetyVerdict(Enum):
    """Whether a safety task expects refusal or compliance."""

    MUST_REFUSE = "must_refuse"
    MUST_COMPLY = "must_comply"


@dataclass(frozen=True)
class AudioQuery:
    """A single voice query in a task.

    ``audio_bytes`` is the raw WAV/MP3 payload (``None`` for fixture-only
    runs that exercise the text path). ``transcript`` is the ground-truth
    text used to score STT-cascaded adapters and to back-fill the agent
    history when no audio synthesizer is wired in.
    """

    audio_bytes: bytes | None
    transcript: str
    language: str = "en"
    speaker_id: str | None = None


@dataclass(frozen=True)
class ToolCallExpectation:
    """One expected tool call in the ground-truth trajectory.

    ``required_params`` are kwargs that must appear with the exact value;
    ``substring_params`` are kwargs where the agent's value need only
    contain the listed substring (case-insensitive) to satisfy. This
    matches the VoiceAgentBench paper's dual deterministic scorer:
    structural match for ids / enums, substring for free-form text
    extracted from speech.
    """

    tool_name: str
    required_params: dict[str, Any] = field(default_factory=dict)
    substring_params: dict[str, str] = field(default_factory=dict)
    order: int | None = None


@dataclass(frozen=True)
class VoiceTask:
    """A single benchmark task.

    Multi-turn tasks carry one ``AudioQuery`` per user turn; single-turn
    tasks carry exactly one. ``expected_tool_calls`` is the flat list of
    ground-truth tool invocations across the whole task; ``order`` on
    each expectation drives sequential-suite ordering checks.
    """

    task_id: str
    suite: Suite
    queries: list[AudioQuery]
    expected_tool_calls: list[ToolCallExpectation]
    tool_manifest: list[dict[str, Any]]
    safety_verdict: SafetyVerdict | None = None
    expected_response_substrings: list[str] = field(default_factory=list)
    description: str = ""


@dataclass
class VoiceTaskResult:
    """Outcome of running one task.

    Score axes are stored separately so the aggregate report can show
    per-axis breakdowns. ``passed`` is the boolean used for Pass^k.
    """

    task_id: str
    suite: Suite
    seed: int
    passed: bool
    tool_selection_score: float
    parameter_match_score: float
    coherence_score: float | None
    safety_score: float | None
    total_score: float
    agent_tool_calls: list[dict[str, Any]]
    agent_final_text: str
    transcripts: list[str]
    latency_ms: float
    error: str | None = None


@dataclass
class VoiceBenchmarkReport:
    """Aggregated report for a full benchmark run."""

    tasks: list[VoiceTaskResult]
    pass_at_1: float
    pass_at_k: dict[int, float]
    per_suite_pass_at_1: dict[str, float]
    mean_tool_selection: float
    mean_parameter_match: float
    mean_coherence: float
    mean_safety: float
    model_name: str
    judge_model_name: str
    timestamp: str
    seeds: int
    total_latency_ms: float


# AgentFn matches the LifeOpsBench / tau-bench Python contract:
#   (history, tool_manifest) -> next assistant MessageTurn
# Audio is conveyed on the most recent user MessageTurn via
# ``audio_input``. Adapters without direct-audio support transcribe to
# ``content`` before dispatching to their text path.
AgentFn = Callable[[list[MessageTurn], list[dict[str, Any]]], Awaitable[MessageTurn]]


SuiteLiteral = Literal[
    "single",
    "parallel",
    "sequential",
    "multi-turn",
    "safety",
    "multilingual",
    "all",
]
