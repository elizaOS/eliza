"""Dataset loader for SWE-bench from HuggingFace."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from .types import SWEBenchInstance, SWEBenchVariant

logger = logging.getLogger(__name__)


@dataclass
class DatasetStatistics:
    """Statistics about the loaded dataset."""

    total_instances: int
    num_repos: int
    avg_per_repo: float
    repos: list[str]


class SWEBenchDataset:
    """Load and manage SWE-bench dataset."""

    DATASET_MAPPING = {
        # NOTE: Both the legacy "princeton-nlp/*" and the newer "SWE-bench/*"
        # dataset namespaces exist. We prefer the official SWE-bench org.
        SWEBenchVariant.FULL: "SWE-bench/SWE-bench",
        SWEBenchVariant.LITE: "SWE-bench/SWE-bench_Lite",
        SWEBenchVariant.VERIFIED: "SWE-bench/SWE-bench_Verified",
    }

    def __init__(
        self,
        variant: SWEBenchVariant = SWEBenchVariant.LITE,
        cache_dir: str | None = None,
    ):
        self.variant = variant
        self.cache_dir = Path(cache_dir) if cache_dir else Path.home() / ".cache" / "swe-bench"
        self.instances: list[SWEBenchInstance] = []
        self._loaded = False

    async def load(self, split: str = "test") -> None:
        """Load SWE-bench dataset from HuggingFace."""
        try:
            from datasets import load_dataset
        except ImportError:
            raise ImportError(
                "datasets library required. Install with: pip install datasets"
            )

        dataset_name = self.DATASET_MAPPING[self.variant]
        logger.info(f"Loading {dataset_name} ({split} split)...")

        dataset = load_dataset(dataset_name, split=split)
        self.instances = []

        for item in dataset:
            # Handle FAIL_TO_PASS and PASS_TO_PASS which can be strings or lists
            fail_to_pass = item.get("FAIL_TO_PASS", [])
            pass_to_pass = item.get("PASS_TO_PASS", [])

            # Parse if they're JSON strings
            if isinstance(fail_to_pass, str):
                try:
                    fail_to_pass = json.loads(fail_to_pass)
                except json.JSONDecodeError:
                    fail_to_pass = [fail_to_pass] if fail_to_pass else []

            if isinstance(pass_to_pass, str):
                try:
                    pass_to_pass = json.loads(pass_to_pass)
                except json.JSONDecodeError:
                    pass_to_pass = [pass_to_pass] if pass_to_pass else []

            instance = SWEBenchInstance(
                instance_id=item["instance_id"],
                repo=item["repo"],
                base_commit=item["base_commit"],
                problem_statement=item["problem_statement"],
                hints_text=item.get("hints_text", ""),
                created_at=item.get("created_at", ""),
                patch=item["patch"],
                test_patch=item.get("test_patch", ""),
                fail_to_pass=fail_to_pass if isinstance(fail_to_pass, list) else [],
                pass_to_pass=pass_to_pass if isinstance(pass_to_pass, list) else [],
                version=item.get("version", ""),
                environment_setup_commit=item.get("environment_setup_commit", ""),
            )
            self.instances.append(instance)

        self._loaded = True
        logger.info(f"Loaded {len(self.instances)} instances from {dataset_name}")

    def get_instances(
        self,
        repo_filter: str | None = None,
        limit: int | None = None,
    ) -> list[SWEBenchInstance]:
        """Get instances with optional filtering."""
        if not self._loaded:
            raise RuntimeError("Dataset not loaded. Call load() first.")

        filtered = self.instances

        if repo_filter:
            filtered = [i for i in filtered if repo_filter in i.repo]

        return filtered[:limit] if limit else filtered

    def get_by_repo(self) -> dict[str, list[SWEBenchInstance]]:
        """Group instances by repository."""
        if not self._loaded:
            raise RuntimeError("Dataset not loaded. Call load() first.")

        by_repo: dict[str, list[SWEBenchInstance]] = {}
        for instance in self.instances:
            repo = instance.repo
            if repo not in by_repo:
                by_repo[repo] = []
            by_repo[repo].append(instance)

        return by_repo

    def __iter__(self) -> Iterator[SWEBenchInstance]:
        """Iterate over instances."""
        return iter(self.instances)

    def __len__(self) -> int:
        """Return number of instances."""
        return len(self.instances)

    def get_statistics(self) -> DatasetStatistics:
        """Get dataset statistics."""
        if not self._loaded:
            raise RuntimeError("Dataset not loaded. Call load() first.")

        by_repo = self.get_by_repo()

        return DatasetStatistics(
            total_instances=len(self.instances),
            num_repos=len(by_repo),
            avg_per_repo=len(self.instances) / len(by_repo) if by_repo else 0.0,
            repos=list(by_repo.keys()),
        )
