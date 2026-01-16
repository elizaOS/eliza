"""
Mind2Web dataset loader.

Loads tasks from the OSU-NLP-Group/Mind2Web HuggingFace dataset
or from local JSON files.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from benchmarks.mind2web.types import (
    Mind2WebActionStep,
    Mind2WebElement,
    Mind2WebOperation,
    Mind2WebSplit,
    Mind2WebTask,
)

logger = logging.getLogger(__name__)

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
        elif use_huggingface:
            await self._load_from_huggingface()
        elif self.data_dir:
            self._load_from_local()
        else:
            logger.warning("No data source specified, using sample tasks")
            self._load_sample_tasks()

        self._loaded = True
        logger.info(f"Loaded {len(self.tasks)} tasks from Mind2Web ({self.split.value})")

    def _load_sample_tasks(self) -> None:
        """Load built-in sample tasks for testing."""
        for task_dict in SAMPLE_TASKS:
            task = self._parse_task(task_dict)
            if task:
                self.tasks.append(task)

    async def _load_from_huggingface(self) -> None:
        """Load dataset from HuggingFace."""
        try:
            from datasets import load_dataset  # type: ignore[import-not-found]
        except ImportError:
            logger.warning(
                "datasets package not installed. Install with: pip install datasets"
            )
            self._load_sample_tasks()
            return

        try:
            # Mind2Web dataset on HuggingFace
            try:
                dataset = load_dataset(
                    "osunlp/Mind2Web",
                    split=self.split.value,
                )
            except Exception as e:
                if "Unknown split" not in str(e):
                    raise
                logger.warning(
                    f"Split '{self.split.value}' not available; falling back to 'train'"
                )
                dataset = load_dataset(
                    "osunlp/Mind2Web",
                    split="train",
                )

            for item in dataset:
                task = self._parse_hf_item(item)
                if task:
                    self.tasks.append(task)

        except Exception as e:
            logger.error(f"Failed to load from HuggingFace: {e}")
            logger.info("Falling back to sample tasks")
            self._load_sample_tasks()

    def _load_from_local(self) -> None:
        """Load dataset from local JSON files."""
        if not self.data_dir or not self.data_dir.exists():
            logger.warning(f"Data directory not found: {self.data_dir}")
            self._load_sample_tasks()
            return

        # Look for task JSON files
        json_files = list(self.data_dir.glob("*.json"))
        if not json_files:
            json_files = list(self.data_dir.glob("**/*.json"))

        for json_file in json_files:
            try:
                with open(json_file) as f:
                    data = json.load(f)

                if isinstance(data, list):
                    for item in data:
                        task = self._parse_task(item)
                        if task:
                            self.tasks.append(task)
                elif isinstance(data, dict):
                    task = self._parse_task(data)
                    if task:
                        self.tasks.append(task)

            except Exception as e:
                logger.warning(f"Failed to load {json_file}: {e}")

    def _parse_hf_item(self, item: dict[str, object]) -> Mind2WebTask | None:
        """Parse a HuggingFace dataset item into a Mind2WebTask."""
        return self._parse_task(item)

    def _parse_task(self, data: dict[str, object]) -> Mind2WebTask | None:
        """Parse a task dictionary into a Mind2WebTask."""
        try:
            annotation_id = str(data.get("annotation_id", ""))
            confirmed_task = str(data.get("confirmed_task", ""))
            website = str(data.get("website", ""))
            domain = str(data.get("domain", ""))
            subdomain = str(data.get("subdomain", ""))

            if not annotation_id or not confirmed_task:
                return None

            action_reprs_raw = data.get("action_reprs", [])
            action_reprs: list[str] = []
            if isinstance(action_reprs_raw, list):
                action_reprs = [str(x) for x in action_reprs_raw]

            actions_raw = data.get("actions", [])
            actions: list[Mind2WebActionStep] = []
            if isinstance(actions_raw, list):
                for action_data in actions_raw:
                    if isinstance(action_data, dict):
                        action = self._parse_action_step(action_data)
                        if action:
                            actions.append(action)

            return Mind2WebTask(
                annotation_id=annotation_id,
                confirmed_task=confirmed_task,
                website=website,
                domain=domain,
                subdomain=subdomain,
                action_reprs=action_reprs,
                actions=actions,
            )

        except Exception as e:
            logger.warning(f"Failed to parse task: {e}")
            return None

    def _parse_action_step(self, data: dict[str, object]) -> Mind2WebActionStep | None:
        """Parse an action step from the dataset."""
        try:
            action_uid = str(data.get("action_uid", ""))

            operation_data = data.get("operation", {})
            if isinstance(operation_data, dict):
                op_str = str(operation_data.get("op", "CLICK")).upper()
                original_op = str(operation_data.get("original_op", op_str))
                value = str(operation_data.get("value", ""))
            else:
                op_str = "CLICK"
                original_op = "CLICK"
                value = ""

            # Map operation string to enum
            try:
                operation = Mind2WebOperation(op_str)
            except ValueError:
                # Handle unmapped operations
                if op_str in ("HOVER", "ENTER"):
                    operation = Mind2WebOperation.CLICK
                else:
                    operation = Mind2WebOperation.CLICK

            raw_html = str(data.get("raw_html", ""))
            cleaned_html = str(data.get("cleaned_html", ""))

            pos_candidates = self._parse_candidates(data.get("pos_candidates", []))
            neg_candidates = self._parse_candidates(data.get("neg_candidates", []))

            return Mind2WebActionStep(
                action_uid=action_uid,
                operation=operation,
                value=value,
                original_op=original_op,
                raw_html=raw_html,
                cleaned_html=cleaned_html,
                pos_candidates=pos_candidates,
                neg_candidates=neg_candidates,
            )

        except Exception as e:
            logger.warning(f"Failed to parse action step: {e}")
            return None

    def _parse_candidates(self, candidates_raw: object) -> list[Mind2WebElement]:
        """Parse candidate elements."""
        candidates: list[Mind2WebElement] = []

        if not isinstance(candidates_raw, list):
            return candidates

        for cand in candidates_raw:
            if not isinstance(cand, dict):
                continue

            tag = str(cand.get("tag", ""))
            backend_node_id = str(cand.get("backend_node_id", ""))

            attributes_raw = cand.get("attributes", {})
            attributes: dict[str, str] = {}
            if isinstance(attributes_raw, dict):
                for k, v in attributes_raw.items():
                    attributes[str(k)] = str(v)
            elif isinstance(attributes_raw, str):
                # Sometimes attributes are JSON-encoded strings
                try:
                    parsed = json.loads(attributes_raw)
                    if isinstance(parsed, dict):
                        for k, v in parsed.items():
                            attributes[str(k)] = str(v)
                except json.JSONDecodeError:
                    pass

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
