"""VisualWebBench agent backed by the eliza benchmark server."""

from __future__ import annotations

import json
import logging
import re
import time
from typing import TYPE_CHECKING, Any

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from benchmarks.visualwebbench.types import (
        BBox,
        VisualWebBenchConfig,
        VisualWebBenchPrediction,
        VisualWebBenchTask,
    )

logger = logging.getLogger(__name__)


class ElizaVisualWebBenchAgent:
    """VisualWebBench agent that routes prompts through the benchmark server."""

    def __init__(
        self,
        config: "VisualWebBenchConfig",
        client: ElizaClient | None = None,
    ) -> None:
        self.config = config
        self._client = client or ElizaClient()

    async def initialize(self) -> None:
        self._client.wait_until_ready(timeout=120)

    async def predict(self, task: "VisualWebBenchTask") -> "VisualWebBenchPrediction":
        from benchmarks.visualwebbench.types import VisualWebBenchPrediction

        started = time.time()
        self._client.reset(task_id=task.id, benchmark="visualwebbench")

        context: dict[str, object] = {
            "benchmark": "visualwebbench",
            "task_id": task.id,
            "task_type": task.task_type.value,
            "website": task.website,
            "prompt": task.prompt,
            "image_path": task.image_path or "",
            "image_size": list(task.image_size) if task.image_size else [],
            "options": _jsonable_options(task.options),
            "bbox": list(task.bbox) if task.bbox else [],
            "elem_desc": task.elem_desc,
            "response_schema": {
                "answer_text": "string",
                "choice_index": "integer|null",
                "bbox": "[x1,y1,x2,y2]|null normalized 0..1",
            },
        }

        message = (
            "Answer this VisualWebBench task. Return either BENCHMARK_ACTION params "
            "or a compact JSON object with answer_text, choice_index, and bbox.\n\n"
            f"Task type: {task.task_type.value}\n"
            f"Website: {task.website}\n"
            f"Question: {task.prompt}"
        )
        response = self._client.send_message(text=message, context=context)
        parsed = _parse_response(response.params, response.text)

        return VisualWebBenchPrediction(
            task_id=task.id,
            task_type=task.task_type,
            answer_text=str(parsed.get("answer_text") or ""),
            choice_index=_parse_int(parsed.get("choice_index")),
            bbox=_parse_bbox(parsed.get("bbox")),
            raw_output={
                "text": response.text,
                "thought": response.thought,
                "actions": response.actions,
                "params": response.params,
            },
            latency_ms=(time.time() - started) * 1000,
        )

    async def close(self) -> None:
        return None


def _parse_response(params: dict[str, object], text: str) -> dict[str, object]:
    merged: dict[str, object] = dict(params)
    for key in ("BENCHMARK_ACTION", "VISUALWEBBENCH_ANSWER", "visualwebbench"):
        nested = merged.get(key)
        if isinstance(nested, dict):
            merged.update(nested)

    if any(k in merged for k in ("answer_text", "choice_index", "bbox")):
        return merged

    json_obj = _extract_json(text)
    if json_obj:
        merged.update(json_obj)
    elif text:
        merged["answer_text"] = text.strip()
    return merged


def _extract_json(text: str) -> dict[str, object]:
    stripped = text.strip()
    candidates = [stripped]
    match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
    if match:
        candidates.append(match.group(0))
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return {}


def _parse_int(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _parse_bbox(value: object) -> "BBox | None":
    if isinstance(value, str):
        parts = re.split(r"[\s,]+", value.strip().strip("[]()"))
        value = [p for p in parts if p]
    if isinstance(value, list | tuple) and len(value) >= 4:
        try:
            return (float(value[0]), float(value[1]), float(value[2]), float(value[3]))
        except (TypeError, ValueError):
            return None
    return None


def _jsonable_options(options: object) -> list[object]:
    if not isinstance(options, list):
        return []
    out: list[object] = []
    for option in options:
        if isinstance(option, tuple):
            out.append(list(option))
        else:
            out.append(option)
    return out
