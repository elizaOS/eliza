"""Dataset loading for VisualWebBench.

By default we load the real ``visualwebbench/VisualWebBench`` dataset from
Hugging Face. Each of the seven subtasks is its own HF *config* (loaded with
``datasets.load_dataset(repo, subtask)``) and ships PIL images plus per-task
metadata (bbox, options, elem_desc, ...).

For offline CI we keep a tiny labeled JSONL helper at ``fixtures/smoke.jsonl``
(one row per subtask, no images). It is opt-in via ``--use-sample-tasks`` and
is *only* useful for verifying that the right metric runs end-to-end —
accuracy numbers from it are not comparable to upstream.
"""

from __future__ import annotations

import hashlib
import io
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
DEFAULT_IMAGE_CACHE = Path.home() / ".cache" / "elizaos" / "visualwebbench" / "images"


class VisualWebBenchDataset:
    """Load VisualWebBench tasks from Hugging Face (default) or JSONL fixture."""

    def __init__(
        self,
        *,
        fixture_path: Path | None = None,
        hf_repo: str = "visualwebbench/VisualWebBench",
        split: str = "test",
        task_types: Iterable[VisualWebBenchTaskType] = VISUALWEBBENCH_TASK_TYPES,
        image_cache_dir: Path | None = None,
        cache_images_to_disk: bool = True,
    ) -> None:
        self.fixture_path = fixture_path or FIXTURE_PATH
        self.hf_repo = hf_repo
        self.split = split
        self.task_types = tuple(task_types)
        self.image_cache_dir = (image_cache_dir or DEFAULT_IMAGE_CACHE).resolve()
        self.cache_images_to_disk = cache_images_to_disk
        self.tasks: list[VisualWebBenchTask] = []
        self._loaded = False

    async def load(
        self,
        *,
        use_huggingface: bool = True,
        use_sample_tasks: bool = False,
        max_tasks: int | None = None,
    ) -> None:
        """Load tasks once from the selected source."""
        if self._loaded:
            return
        if use_sample_tasks:
            self._load_from_jsonl(self.fixture_path, max_tasks=max_tasks)
        elif use_huggingface:
            self._load_from_huggingface(max_tasks=max_tasks)
        else:
            raise RuntimeError(
                "VisualWebBenchDataset.load requires either use_huggingface=True "
                "or use_sample_tasks=True"
            )
        self._loaded = True
        logger.info(
            "Loaded %d VisualWebBench tasks (subtasks=%s)",
            len(self.tasks),
            [t.value for t in self.task_types],
        )

    # ----- JSONL (offline-CI fixture) --------------------------------------

    def _load_from_jsonl(self, path: Path, *, max_tasks: int | None) -> None:
        if not path.exists():
            raise FileNotFoundError(f"VisualWebBench sample tasks file not found: {path}")
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

    # ----- Hugging Face (real dataset) -------------------------------------

    def _load_from_huggingface(self, *, max_tasks: int | None) -> None:
        try:
            from datasets import load_dataset  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError(
                "Hugging Face loading requires the optional 'datasets' package. "
                "Install elizaos-visualwebbench[hf], or use --use-sample-tasks."
            ) from exc

        if self.cache_images_to_disk:
            self.image_cache_dir.mkdir(parents=True, exist_ok=True)

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
                task = self._parse_hf_row(dict(item), task_type)
                if task is None:
                    continue
                self.tasks.append(task)
                if remaining is not None:
                    remaining -= 1

    def _parse_hf_row(
        self,
        row: dict[str, Any],
        task_type: VisualWebBenchTaskType,
    ) -> VisualWebBenchTask | None:
        task_id = str(row.get("id") or f"{task_type.value}_{len(self.tasks)}")
        image_obj = row.get("image")
        image_path, image_bytes = self._materialize_image(task_id, image_obj)
        image_size = self._parse_image_size(row.get("image_size"))
        bbox = self._parse_bbox(row.get("bbox"))
        options = self._parse_options(row.get("options"))
        elem_desc = str(row.get("elem_desc") or "")
        question = str(row.get("question") or "")
        instruction = str(row.get("instruction") or "")
        answer = self._normalize_answer(task_type, row.get("answer"))

        prompt = self._build_prompt(
            task_type,
            question=question,
            instruction=instruction,
            elem_desc=elem_desc,
            bbox=bbox,
            options=options,
        )

        metadata: dict[str, Any] = {}
        for k, v in row.items():
            if k in {"image", "raw_image"}:
                continue
            if _json_safe(v):
                metadata[k] = v

        return VisualWebBenchTask(
            id=task_id,
            task_type=task_type,
            website=str(row.get("website") or ""),
            prompt=prompt,
            answer=answer,
            image_path=image_path,
            image_bytes=image_bytes,
            image_size=image_size,
            options=options,
            bbox=bbox,
            elem_desc=elem_desc,
            question=question,
            instruction=instruction,
            metadata=metadata,
        )

    def _materialize_image(
        self,
        task_id: str,
        image_obj: object,
    ) -> tuple[str | None, bytes | None]:
        if image_obj is None:
            return None, None
        try:
            from PIL import Image  # type: ignore[import-not-found]
        except ImportError:
            logger.warning("Pillow not installed; images will be skipped")
            return None, None

        if not isinstance(image_obj, Image.Image):
            return None, None

        buf = io.BytesIO()
        image_obj.save(buf, format="PNG")
        image_bytes = buf.getvalue()

        if not self.cache_images_to_disk:
            return None, image_bytes

        key = hashlib.sha1(f"{task_id}:{len(image_bytes)}".encode()).hexdigest()[:16]
        cache_path = self.image_cache_dir / f"{_safe_id(task_id)}_{key}.png"
        if not cache_path.exists():
            cache_path.write_bytes(image_bytes)
        return str(cache_path), image_bytes

    # ----- JSONL row parser (shared) ---------------------------------------

    def _parse_task(self, data: dict[str, Any]) -> VisualWebBenchTask | None:
        task_type = self._parse_task_type(data.get("task_type"))
        if task_type is None:
            return None

        task_id = str(data.get("id") or data.get("task_id") or "")
        if not task_id:
            task_id = f"{task_type.value}_{len(self.tasks)}"

        bbox = self._parse_bbox(data.get("bbox"))
        options = self._parse_options(data.get("options"))
        elem_desc = str(data.get("elem_desc") or "")
        question = str(data.get("question") or "")
        instruction = str(data.get("instruction") or "")
        answer = self._normalize_answer(task_type, data.get("answer"))
        prompt = self._build_prompt(
            task_type,
            question=question,
            instruction=instruction,
            elem_desc=elem_desc,
            bbox=bbox,
            options=options,
        )
        if isinstance(data.get("prompt"), str):
            prompt = str(data["prompt"])

        image_path = data.get("image_path") if isinstance(data.get("image_path"), str) else None
        image_size = self._parse_image_size(data.get("image_size"))

        return VisualWebBenchTask(
            id=task_id,
            task_type=task_type,
            website=str(data.get("website") or ""),
            prompt=prompt,
            answer=answer,
            image_path=image_path,
            image_bytes=None,
            image_size=image_size,
            options=options,
            bbox=bbox,
            elem_desc=elem_desc,
            question=question,
            instruction=instruction,
            metadata={k: v for k, v in data.items() if _json_safe(v)},
        )

    def _parse_task_type(self, raw: object) -> VisualWebBenchTaskType | None:
        value = str(raw or "").strip()
        if not value:
            return None
        try:
            return VisualWebBenchTaskType(value)
        except ValueError:
            logger.warning("Skipping unknown VisualWebBench task_type=%r", value)
            return None

    def _build_prompt(
        self,
        task_type: VisualWebBenchTaskType,
        *,
        question: str,
        instruction: str,
        elem_desc: str,
        bbox: BBox | None,
        options: list[str] | list[BBox],
    ) -> str:
        if task_type is VisualWebBenchTaskType.WEB_CAPTION:
            return (
                "You are given a screenshot of a webpage. Please generate the meta "
                "web description information of this webpage, i.e., content "
                'attribute in <meta name="description" content=""> HTML element.\n\n'
                "You should use the following format, and do not output any "
                "explanation or any other contents:\n"
                '<meta name="description" content="YOUR ANSWER">'
            )
        if task_type is VisualWebBenchTaskType.HEADING_OCR:
            return (
                "You are given a screenshot of a webpage. Please generate the main "
                "text within the screenshot, which can be regarded as the heading "
                "of the webpage.\n\nYou should directly tell me the main content, "
                "and do not output any explanation or any other contents."
            )
        if task_type is VisualWebBenchTaskType.WEBQA:
            return (
                f"{question}\nYou should directly tell me your answer in the "
                "fewest words possible, and do not output any explanation or any "
                "other contents."
            )
        if task_type is VisualWebBenchTaskType.ELEMENT_OCR:
            return (
                "You are given a screenshot of a webpage with a red rectangle "
                "bounding box. The [x1, y1, x2, y2] coordinates of the bounding "
                f"box is {list(bbox or ())}.\n"
                "Please perform OCR in the bounding box and recognize the text "
                "content within the red bounding box.\n\n"
                "You should use the following format:\n"
                "The text content within the red bounding box is: <YOUR ANSWER>"
            )
        if task_type is VisualWebBenchTaskType.ELEMENT_GROUND:
            return (
                "In this website screenshot, I have labeled IDs for some HTML "
                "elements as candidates. Tell me which one best matches the "
                f"description: {elem_desc}\n\n"
                "You should directly tell me your choice in a single uppercase "
                "letter, and do not output any explanation or any other contents."
            )
        if task_type is VisualWebBenchTaskType.ACTION_PREDICTION:
            choices_text = "\n".join(
                f"{chr(ord('A') + i)}. {opt}" for i, opt in enumerate(options)
            )
            return (
                "You are given a screenshot of a webpage with a red rectangle "
                "bounding box. The [x1, y1, x2, y2] coordinates of the bounding "
                f"box is {list(bbox or ())}.\n"
                "Please select the best webpage description that matches the new "
                "webpage after clicking the selected element in the bounding "
                f"box:\n{choices_text}\n\n"
                "You should directly tell me your choice in a single uppercase "
                "letter, and do not output any explanation or any other contents."
            )
        if task_type is VisualWebBenchTaskType.ACTION_GROUND:
            return (
                "In this website screenshot, I have labeled IDs for some HTML "
                "elements as candidates. Tell me which one I should click to "
                f"complete the following task: {instruction}\n\n"
                "You should directly tell me your choice in a single uppercase "
                "letter, and do not output any explanation or any other contents."
            )
        return ""

    def _normalize_answer(
        self,
        task_type: VisualWebBenchTaskType,
        raw: object,
    ) -> str | int | list[str] | BBox:
        if task_type in {
            VisualWebBenchTaskType.ELEMENT_GROUND,
            VisualWebBenchTaskType.ACTION_PREDICTION,
            VisualWebBenchTaskType.ACTION_GROUND,
        }:
            try:
                return int(raw)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                return -1
        if task_type is VisualWebBenchTaskType.WEBQA:
            if isinstance(raw, list):
                return [str(x) for x in raw]
            if raw is None:
                return [""]
            return [str(raw)]
        if raw is None:
            return ""
        if isinstance(raw, list):
            return str(raw[0]) if raw else ""
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
        if all_bbox and bboxes:
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
        if limit is None:
            return list(self.tasks)
        return self.tasks[:limit]


def _json_safe(value: object) -> bool:
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return False
    return True


def _safe_id(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in value)
