"""Shared types for the VoiceBench-quality runner.

These types are deliberately distinct from the latency benchmark at
``packages/benchmarks/voicebench/``. That package measures end-to-end
latency over fixture audio. This one scores response quality over the
upstream 6783-sample VoiceBench dataset.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Sequence

# Suite identifiers — match the upstream VoiceBench task splits 1:1.
SuiteId = Literal[
    "alpacaeval",
    "commoneval",
    "sd-qa",
    "ifeval",
    "advbench",
    "openbookqa",
    "mmsu",
    "bbh",
]

SUITES: tuple[SuiteId, ...] = (
    "alpacaeval",
    "commoneval",
    "sd-qa",
    "ifeval",
    "advbench",
    "openbookqa",
    "mmsu",
    "bbh",
)

# How each suite is scored.
#   "judge"          : open-ended; rubric judged by an LLM (gpt-oss-120b).
#   "mcq"            : deterministic letter match (A/B/C/D).
#   "refusal"        : deterministic keyword-based refusal detection.
#   "ifeval"         : deterministic instruction-following checkers
#                      (e.g. word count, formatting) per upstream ifeval.
SCORING_MODE = {
    "alpacaeval": "judge",
    "commoneval": "judge",
    "sd-qa": "judge",
    "ifeval": "ifeval",
    "advbench": "refusal",
    "openbookqa": "mcq",
    "mmsu": "mcq",
    "bbh": "judge",
}


@dataclass(frozen=True)
class Sample:
    """One VoiceBench sample.

    ``audio_bytes`` is opaque PCM/WAV bytes loaded from the upstream HF
    dataset. Cascaded baselines transcribe these via an STT provider and
    feed the resulting text to the text-only adapter.

    ``reference_text`` is the upstream prompt transcript — used both as
    the STT ground-truth and as the fallback prompt in mock mode.

    ``answer`` is the gold reference answer:
      * MCQ suites: single letter (A/B/C/D).
      * Open-ended suites: free text used as the judge reference.
      * advbench: empty (refusal is content-based, not answer-based).
    """

    suite: SuiteId
    sample_id: str
    reference_text: str
    answer: str
    audio_bytes: bytes | None = None
    # Per-suite metadata pulled through from the upstream dataset.
    # Examples: ``{"choices": ["A) ...", "B) ..."]}`` for MCQ suites,
    # ``{"instructions": [...]}`` for ifeval.
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class SampleScore:
    """Per-sample score record persisted in the trajectory log."""

    sample_id: str
    suite: SuiteId
    predicted: str
    expected: str
    score: float  # 0.0 or 1.0 (or rubric-mean for judge suites)
    rationale: str = ""


@dataclass
class SuiteResult:
    """Aggregate results for a single suite."""

    suite: SuiteId
    n: int
    score: float  # mean of per-sample scores in [0, 1]
    samples: list[SampleScore] = field(default_factory=list)


@dataclass
class VoiceBenchResult:
    """Top-level result document persisted to ``voicebench-results.json``.

    ``score`` is the mean of per-suite scores across the suites that ran.
    Each suite contributes equally regardless of sample count, matching
    the upstream VoiceBench reporting convention.
    """

    agent: str
    suites_run: Sequence[SuiteId]
    score: float
    per_suite: dict[str, float]
    n: int
    elapsed_s: float
    suite_details: list[SuiteResult] = field(default_factory=list)
    judge_model: str = ""
    stt_provider: str = ""
