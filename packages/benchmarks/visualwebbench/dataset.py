"""Dataset loading for VisualWebBench.

The default path is a bundled JSONL fixture. Hugging Face loading is opt-in
and uses streaming so runs can consume a small prefix without fetching the
full dataset.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from benchmarks.visualwebbench.types import (
    BBox,
    VISUALWEBBENCH_TASK_TYPES,
    VisualWebBenchTask,
    VisualWebBenchTaskType,
)

logger = logging.getLogger(__name__)

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "smoke.jsonl"


class VisualWebBenchDataset:
    """Load VisualWebBench tasks from JSONL or Hugging Face."""

    def __init__(
        self,
        *,
        fixture_path: Path | None = None,
        hf_repo: str = "visualwebbench/VisualWebBench",
        split: str = "test",
        task_types: Iterable[VisualWebBenchTaskType] = VISUALWEBBENCH_TASK_TYPES,
    ) -> None:
        self.fixture_path = fixture_path or FIXTURE_PATH
        self.hf_repo = hf_repo
        self.split = split
        self.task_types = tuple(task_types)
        self.tasks: list[VisualWebBenchTask] = []
        self._loaded = False

    async def load(
        self,
        *,
        use_huggingface: bool = False,
        use_fixture: bool = True,
        max_tasks: int | None = None,
    ) -> None:
        """Load tasks once from the selected source."""
        if self._loaded:
            return
        if use_huggingface:
            self._load_from_huggingface(max_tasks=max_tasks)
        elif use_fixture:
            self._load_from_jsonl(self.fixture_path, max_tasks=max_tasks)
        else:
            logger.warning("No VisualWebBench source selected; using bundled fixture")
            self._load_from_jsonl(FIXTURE_PATH, max_tasks=max_tasks)
        self._loaded = True
        logger.info("Loaded %d VisualWebBench tasks", len(self.tasks))

    def _load_from_jsonl(self, path: Path, *, max_tasks: int | None) -> None:
        if not path.exists():
            raise FileNotFoundError(f"VisualWebBench fixture not found: {path}")
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                if max_tasks is not None and len(self.tasks) >= max_tasks:
                    break
                line = line.strip()
                if not line:
                    continue
                task = self._parse_task(json.loads(line))
                if task and task.task_type in self.task_types:
                    self.tasks.append(task)

    def _load_from_huggingface(self, *, max_tasks: int | None) -> None:
        try:
            from datasets import load_dataset  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError(
                "Hugging Face loading requires the optional 'datasets' package. "
                "Install visualwebbench[hf] or run with --fixture."
            ) from exc

        remaining = max_tasks
        for task_type in self.task_types:
            if remaining is not None and remaining <= 0:
                break
            try:
                stream = load_dataset(
                    self.hf_repo,
                    task_type.value,
                    split=self.split,
                    streaming=True,
                )
            except Exception as exc:
                logger.warning("Failed to open HF config %s: %s", task_type.value, exc)
                continue

            for item in stream:
                if remaining is not None and remaining <= 0:
                    break
                task = self._parse_task(dict(item), default_task_type=task_type)
                if task:
                    self.tasks.append(task)
                    if remaining is not None:
                        remaining -= 1

    def _parse_task(
        self,
        data: dict[str, Any],
        *,
        default_task_type: VisualWebBenchTaskType | None = None,
    ) -> VisualWebBenchTask | None:
        task_type = self._parse_task_type(data.get("task_type"), default_task_type)
        if task_type is None:
            return None

        task_id = str(data.get("id") or data.get("task_id") or "")
        if not task_id:
            task_id = f"{task_type.value}_{len(self.tasks)}"

        answer = self._parse_answer(data.get("answer"))
        options = self._parse_options(data.get("options"))
        bbox = self._parse_bbox(data.get("bbox"))

        prompt = self._build_prompt(task_type, data)

        image_path = data.get("image_path")
        if not isinstance(image_path, str):
            image_path = None

        image_size = self._parse_image_size(data.get("image_size"))

        return VisualWebBenchTask(
            id=task_id,
            task_type=task_type,
            website=str(data.get("website") or ""),
            prompt=prompt,
            answer=answer,
            image_path=image_path,
            image_size=image_size,
            options=options,
            bbox=bbox,
            elem_desc=str(data.get("elem_desc") or ""),
            metadata={
                k: v
                for k, v in data.items()
                if k not in {"image", "raw_image"} and _json_safe(v)
            },
        )

    def _parse_task_type(
        self,
        raw: object,
        default: VisualWebBenchTaskType | None,
    ) -> VisualWebBenchTaskType | None:
        value = str(raw or (default.value if default else "")).strip()
        if not value:
            return None
        try:
            return VisualWebBenchTaskType(value)
        except ValueError:
            logger.warning("Skipping unknown VisualWebBench task_type=%r", value)
            return None

    def _build_prompt(self, task_type: VisualWebBenchTaskType, data: dict[str, Any]) -> str:
        if isinstance(data.get("prompt"), str):
            return str(data["prompt"])
        if task_type is VisualWebBenchTaskType.WEBQA:
            return str(data.get("question") or "")
        if task_type is VisualWebBenchTaskType.ACTION_GROUND:
            return str(data.get("instruction") or "")
        if task_type in {VisualWebBenchTaskType.ELEMENT_GROUND, VisualWebBenchTaskType.ACTION_PREDICTION}:
            return str(data.get("elem_desc") or data.get("instruction") or "")
        if task_type is VisualWebBenchTaskType.WEB_CAPTION:
            return "Describe the webpage screenshot."
        if task_type is VisualWebBenchTaskType.HEADING_OCR:
            return "Read the main heading in the webpage screenshot."
        if task_type is VisualWebBenchTaskType.ELEMENT_OCR:
            return "Read the specified element text in the webpage screenshot."
        return ""

    def _parse_answer(self, raw: object) -> str | int | list[str] | BBox:
        if isinstance(raw, bool):
            return str(raw)
        if isinstance(raw, int):
            return raw
        bbox = self._parse_bbox(raw)
        if bbox is not None:
            return bbox
        if isinstance(raw, list):
            return [str(x) for x in raw]
        if raw is None:
            return ""
        return str(raw)

    def _parse_options(self, raw: object) -> list[str] | list[BBox]:
        if not isinstance(raw, list):
            return []
        bboxes: list[BBox] = []
        all_bbox = True
        for item in raw:
            bbox = self._parse_bbox(item)
            if bbox is None:
                all_bbox = False
                break
            bboxes.append(bbox)
        if all_bbox:
            return bboxes
        return [str(item) for item in raw]

    def _parse_image_size(self, raw: object) -> tuple[int, int] | None:
        if isinstance(raw, (list, tuple)) and len(raw) >= 2:
            try:
                return (int(raw[0]), int(raw[1]))
            except (TypeError, ValueError):
                return None
        return None

    def _parse_bbox(self, raw: object) -> BBox | None:
        if isinstance(raw, (list, tuple)) and len(raw) >= 4:
            try:
                return (float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3]))
            except (TypeError, ValueError):
                return None
        return None

    def get_tasks(self, limit: int | None = None) -> list[VisualWebBenchTask]:
        """Return loaded tasks, optionally limited."""
        if limit is None:
            return list(self.tasks)
        return self.tasks[:limit]


def _json_safe(value: object) -> bool:
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return False
    return True
