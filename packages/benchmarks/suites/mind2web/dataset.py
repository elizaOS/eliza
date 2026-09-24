"""
Mind2Web dataset loader.

Loads tasks from the OSU-NLP-Group/Mind2Web HuggingFace dataset
or from local JSON files.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tempfile
import threading
from dataclasses import replace
from pathlib import Path
from zipfile import ZipFile

from .types import (
    Mind2WebActionStep,
    Mind2WebElement,
    Mind2WebOperation,
    Mind2WebSplit,
    Mind2WebTask,
)

logger = logging.getLogger(__name__)

EDGE_VARIANTS: tuple[tuple[str, str], ...] = (
    ("edge-ambiguous-instruction", "The instruction includes mild ambiguity; preserve the original website goal and use the annotated step trace as authoritative."),
    ("edge-distractor-element", "Distractor page elements may look relevant; choose the target that satisfies the current micro-action."),
    ("edge-compact-action", "Return only the next required browser action; do not add explanatory navigation steps."),
    ("edge-noisy-labels", "Element text, casing, or punctuation may be noisy; match by intent and backend candidate identity."),
    ("edge-order-independence", "Do not rely on candidate order except when using a listed element number from the prompt."),
    ("edge-step-boundary", "Do not merge future actions into the current step even if the full plan is visible."),
    ("edge-value-normalization", "For TYPE or SELECT, preserve the literal value required by the current action."),
    ("edge-stale-context", "Re-check the current step and previous actions before selecting an element."),
    ("edge-safety-boundary", "Do not invent hidden elements or actions that are not present in the candidate list."),
    ("edge-time-pressure", "Act efficiently while still matching operation, element, and value exactly."),
)


def expand_tasks(tasks: list[Mind2WebTask]) -> list[Mind2WebTask]:
    """Return base tasks plus ten scoring-preserving edge variants per task."""
    expanded = list(tasks)
    for task in tasks:
        for index, (variant_id, variant_note) in enumerate(EDGE_VARIANTS, start=1):
            metadata = dict(task.metadata)
            metadata.update(
                {
                    "edge_scenario": True,
                    "edge_variant": variant_id,
                    "edge_variant_index": index,
                    "edge_source_id": task.annotation_id,
                }
            )
            expanded.append(
                replace(
                    task,
                    annotation_id=f"{task.annotation_id}--edge-{index:02d}",
                    confirmed_task=f"{task.confirmed_task}\n\nEdge condition: {variant_note}",
                    # The benchmark treats traces as immutable. Sharing the
                    # six-gigabyte official HTML payload keeps 10x expansion
                    # bounded while each variant still owns its prompt/metadata.
                    action_reprs=task.action_reprs,
                    actions=task.actions,
                    metadata=metadata,
                )
            )
    return expanded


def validate_tasks(tasks: list[Mind2WebTask]) -> None:
    seen: set[str] = set()
    for task in tasks:
        if not task.annotation_id.strip():
            raise ValueError("task missing annotation_id")
        if task.annotation_id in seen:
            raise ValueError(f"duplicate task id: {task.annotation_id}")
        seen.add(task.annotation_id)
        if not task.confirmed_task.strip():
            raise ValueError(f"{task.annotation_id}: missing confirmed_task")
        if not task.actions:
            raise ValueError(f"{task.annotation_id}: missing actions")

EXPECTED_TEST_COUNTS: dict[str, int] = {
    "test_task": 252,
    "test_website": 177,
    "test_domain": 912,
}

MIND2WEB_DATASET_REPOSITORY = "osunlp/Mind2Web"
MIND2WEB_DATASET_REVISION = "17ece8eb89862368edc0cc806acee6fca5163474"
MIND2WEB_TEST_ARCHIVE_SHA256 = (
    "8f5fbe72afab942fe97cdf7fb397e179885d89b5c16862288e9a14bc6d41ca89"
)
MIND2WEB_TEST_ARCHIVE_PASSWORD = b"mind2web"
MIND2WEB_RANKER_SCORES_SHA256 = (
    "884c97cd9ae0544485d21ea39e0d46422aee0291969a7324e56df3a84466dbd7"
)

_HASH_CACHE_LOCK = threading.Lock()
_HASH_CACHE: dict[str, tuple[tuple[int, int, int, int, int], str]] = {}


def _default_cache_dir() -> Path:
    """Return the repository-owned cache for pinned Mind2Web test artifacts."""
    override = os.environ.get("MIND2WEB_CACHE_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    return Path(__file__).resolve().parents[2] / "benchmark-data" / "mind2web"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_identity(path: Path) -> tuple[int, int, int, int, int]:
    stat = path.stat()
    return (
        stat.st_dev,
        stat.st_ino,
        stat.st_size,
        stat.st_mtime_ns,
        stat.st_ctime_ns,
    )


def _memoized_sha256(path: Path) -> str:
    """Hash an unchanged artifact once per process.

    MindAct's released score pickle is consulted for every action step. The
    filesystem identity keeps that hot path constant-time while invalidating
    the cached digest if the file is replaced or modified.
    """
    resolved = path.resolve()
    cache_key = str(resolved)
    identity = _file_identity(resolved)
    with _HASH_CACHE_LOCK:
        cached = _HASH_CACHE.get(cache_key)
        if cached is not None and cached[0] == identity:
            return cached[1]
        digest = _sha256(resolved)
        if _file_identity(resolved) != identity:
            raise RuntimeError(f"Mind2Web artifact changed while hashing: {resolved}")
        _HASH_CACHE[cache_key] = (identity, digest)
        return digest


def ensure_test_splits_available() -> Path:
    """Materialize the pinned official archive or fail before model execution."""

    cache_dir = _default_cache_dir()
    extracted_dir = cache_dir / "extracted"
    completion_marker = extracted_dir / ".complete"
    zip_path = cache_dir / "test.zip"
    if not zip_path.exists():
        if os.environ.get("MIND2WEB_DISABLE_DATA_DOWNLOAD", "").strip() == "1":
            raise FileNotFoundError(
                f"Pinned Mind2Web archive is missing at {zip_path}; provision it before the campaign"
            )
        try:
            from huggingface_hub import hf_hub_download
        except ImportError as exc:
            raise RuntimeError(
                "huggingface_hub is required to download the pinned Mind2Web archive"
            ) from exc
        cache_dir.mkdir(parents=True, exist_ok=True)
        downloaded = hf_hub_download(
            repo_id=MIND2WEB_DATASET_REPOSITORY,
            repo_type="dataset",
            filename="test.zip",
            revision=MIND2WEB_DATASET_REVISION,
            local_dir=cache_dir,
        )
        zip_path = Path(downloaded)

    archive_sha256 = _memoized_sha256(zip_path)
    if archive_sha256 != MIND2WEB_TEST_ARCHIVE_SHA256:
        raise RuntimeError(
            "Mind2Web archive checksum mismatch: "
            f"expected {MIND2WEB_TEST_ARCHIVE_SHA256}, got {archive_sha256}"
        )
    if (
        completion_marker.exists()
        and completion_marker.read_text(encoding="utf-8").strip() == archive_sha256
    ):
        return extracted_dir

    cache_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".mind2web-extract-", dir=cache_dir) as temp_dir:
        extraction_root = Path(temp_dir)
        with ZipFile(zip_path) as archive:
            root = extraction_root.resolve()
            for member in archive.infolist():
                target = (root / member.filename).resolve()
                if not target.is_relative_to(root):
                    raise RuntimeError(f"Unsafe path in Mind2Web archive: {member.filename}")
            archive.extractall(extraction_root, pwd=MIND2WEB_TEST_ARCHIVE_PASSWORD)
        (extraction_root / ".complete").write_text(archive_sha256, encoding="utf-8")
        if extracted_dir.exists():
            shutil.rmtree(extracted_dir)
        extraction_root.replace(extracted_dir)
    return extracted_dir


def ensure_ranker_scores_available() -> Path:
    """Resolve the pinned official candidate-generation outputs."""
    cache_dir = _default_cache_dir()
    scores_path = cache_dir / "scores_all_data.pkl"
    if not scores_path.exists():
        if os.environ.get("MIND2WEB_DISABLE_DATA_DOWNLOAD", "").strip() == "1":
            raise FileNotFoundError(
                "Pinned Mind2Web ranker scores are missing at "
                f"{scores_path}; provision them before the campaign"
            )
        try:
            from huggingface_hub import hf_hub_download
        except ImportError as exc:
            raise RuntimeError(
                "huggingface_hub is required to download pinned Mind2Web ranker scores"
            ) from exc
        cache_dir.mkdir(parents=True, exist_ok=True)
        downloaded = hf_hub_download(
            repo_id=MIND2WEB_DATASET_REPOSITORY,
            repo_type="dataset",
            filename="scores_all_data.pkl",
            revision=MIND2WEB_DATASET_REVISION,
            local_dir=cache_dir,
        )
        scores_path = Path(downloaded)

    scores_sha256 = _memoized_sha256(scores_path)
    if scores_sha256 != MIND2WEB_RANKER_SCORES_SHA256:
        raise RuntimeError(
            "Mind2Web ranker-score checksum mismatch: "
            f"expected {MIND2WEB_RANKER_SCORES_SHA256}, got {scores_sha256}"
        )
    return scores_path


# Sample tasks for testing without HuggingFace
SAMPLE_TASKS: list[dict[str, object]] = [
    {
        "annotation_id": "sample_001",
        "confirmed_task": "Search for 'wireless headphones' on Amazon and filter by price under $50",
        "website": "amazon.com",
        "domain": "shopping",
        "subdomain": "electronics",
        "action_reprs": [
            "Click on search box",
            "Type 'wireless headphones'",
            "Click search button",
            "Click price filter",
            "Select 'Under $50'",
        ],
        "actions": [
            {
                "action_uid": "a001",
                "operation": {"op": "CLICK", "original_op": "CLICK", "value": ""},
                "pos_candidates": [
                    {
                        "tag": "input",
                        "backend_node_id": "node_search",
                        "attributes": {"id": "twotabsearchtextbox", "type": "text"},
                        "is_original_target": True,
                        "is_top_level_target": True,
                    }
                ],
                "neg_candidates": [],
            },
            {
                "action_uid": "a002",
                "operation": {"op": "TYPE", "original_op": "TYPE", "value": "wireless headphones"},
                "pos_candidates": [
                    {
                        "tag": "input",
                        "backend_node_id": "node_search",
                        "attributes": {"id": "twotabsearchtextbox", "type": "text"},
                        "is_original_target": True,
                        "is_top_level_target": True,
                    }
                ],
                "neg_candidates": [],
            },
            {
                "action_uid": "a003",
                "operation": {"op": "CLICK", "original_op": "CLICK", "value": ""},
                "pos_candidates": [
                    {
                        "tag": "button",
                        "backend_node_id": "node_submit",
                        "attributes": {"id": "nav-search-submit-button", "type": "submit"},
                        "is_original_target": True,
                        "is_top_level_target": True,
                    }
                ],
                "neg_candidates": [],
            },
        ],
    },
    {
        "annotation_id": "sample_002",
        "confirmed_task": "Book a one-way flight from New York to Los Angeles for next Monday",
        "website": "google.com/flights",
        "domain": "travel",
        "subdomain": "flights",
        "action_reprs": [
            "Click on departure city",
            "Type 'New York'",
            "Select 'New York (JFK)'",
            "Click on destination",
            "Type 'Los Angeles'",
            "Select 'Los Angeles (LAX)'",
            "Click on one-way option",
            "Click on date picker",
            "Select next Monday",
        ],
        "actions": [
            {
                "action_uid": "b001",
                "operation": {"op": "CLICK", "original_op": "CLICK", "value": ""},
                "pos_candidates": [
                    {
                        "tag": "input",
                        "backend_node_id": "node_from",
                        "attributes": {"aria-label": "Where from?"},
                        "is_original_target": True,
                        "is_top_level_target": True,
                    }
                ],
                "neg_candidates": [],
            },
            {
                "action_uid": "b002",
                "operation": {"op": "TYPE", "original_op": "TYPE", "value": "New York"},
                "pos_candidates": [
                    {
                        "tag": "input",
                        "backend_node_id": "node_from",
                        "attributes": {"aria-label": "Where from?"},
                        "is_original_target": True,
                        "is_top_level_target": True,
                    }
                ],
                "neg_candidates": [],
            },
        ],
    },
    {
        "annotation_id": "sample_003",
        "confirmed_task": "Find the contact email for customer support on GitHub",
        "website": "github.com",
        "domain": "software",
        "subdomain": "support",
        "action_reprs": [
            "Click on footer link 'Contact'",
            "Click on 'Contact Support'",
        ],
        "actions": [
            {
                "action_uid": "c001",
                "operation": {"op": "CLICK", "original_op": "CLICK", "value": ""},
                "pos_candidates": [
                    {
                        "tag": "a",
                        "backend_node_id": "node_contact",
                        "attributes": {"href": "/contact", "text": "Contact"},
                        "is_original_target": True,
                        "is_top_level_target": True,
                    }
                ],
                "neg_candidates": [],
            },
        ],
    },
]


class Mind2WebDataset:
    """Loader for Mind2Web dataset."""

    def __init__(
        self,
        split: Mind2WebSplit = Mind2WebSplit.TEST_TASK,
        data_dir: Path | None = None,
    ) -> None:
        self.split = split
        self.data_dir = data_dir
        self.tasks: list[Mind2WebTask] = []
        self._loaded = False
        self.data_provenance: dict[str, object] = {}

    async def load(self, *, use_huggingface: bool = True, use_sample: bool = False) -> None:
        """Load the dataset.

        Args:
            use_huggingface: If True, load from HuggingFace datasets
            use_sample: If True, use built-in sample tasks (for testing)
        """
        if self._loaded:
            return

        if use_sample:
            self._load_sample_tasks()
            self.data_provenance = {
                "mode": "sample",
                "publishable": False,
                "base_task_count": len(self.tasks),
            }
        elif use_huggingface:
            await self._load_from_huggingface()
        elif self.data_dir:
            self._load_from_local()
        else:
            raise RuntimeError("Mind2Web requires --hf, --sample, or an explicit data directory")

        self._loaded = True
        logger.info(f"Loaded {len(self.tasks)} tasks from Mind2Web ({self.split.value})")

    def _load_sample_tasks(self) -> None:
        """Load built-in sample tasks for testing."""
        for task_dict in SAMPLE_TASKS:
            task = self._parse_task(task_dict)
            if task:
                self.tasks.append(task)

    async def _load_from_huggingface(self) -> None:
        """Load a pinned official test split from the Hugging Face archive."""
        if self.split == Mind2WebSplit.TRAIN:
            raise RuntimeError(
                "The full campaign uses official test splits; train loading is not supported here"
            )
        extracted_dir = ensure_test_splits_available()
        split_name = self.split.value
        split_files = sorted(
            path
            for path in extracted_dir.rglob("*.json")
            if split_name in path.parts or split_name in path.stem
        )
        if not split_files:
            raise FileNotFoundError(
                f"Mind2Web archive contains no JSON files for split {split_name!r}"
            )
        for json_file in split_files:
            with json_file.open(encoding="utf-8") as handle:
                data = json.load(handle)
            records = data if isinstance(data, list) else [data]
            for item in records:
                if not isinstance(item, dict):
                    raise ValueError(f"{json_file}: expected task objects")
                self.tasks.append(self._parse_hf_item(item))

        expected = EXPECTED_TEST_COUNTS[split_name]
        if len(self.tasks) != expected:
            raise RuntimeError(
                f"Mind2Web {split_name} count mismatch: expected {expected}, got {len(self.tasks)}"
            )
        archive_path = _default_cache_dir() / "test.zip"
        self.data_provenance = {
            "mode": "official-pinned-test-archive",
            "repository": MIND2WEB_DATASET_REPOSITORY,
            "revision": MIND2WEB_DATASET_REVISION,
            "archive_path": str(archive_path.resolve()),
            "archive_sha256": _memoized_sha256(archive_path),
            "split": split_name,
            "base_task_count": len(self.tasks),
            "publishable": True,
        }

    def _load_from_local(self) -> None:
        """Load dataset from local JSON files."""
        if not self.data_dir or not self.data_dir.exists():
            raise FileNotFoundError(f"Mind2Web data directory not found: {self.data_dir}")

        # Look for task JSON files
        json_files = list(self.data_dir.glob("*.json"))
        if not json_files:
            json_files = list(self.data_dir.glob("**/*.json"))
        if not json_files:
            raise FileNotFoundError(f"Mind2Web data directory has no JSON files: {self.data_dir}")

        for json_file in json_files:
            with open(json_file, encoding="utf-8") as handle:
                data = json.load(handle)

            if isinstance(data, list):
                for item in data:
                    if not isinstance(item, dict):
                        raise ValueError(f"{json_file}: expected task objects")
                    self.tasks.append(self._parse_task(item))
            elif isinstance(data, dict):
                self.tasks.append(self._parse_task(data))
            else:
                raise ValueError(f"{json_file}: expected a task object or list")
        self.data_provenance = {
            "mode": "explicit-local",
            "path": str(self.data_dir.resolve()),
            "base_task_count": len(self.tasks),
            "publishable": False,
        }

    def _parse_hf_item(self, item: dict[str, object]) -> Mind2WebTask:
        """Parse a HuggingFace dataset item into a Mind2WebTask."""
        return self._parse_task(item)

    def _parse_task(self, data: dict[str, object]) -> Mind2WebTask:
        """Parse a task dictionary into a Mind2WebTask."""
        annotation_id = str(data.get("annotation_id", "")).strip()
        confirmed_task = str(data.get("confirmed_task", "")).strip()
        website = str(data.get("website", ""))
        domain = str(data.get("domain", ""))
        subdomain = str(data.get("subdomain", ""))
        if not annotation_id or not confirmed_task:
            raise ValueError("Mind2Web task is missing annotation_id or confirmed_task")

        action_reprs_raw = data.get("action_reprs", [])
        if not isinstance(action_reprs_raw, list):
            raise ValueError(f"{annotation_id}: action_reprs must be a list")
        action_reprs = [str(item) for item in action_reprs_raw]

        actions_raw = data.get("actions", [])
        if not isinstance(actions_raw, list):
            raise ValueError(f"{annotation_id}: actions must be a list")
        actions: list[Mind2WebActionStep] = []
        for action_data in actions_raw:
            if not isinstance(action_data, dict):
                raise ValueError(f"{annotation_id}: action must be an object")
            actions.append(self._parse_action_step(action_data))

        return Mind2WebTask(
            annotation_id=annotation_id,
            confirmed_task=confirmed_task,
            website=website,
            domain=domain,
            subdomain=subdomain,
            action_reprs=action_reprs,
            actions=actions,
        )

    def _parse_action_step(self, data: dict[str, object]) -> Mind2WebActionStep:
        """Parse an action step from the dataset."""
        action_uid = str(data.get("action_uid", "")).strip()
        if not action_uid:
            raise ValueError("Mind2Web action is missing action_uid")

        operation_data = data.get("operation")
        if not isinstance(operation_data, dict):
            raise ValueError(f"{action_uid}: operation must be an object")
        op_str = str(operation_data.get("op", "")).upper().strip()
        operation = Mind2WebOperation(op_str)
        if operation == Mind2WebOperation.INVALID:
            raise ValueError(f"{action_uid}: INVALID is not a ground-truth operation")
        original_op = str(operation_data.get("original_op", op_str))
        value = str(operation_data.get("value", ""))

        return Mind2WebActionStep(
            action_uid=action_uid,
            operation=operation,
            value=value,
            original_op=original_op,
            raw_html=str(data.get("raw_html", "")),
            cleaned_html=str(data.get("cleaned_html", "")),
            pos_candidates=self._parse_candidates(data.get("pos_candidates", [])),
            neg_candidates=self._parse_candidates(data.get("neg_candidates", [])),
        )

    def _parse_candidates(self, candidates_raw: object) -> list[Mind2WebElement]:
        """Parse candidate elements."""
        candidates: list[Mind2WebElement] = []

        if not isinstance(candidates_raw, list):
            raise ValueError("Mind2Web candidates must be a list")

        for cand in candidates_raw:
            if not isinstance(cand, dict):
                raise ValueError("Mind2Web candidate must be an object")

            tag = str(cand.get("tag", ""))
            backend_node_id = str(cand.get("backend_node_id", ""))

            attributes_raw = cand.get("attributes", {})
            attributes: dict[str, str] = {}
            if isinstance(attributes_raw, dict):
                for k, v in attributes_raw.items():
                    attributes[str(k)] = str(v)
            elif isinstance(attributes_raw, str):
                parsed = json.loads(attributes_raw)
                if not isinstance(parsed, dict):
                    raise ValueError("Mind2Web candidate attributes must decode to an object")
                for k, v in parsed.items():
                    attributes[str(k)] = str(v)
            else:
                raise ValueError("Mind2Web candidate attributes must be an object or JSON string")

            is_original = bool(cand.get("is_original_target", False))
            is_top_level = bool(cand.get("is_top_level_target", False))
            text_content = str(cand.get("text_content", ""))

            candidates.append(
                Mind2WebElement(
                    tag=tag,
                    backend_node_id=backend_node_id,
                    attributes=attributes,
                    is_original_target=is_original,
                    is_top_level_target=is_top_level,
                    text_content=text_content,
                )
            )

        return candidates

    def get_tasks(self, limit: int | None = None) -> list[Mind2WebTask]:
        """Get loaded tasks.

        Args:
            limit: Maximum number of tasks to return

        Returns:
            List of Mind2WebTask objects
        """
        if limit is not None:
            return self.tasks[:limit]
        return list(self.tasks)

    def get_task_by_id(self, annotation_id: str) -> Mind2WebTask | None:
        """Get a specific task by annotation ID."""
        for task in self.tasks:
            if task.annotation_id == annotation_id:
                return task
        return None

    def filter_by_domain(self, domain: str) -> list[Mind2WebTask]:
        """Filter tasks by domain."""
        return [t for t in self.tasks if t.domain.lower() == domain.lower()]

    def filter_by_website(self, website: str) -> list[Mind2WebTask]:
        """Filter tasks by website."""
        return [t for t in self.tasks if website.lower() in t.website.lower()]
