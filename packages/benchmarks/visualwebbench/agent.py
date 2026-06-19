"""Offline oracle agent for VisualWebBench.

This agent reads ``task.answer`` directly and echoes a well-formed prediction.
It is **only** for offline smoke/CI scenarios — running it produces a
guaranteed-perfect score, so it must never be used as a real benchmark agent.

The runner refuses to instantiate this class unless ``VisualWebBenchConfig.mock``
is True (set via the ``--mock`` CLI flag). All other code paths route through
the real eliza adapter.
"""

from __future__ import annotations

import time

from benchmarks.visualwebbench.types import (
    BBox,
    VisualWebBenchPrediction,
    VisualWebBenchTask,
    VisualWebBenchTaskType,
)


class OracleVisualWebBenchAgent:
    """Deterministic offline agent. Use only with ``--mock``."""

    async def initialize(self) -> None:
        return None

    async def predict(self, task: VisualWebBenchTask) -> VisualWebBenchPrediction:
        started = time.time()
        answer_text = ""
        choice_index: int | None = None
        bbox: BBox | None = None

        # MCQ tasks: encode the gold index as a letter so the choice parser
        # exercises real upstream parsing rather than the structured shortcut.
        if task.task_type in {
            VisualWebBenchTaskType.ELEMENT_GROUND,
            VisualWebBenchTaskType.ACTION_PREDICTION,
            VisualWebBenchTaskType.ACTION_GROUND,
        }:
            if isinstance(task.answer, int) and task.answer >= 0:
                choice_index = task.answer
                answer_text = chr(ord("A") + task.answer)
        elif task.task_type is VisualWebBenchTaskType.WEBQA:
            if isinstance(task.answer, list) and task.answer:
                answer_text = str(task.answer[0])
            elif isinstance(task.answer, str):
                answer_text = task.answer
        else:
            # Generative subtasks: echo the reference string.
            if isinstance(task.answer, list):
                answer_text = str(task.answer[0]) if task.answer else ""
            else:
                answer_text = str(task.answer)

        return VisualWebBenchPrediction(
            task_id=task.id,
            task_type=task.task_type,
            answer_text=answer_text,
            choice_index=choice_index,
            bbox=bbox,
            raw_output={"mode": "mock_oracle"},
            latency_ms=(time.time() - started) * 1000,
        )

    async def close(self) -> None:
        return None
