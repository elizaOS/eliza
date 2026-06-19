"""Compatibility helpers for the removed Python Eliza experience plugin.

The benchmark no longer exposes an in-process ``elizaos`` plugin. Eliza-backed
experience runs are handled by ``eliza_adapter.experience`` and the TypeScript
benchmark bridge. This module keeps session/evaluation dataclasses so old
imports do not fail.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from elizaos_experience_bench.service import ExperienceService


class ExperiencePhase:
    """Phase of the experience benchmark."""

    LEARNING = "learning"
    RETRIEVAL = "retrieval"


@dataclass
class ExperienceTaskContext:
    """Context for a single experience benchmark task."""

    task_id: str
    phase: str
    message_text: str
    expected_domain: str = ""
    expected_learning: str = ""
    expected_experience_keywords: list[str] = field(default_factory=list)
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass
class ExperienceEvaluation:
    """Evaluation results from an experience benchmark task."""

    task_id: str
    phase: str
    response_text: str
    experience_recorded: bool = False
    recorded_domain: str = ""
    recorded_learning: str = ""
    experiences_retrieved: int = 0
    relevant_experience_found: bool = False
    keywords_in_response: bool = False
    latency_ms: float = 0.0
    error: str | None = None


class ExperienceBenchSession:
    """Session manager shared by compatibility call sites."""

    def __init__(self) -> None:
        self._current_task: ExperienceTaskContext | None = None
        self._evaluation: ExperienceEvaluation | None = None
        self._start_time = 0.0
        self._response_text = ""
        self._experience_service = ExperienceService()
        self._recorded_ids: list[str] = []

    @property
    def experience_service(self) -> ExperienceService:
        return self._experience_service

    @property
    def recorded_ids(self) -> list[str]:
        return list(self._recorded_ids)

    def add_recorded_id(self, exp_id: str) -> None:
        self._recorded_ids.append(exp_id)

    def set_task(
        self,
        task_id: str,
        phase: str,
        message_text: str,
        expected_domain: str = "",
        expected_learning: str = "",
        expected_experience_keywords: list[str] | None = None,
        metadata: dict[str, str | int | float | bool] | None = None,
    ) -> None:
        self._current_task = ExperienceTaskContext(
            task_id=task_id,
            phase=phase,
            message_text=message_text,
            expected_domain=expected_domain,
            expected_learning=expected_learning,
            expected_experience_keywords=expected_experience_keywords or [],
            metadata=metadata or {},
        )
        self._evaluation = None
        self._start_time = time.time()
        self._response_text = ""

    def get_task(self) -> ExperienceTaskContext | None:
        return self._current_task

    def record_response(self, response: str) -> None:
        self._response_text = response

    def get_response(self) -> str:
        return self._response_text

    def record_evaluation(self, evaluation: ExperienceEvaluation) -> None:
        self._evaluation = evaluation

    def get_evaluation(self) -> ExperienceEvaluation | None:
        return self._evaluation

    def get_latency_ms(self) -> float:
        return (time.time() - self._start_time) * 1000 if self._start_time else 0.0

    def clear_task(self) -> None:
        self._current_task = None
        self._evaluation = None
        self._start_time = 0.0
        self._response_text = ""


_global_session: ExperienceBenchSession | None = None


def get_experience_bench_session() -> ExperienceBenchSession:
    global _global_session
    if _global_session is None:
        _global_session = ExperienceBenchSession()
    return _global_session


def set_experience_bench_session(session: ExperienceBenchSession) -> None:
    global _global_session
    _global_session = session


def get_experience_benchmark_plugin() -> None:
    """Compatibility stub for the removed Python Eliza plugin."""
    return None


async def run_experience_task_through_agent(
    runtime: object,
    session: ExperienceBenchSession,
    task_id: str,
    phase: str,
    message_text: str,
    expected_domain: str = "",
    expected_learning: str = "",
    expected_experience_keywords: list[str] | None = None,
) -> ExperienceEvaluation:
    """Compatibility evaluator for callers that still use this helper.

    This function no longer calls a Python Eliza runtime. It records a clear
    error result so callers can migrate to ``eliza_adapter.experience``.
    """
    _ = runtime
    session.set_task(
        task_id=task_id,
        phase=phase,
        message_text=message_text,
        expected_domain=expected_domain,
        expected_learning=expected_learning,
        expected_experience_keywords=expected_experience_keywords,
    )
    evaluation = ExperienceEvaluation(
        task_id=task_id,
        phase=phase,
        response_text="",
        latency_ms=session.get_latency_ms(),
        error=(
            "The Python Eliza experience runtime was removed. Use "
            "eliza_adapter.experience.ElizaBridgeExperienceRunner."
        ),
    )
    session.record_evaluation(evaluation)
    session.clear_task()
    return evaluation


async def setup_experience_benchmark_runtime(*_args: object, **_kwargs: object) -> object:
    """Compatibility stub for the removed Python runtime factory."""
    raise RuntimeError(
        "The Python Eliza experience runtime was removed. Use "
        "eliza_adapter.experience.ElizaBridgeExperienceRunner."
    )


__all__ = [
    "ExperienceBenchSession",
    "ExperienceEvaluation",
    "ExperiencePhase",
    "ExperienceTaskContext",
    "get_experience_bench_session",
    "get_experience_benchmark_plugin",
    "run_experience_task_through_agent",
    "set_experience_bench_session",
    "setup_experience_benchmark_runtime",
]
