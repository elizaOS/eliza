"""Dataset loader for SWE-bench from HuggingFace."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from .types import SWEBenchInstance, SWEBenchVariant

logger = logging.getLogger(__name__)


@dataclass
class DatasetStatistics:
    """Statistics about the loaded dataset."""

    total_instances: int
    num_repos: int
    avg_per_repo: float
    repos: list[str]


@dataclass(frozen=True)
class DatasetSource:
    """Pinned Hugging Face source metadata for one official variant."""

    name: str
    revision: str
    expected_test_count: int
    expected_fingerprint: str


class SWEBenchDataset:
    """Load and manage SWE-bench dataset."""

    DATASET_SOURCES = {
        SWEBenchVariant.FULL: DatasetSource(
            name="SWE-bench/SWE-bench",
            revision="7074ef12ea2a6f70a228943c1336553333c22786",
            expected_test_count=2294,
            expected_fingerprint="5332f0b2fc99d672",
        ),
        SWEBenchVariant.LITE: DatasetSource(
            name="SWE-bench/SWE-bench_Lite",
            revision="69611d31007e1c6731db8bd5b5c3f2d33f5bab6e",
            expected_test_count=300,
            expected_fingerprint="4ab780ff56563470",
        ),
        SWEBenchVariant.VERIFIED: DatasetSource(
            name="SWE-bench/SWE-bench_Verified",
            revision="91aa3ed51b709be6457e12d00300a6a596d4c6a3",
            expected_test_count=500,
            expected_fingerprint="24e4847db36d5b81",
        ),
        SWEBenchVariant.MULTILINGUAL: DatasetSource(
            name="SWE-bench/SWE-bench_Multilingual",
            revision="2b7aced941b4873e9cad3e76abbae93f481d1beb",
            expected_test_count=300,
            expected_fingerprint="31ff5383e0cdf7e3",
        ),
    }
    DATASET_MAPPING = {variant: source.name for variant, source in DATASET_SOURCES.items()}

    def __init__(
        self,
        variant: SWEBenchVariant = SWEBenchVariant.LITE,
        cache_dir: str | None = None,
    ):
        self.variant = variant
        default_cache = (
            Path(__file__).resolve().parents[2]
            / "benchmark-data"
            / "huggingface"
            / "datasets"
        )
        self.cache_dir = Path(cache_dir) if cache_dir else default_cache
        snapshot_override = os.environ.get("SWE_BENCH_SNAPSHOT_DIR", "").strip()
        self.snapshot_dir = (
            Path(snapshot_override)
            if snapshot_override
            else self.cache_dir.parent / "swebench-snapshots"
        )
        self.instances: list[SWEBenchInstance] = []
        self.snapshot_path: Path | None = None
        self.provenance: dict[str, object] = {}
        self._loaded = False

    async def load(self, split: str = "test") -> None:
        """Load SWE-bench dataset from HuggingFace."""
        try:
            from datasets import load_dataset
        except ImportError:
            raise ImportError(
                "datasets library required. Install with: pip install datasets"
            ) from None

        source = self.DATASET_SOURCES[self.variant]
        dataset_name = source.name
        logger.info(f"Loading {dataset_name} ({split} split)...")

        dataset = load_dataset(
            dataset_name,
            split=split,
            revision=source.revision,
            cache_dir=str(self.cache_dir),
        )
        if split == "test" and len(dataset) != source.expected_test_count:
            raise RuntimeError(
                f"Pinned {dataset_name}@{source.revision} returned {len(dataset)} instances; "
                f"expected {source.expected_test_count}"
            )
        actual_fingerprint = str(getattr(dataset, "_fingerprint", ""))
        if split == "test" and actual_fingerprint != source.expected_fingerprint:
            raise RuntimeError(
                f"Pinned {dataset_name}@{source.revision} fingerprint is "
                f"{actual_fingerprint!r}; expected {source.expected_fingerprint!r}"
            )
        self.snapshot_dir.mkdir(parents=True, exist_ok=True)
        snapshot_path = self.snapshot_dir / f"{self.variant.value}-{source.revision}.jsonl"
        pending_snapshot = snapshot_path.with_suffix(".pending.jsonl")
        dataset.to_json(str(pending_snapshot), orient="records", lines=True)
        pending_snapshot.replace(snapshot_path)
        snapshot_sha256 = hashlib.sha256(snapshot_path.read_bytes()).hexdigest()
        self.snapshot_path = snapshot_path
        self.provenance = {
            "dataset": dataset_name,
            "revision": source.revision,
            "split": split,
            "expected_count": source.expected_test_count if split == "test" else None,
            "actual_count": len(dataset),
            "expected_fingerprint": source.expected_fingerprint,
            "actual_fingerprint": actual_fingerprint,
            "snapshot_path": str(snapshot_path),
            "snapshot_sha256": snapshot_sha256,
        }
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
