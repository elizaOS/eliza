"""
MINT Dataset Loader

Loads samples from the upstream MINT data (see ``upstream/`` for the
Apache-2.0 attribution). Each subtask is loaded via the upstream JSONL file
that the paper sampled.

Three subtask "groups" are supported:

    code_generation : humaneval, mbpp        -> evaluation_metric=code_test
    reasoning       : math, gsm8k, theoremqa,
                      mmlu, hotpotqa         -> evaluation_metric=numeric /
                                                multiple_choice / partial_match
    decision_making : alfworld               -> loaded lazily, requires
                                                ``textworld`` + ``alfworld``
                                                packages.

A small ``--use-sample-tasks`` escape hatch keeps ~3 official-format prompts
for smoke tests that must not depend on network or cached upstream files.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Iterable, Optional
from urllib.error import URLError
from urllib.request import urlopen

from benchmarks.mint.types import (
    MINTSubtask,
    MINTTask,
    SUBTASK_TO_TASK_TYPE,
)

logger = logging.getLogger(__name__)

# Optional vendored upstream data location. Resolved relative to this file so
# the package is importable from any cwd.
_VENDORED_UPSTREAM_DATA = (
    Path(__file__).resolve().parent / "upstream" / "data" / "processed"
)
_UPSTREAM_REPO = "https://raw.githubusercontent.com/xingyaoww/mint-bench/main"
_UPSTREAM_PROCESSED_BASE_URL = f"{_UPSTREAM_REPO}/data/processed"
_FETCH_TIMEOUT_SECONDS = 60


# Subtask -> filename inside ``upstream/data/processed/<subtask>/``.
_SUBTASK_FILE: dict[MINTSubtask, str] = {
    MINTSubtask.HUMANEVAL: "test_prompts.json",
    MINTSubtask.MBPP: "test_prompts.json",
    MINTSubtask.MATH: "test_prompts.json",
    MINTSubtask.GSM8K: "test_prompts.json",
    MINTSubtask.HOTPOTQA: "test_prompts.json",
    MINTSubtask.MMLU: "test_prompts.json",
    MINTSubtask.THEOREMQA: "test_prompts.json",
    MINTSubtask.ALFWORLD: "",  # Loaded lazily; not a flat JSON.
}


_SUBTASK_METRIC: dict[MINTSubtask, str] = {
    MINTSubtask.HUMANEVAL: "code_test",
    MINTSubtask.MBPP: "code_test",
    MINTSubtask.MATH: "numeric",
    MINTSubtask.GSM8K: "numeric",
    MINTSubtask.HOTPOTQA: "partial_match",
    MINTSubtask.MMLU: "multiple_choice",
    MINTSubtask.THEOREMQA: "theoremqa",
    MINTSubtask.ALFWORLD: "exact_match",
}


_SUBTASK_DESCRIPTION: dict[MINTSubtask, str] = {
    MINTSubtask.HUMANEVAL: "Python function completion graded by upstream test suite.",
    MINTSubtask.MBPP: "Python function from MBPP graded by upstream test suite.",
    MINTSubtask.MATH: "Hendrycks MATH problem (numeric answer).",
    MINTSubtask.GSM8K: "Grade-school math word problem (integer answer).",
    MINTSubtask.HOTPOTQA: "HotpotQA multi-hop QA (free-form string).",
    MINTSubtask.MMLU: "MMLU multiple choice question.",
    MINTSubtask.THEOREMQA: "TheoremQA theorem-based problem.",
    MINTSubtask.ALFWORLD: "AlfWorld decision-making episode (TextWorld).",
}


class MINTDataset:
    """Loader for the upstream MINT test samples."""

    def __init__(
        self,
        data_path: str | Path = "",
        use_sample_tasks: bool = False,
        cache_dir: str | Path = "",
        auto_fetch: bool | None = None,
    ) -> None:
        self._explicit_data_path = bool(data_path)
        self.data_path: Path = Path(data_path) if data_path else _VENDORED_UPSTREAM_DATA
        self.cache_dir: Path = Path(cache_dir) if cache_dir else self._default_cache_dir()
        self.auto_fetch = (
            os.environ.get("MINT_AUTO_FETCH", "1").strip().lower()
            not in {"0", "false", "no", "off"}
            if auto_fetch is None
            else auto_fetch
        )
        self.use_sample_tasks = use_sample_tasks
        self.tasks: dict[MINTSubtask, list[MINTTask]] = {
            st: [] for st in MINTSubtask
        }
        self._loaded = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    async def load(
        self,
        subtasks: Optional[Iterable[MINTSubtask]] = None,
    ) -> None:
        if self._loaded:
            return

        if self.use_sample_tasks:
            logger.info("[MINTDataset] Loading hand-written smoke tasks")
            self._load_smoke_tasks()
            self._loaded = True
            return

        selected = list(subtasks) if subtasks is not None else list(MINTSubtask)
        logger.info("[MINTDataset] Loading upstream MINT samples")
        loaded_any = self._load_from_upstream(selected, self.data_path)
        if (
            not loaded_any
            and not self._explicit_data_path
            and self.cache_dir != self.data_path
        ):
            loaded_any = self._load_from_upstream(selected, self.cache_dir)

        missing_selected = [
            st for st in selected if st is not MINTSubtask.ALFWORLD and not self.tasks[st]
        ]
        if missing_selected and self.auto_fetch:
            self.fetch_upstream_data(missing_selected)
            loaded_any = self._load_from_upstream(selected, self.cache_dir)

        if not loaded_any:
            raise RuntimeError(
                f"No upstream MINT samples found under {self.data_path} or {self.cache_dir}. "
                "Either point ``MINTConfig.data_path`` at a directory laid "
                "out like upstream data/processed/, allow the default lazy "
                "fetch into the cache, or set ``use_sample_tasks=True`` for "
                "the offline smoke set."
            )

        total = sum(len(v) for v in self.tasks.values())
        logger.info(
            "[MINTDataset] Loaded %d samples across %d subtasks",
            total,
            sum(1 for v in self.tasks.values() if v),
        )
        self._loaded = True

    def get_tasks(
        self,
        subtasks: Optional[Iterable[MINTSubtask]] = None,
        limit: Optional[int] = None,
        difficulty: Optional[str] = None,
    ) -> list[MINTTask]:
        """Return the requested subset of loaded tasks."""
        selected = list(subtasks) if subtasks is not None else list(MINTSubtask)
        out: list[MINTTask] = []
        for st in selected:
            entries = self.tasks.get(st, [])
            if difficulty:
                entries = [t for t in entries if t.difficulty == difficulty]
            if limit is not None:
                entries = entries[:limit]
            out.extend(entries)
        return out

    def get_tasks_by_subtask(self, subtask: MINTSubtask) -> list[MINTTask]:
        return list(self.tasks.get(subtask, []))

    # Backwards-compat aliases ------------------------------------------------
    def get_tasks_by_category(self, subtask: MINTSubtask) -> list[MINTTask]:
        return self.get_tasks_by_subtask(subtask)

    def get_task_by_id(self, task_id: str) -> Optional[MINTTask]:
        for entries in self.tasks.values():
            for task in entries:
                if task.id == task_id:
                    return task
        return None

    def get_subtask_stats(self) -> dict[str, dict[str, int]]:
        return {
            st.value: {
                "total": len(entries),
                "task_type": SUBTASK_TO_TASK_TYPE[st].value,
            }
            for st, entries in self.tasks.items()
        }

    # Backwards-compat alias.
    def get_category_stats(self) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = {}
        for st, entries in self.tasks.items():
            out[st.value] = {
                "total": len(entries),
                # ``difficulty`` fields kept for legacy tests.
                "easy": sum(1 for t in entries if t.difficulty == "easy"),
                "medium": sum(1 for t in entries if t.difficulty == "medium"),
                "hard": sum(1 for t in entries if t.difficulty == "hard"),
            }
        return out

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------
    def fetch_upstream_data(
        self,
        subtasks: Optional[Iterable[MINTSubtask]] = None,
    ) -> None:
        """Fetch compact official processed JSONL files into the local cache."""
        selected = list(subtasks) if subtasks is not None else list(MINTSubtask)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        for st in selected:
            if st is MINTSubtask.ALFWORLD:
                logger.info(
                    "[MINTDataset] Skipping lazy fetch for alfworld; install "
                    "alfworld/textworld assets separately and pass data_path"
                )
                continue
            relname = _SUBTASK_FILE[st]
            target = self.cache_dir / st.value / relname
            if target.exists() and target.stat().st_size > 0:
                continue

            url = f"{_UPSTREAM_PROCESSED_BASE_URL}/{st.value}/{relname}"
            logger.info("[MINTDataset] Fetching %s data into %s", st.value, target)
            self._fetch_file(url, target)

    def _load_from_upstream(
        self,
        subtasks: Iterable[MINTSubtask],
        root: Path,
    ) -> bool:
        if not root.exists():
            return False

        loaded_any = False
        for st in subtasks:
            if st is MINTSubtask.ALFWORLD:
                # Loaded lazily; requires the ``alfworld`` package + game
                # files. Skip silently so consumers can still benchmark the
                # other 7 subtasks without that dependency.
                continue

            relname = _SUBTASK_FILE[st]
            path = root / st.value / relname
            if not path.exists():
                logger.warning("[MINTDataset] Missing %s data at %s", st.value, path)
                continue

            entries = self._load_subtask_file(st, path)
            self.tasks[st] = entries
            logger.debug(
                "[MINTDataset] Loaded %d %s samples", len(entries), st.value
            )
            loaded_any = loaded_any or bool(entries)
        return loaded_any

    def _fetch_file(self, url: str, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(target.suffix + ".tmp")
        try:
            with urlopen(url, timeout=_FETCH_TIMEOUT_SECONDS) as resp:
                payload = resp.read()
        except URLError as exc:
            raise RuntimeError(
                f"Failed to fetch upstream MINT data from {url}. "
                f"Set MINT_AUTO_FETCH=0 and use --use-sample-tasks for smoke, "
                f"or populate {self.cache_dir} manually."
            ) from exc

        if not payload.strip():
            raise RuntimeError(f"Fetched empty upstream MINT data from {url}")
        tmp.write_bytes(payload)
        tmp.replace(target)

    @staticmethod
    def _default_cache_dir() -> Path:
        override = os.environ.get("MINT_DATA_CACHE", "").strip()
        if override:
            return Path(override) / "processed"
        xdg = os.environ.get("XDG_CACHE_HOME", "").strip()
        base = Path(xdg) if xdg else Path.home() / ".cache"
        return base / "elizaos" / "mint" / "processed"

    def _load_subtask_file(
        self, subtask: MINTSubtask, path: Path
    ) -> list[MINTTask]:
        entries: list[MINTTask] = []
        with open(path, encoding="utf-8") as fh:
            for line_num, line in enumerate(fh):
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError as exc:
                    logger.error(
                        "[MINTDataset] Bad JSON in %s:%d: %s",
                        path,
                        line_num,
                        exc,
                    )
                    continue

                task = self._build_task(subtask, raw)
                if task is not None:
                    entries.append(task)
        return entries

    def _build_task(
        self, subtask: MINTSubtask, raw: dict
    ) -> Optional[MINTTask]:
        try:
            raw_id = raw.get("id", raw.get("task_id"))
            if raw_id is None:
                return None
            task_id = f"{subtask.value}-{raw_id}"
            prompt = str(raw.get("prompt", "")).strip()
            reference = raw.get("reference", raw.get("answer"))
            if prompt == "" or reference is None:
                return None

            metadata: dict[str, str | int | float | bool] = {
                "upstream_id": str(raw_id),
                "task_type": SUBTASK_TO_TASK_TYPE[subtask].value,
            }
            # TheoremQA carries an answer_type that the upstream grader needs.
            if "answer_type" in raw and raw["answer_type"] is not None:
                metadata["answer_type"] = str(raw["answer_type"])
            # MBPP carries a test_list separate from the reference.
            if "test_list" in raw and isinstance(raw["test_list"], list):
                metadata["test_list"] = json.dumps(raw["test_list"])

            return MINTTask(
                id=task_id,
                subtask=subtask,
                description=_SUBTASK_DESCRIPTION[subtask],
                initial_prompt=prompt,
                ground_truth=json.dumps(reference) if not isinstance(
                    reference, str
                ) else reference,
                max_turns=5,
                tools_allowed=["python"] if subtask is not MINTSubtask.ALFWORLD else [],
                evaluation_metric=_SUBTASK_METRIC[subtask],
                difficulty="medium",
                metadata=metadata,
            )
        except Exception as exc:
            logger.error(
                "[MINTDataset] Failed to build %s task from %r: %s",
                subtask.value,
                raw,
                exc,
            )
            return None

    def _load_smoke_tasks(self) -> None:
        """Tiny hand-written set, kept for offline CI/smoke tests.

        Three samples roughly mirror the GSM8K / HumanEval / MMLU shape so
        we can exercise the multi-turn protocol end-to-end without needing
        the vendored data files.
        """
        self.tasks[MINTSubtask.GSM8K] = [
            MINTTask(
                id="gsm8k-smoke-0",
                subtask=MINTSubtask.GSM8K,
                description=_SUBTASK_DESCRIPTION[MINTSubtask.GSM8K],
                initial_prompt=(
                    "Marissa walks 4 miles in 1 hour, then 2 miles in 1 hour. "
                    "To average 4 mph over 12 miles total, what speed must she "
                    "walk the remaining 6 miles? Output an integer."
                ),
                ground_truth="6",
                evaluation_metric="numeric",
                difficulty="easy",
            ),
        ]
        self.tasks[MINTSubtask.HUMANEVAL] = [
            MINTTask(
                id="humaneval-smoke-0",
                subtask=MINTSubtask.HUMANEVAL,
                description=_SUBTASK_DESCRIPTION[MINTSubtask.HUMANEVAL],
                initial_prompt=(
                    "Complete the following code:\n\n"
                    "def add(a: int, b: int) -> int:\n"
                    '    """Return a + b."""\n'
                ),
                ground_truth=(
                    "def check(candidate):\n"
                    "    assert candidate(1, 2) == 3\n"
                    "    assert candidate(-1, 1) == 0\n"
                ),
                evaluation_metric="code_test",
                difficulty="easy",
            ),
        ]
        self.tasks[MINTSubtask.MMLU] = [
            MINTTask(
                id="mmlu-smoke-0",
                subtask=MINTSubtask.MMLU,
                description=_SUBTASK_DESCRIPTION[MINTSubtask.MMLU],
                initial_prompt=(
                    "What is 2 + 2?\n"
                    "Options: A ) 3 , B ) 4 , C ) 5 , D ) 6"
                ),
                ground_truth="b",
                evaluation_metric="multiple_choice",
                difficulty="easy",
            ),
        ]
