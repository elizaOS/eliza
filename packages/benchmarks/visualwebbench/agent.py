"""Local dry-run agent for VisualWebBench."""

from __future__ import annotations

import time

from benchmarks.visualwebbench.types import (
    BBox,
    VisualWebBenchPrediction,
    VisualWebBenchTask,
)


class OracleVisualWebBenchAgent:
    """Deterministic offline agent used for smoke tests and dry runs."""

    async def initialize(self) -> None:
        return None

    async def predict(self, task: VisualWebBenchTask) -> VisualWebBenchPrediction:
        started = time.time()
        answer_text = ""
        choice_index: int | None = None
        bbox: BBox | None = None

        if isinstance(task.answer, int):
            choice_index = task.answer
            if task.options and 0 <= task.answer < len(task.options):
                selected = task.options[task.answer]
                if isinstance(selected, str):
                    answer_text = selected
                else:
                    bbox = selected
        elif isinstance(task.answer, tuple):
            bbox = task.answer
            answer_text = ",".join(str(x) for x in task.answer)
        elif isinstance(task.answer, list):
            answer_text = str(task.answer[0]) if task.answer else ""
        else:
            answer_text = str(task.answer)

        return VisualWebBenchPrediction(
            task_id=task.id,
            task_type=task.task_type,
            answer_text=answer_text,
            choice_index=choice_index,
            bbox=bbox,
            raw_output={"mode": "dry_run_oracle"},
            latency_ms=(time.time() - started) * 1000,
        )

    async def close(self) -> None:
        return None
