"""Type definitions for MMAU (Massive Multi-task Audio Understanding).

MMAU is a pure multiple-choice benchmark over audio clips spanning three
domains (speech, sound, music) and 27 reasoning skills (12 information
retrieval, 15 reasoning). Scoring is deterministic exact-match on the
selected option letter -- no LLM-judge is required.

Source: https://mmaubench.github.io/
Paper:  https://arxiv.org/abs/2410.19168
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class MMAUCategory(str, Enum):
    """Top-level MMAU audio domain (the ``other_attributes.task`` field)."""

    SPEECH = "speech"
    SOUND = "sound"
    MUSIC = "music"


MMAU_CATEGORIES: tuple[MMAUCategory, ...] = tuple(MMAUCategory)


class MMAUSplit(str, Enum):
    """Available MMAU splits on Hugging Face.

    - TEST_MINI: 1,000 samples (``gamma-lab-umd/MMAU-test-mini``).
    - TEST: 9,000 samples (``gamma-lab-umd/MMAU-test``).
    """

    TEST_MINI = "test-mini"
    TEST = "test"


@dataclass(frozen=True)
class MMAUSample:
    """A single MMAU multiple-choice audio question."""

    id: str
    question: str
    choices: tuple[str, ...]
    answer_letter: str
    answer_text: str
    category: MMAUCategory
    skill: str
    information_category: str
    difficulty: str
    dataset: str
    audio_path: Path | None = None
    audio_bytes: bytes | None = None
    context: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class MMAUPrediction:
    """Agent prediction for one MMAU sample."""

    sample_id: str
    predicted_letter: str = ""
    raw_answer: str = ""
    raw_output: dict[str, Any] = field(default_factory=dict)
    transcript: str = ""
    latency_ms: float = 0.0
    error: str | None = None


@dataclass
class MMAUResult:
    """Scored MMAU prediction."""

    sample_id: str
    category: MMAUCategory
    skill: str
    information_category: str
    difficulty: str
    expected_letter: str
    predicted_letter: str
    is_correct: bool
    prediction: MMAUPrediction
    latency_ms: float = 0.0
    error: str | None = None


@dataclass
class MMAUReport:
    """Aggregate MMAU run report."""

    total_samples: int
    overall_accuracy: float
    accuracy_by_category: dict[str, float]
    accuracy_by_skill: dict[str, float]
    accuracy_by_information_category: dict[str, float]
    accuracy_by_difficulty: dict[str, float]
    counts_by_category: dict[str, int]
    counts_by_skill: dict[str, int]
    average_latency_ms: float
    error_count: int
    results: list[MMAUResult]
    summary: dict[str, Any] = field(default_factory=dict)


@dataclass
class MMAUConfig:
    """Configuration for an MMAU run."""

    output_dir: str = "./benchmark_results/mmau"
    fixture_path: Path | None = None
    hf_repo: str = "gamma-lab-umd/MMAU-test-mini"
    split: MMAUSplit = MMAUSplit.TEST_MINI
    categories: tuple[MMAUCategory, ...] = MMAU_CATEGORIES
    max_samples: int | None = None
    use_huggingface: bool = False
    use_fixture: bool = True
    agent: str = "mock"
    provider: str | None = None
    model: str | None = None
    stt_model: str = "whisper-large-v3-turbo"
    temperature: float = 0.0
    timeout_ms: int = 60000
    save_traces: bool = True
    verbose: bool = False
