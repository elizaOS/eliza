"""Tests for SWE-bench dataset loader."""

import pytest

from benchmarks.swe_bench.dataset import DatasetStatistics, SWEBenchDataset
from benchmarks.swe_bench.types import SWEBenchVariant


class TestSWEBenchDataset:
    """Test SWEBenchDataset class."""

    def test_init_default(self) -> None:
        """Test default initialization."""
        dataset = SWEBenchDataset()
        assert dataset.variant == SWEBenchVariant.LITE
        assert len(dataset.instances) == 0

    def test_init_with_variant(self) -> None:
        """Test initialization with variant."""
        dataset = SWEBenchDataset(variant=SWEBenchVariant.VERIFIED)
        assert dataset.variant == SWEBenchVariant.VERIFIED

    def test_dataset_mapping(self) -> None:
        """Test dataset name mapping."""
        assert SWEBenchDataset.DATASET_MAPPING[SWEBenchVariant.FULL] == "SWE-bench/SWE-bench"
        assert (
            SWEBenchDataset.DATASET_MAPPING[SWEBenchVariant.LITE]
            == "SWE-bench/SWE-bench_Lite"
        )
        assert (
            SWEBenchDataset.DATASET_MAPPING[SWEBenchVariant.VERIFIED]
            == "SWE-bench/SWE-bench_Verified"
        )

    def test_get_instances_not_loaded(self) -> None:
        """Test getting instances before loading raises error."""
        dataset = SWEBenchDataset()
        with pytest.raises(RuntimeError, match="not loaded"):
            dataset.get_instances()

    def test_get_statistics_not_loaded(self) -> None:
        """Test getting statistics before loading raises error."""
        dataset = SWEBenchDataset()
        with pytest.raises(RuntimeError, match="not loaded"):
            dataset.get_statistics()

    def test_len_empty(self) -> None:
        """Test length of empty dataset."""
        dataset = SWEBenchDataset()
        assert len(dataset) == 0


@pytest.mark.integration
class TestSWEBenchDatasetIntegration:
    """Integration tests that require network access."""

    @pytest.mark.asyncio
    async def test_load_lite_dataset(self) -> None:
        """Test loading the Lite dataset."""
        dataset = SWEBenchDataset(variant=SWEBenchVariant.LITE)
        await dataset.load()

        assert len(dataset) > 0
        assert len(dataset) <= 300  # Lite has ~300 instances

    @pytest.mark.asyncio
    async def test_get_by_repo(self) -> None:
        """Test grouping by repository."""
        dataset = SWEBenchDataset(variant=SWEBenchVariant.LITE)
        await dataset.load()

        by_repo = dataset.get_by_repo()
        assert len(by_repo) > 0

        # Should have multiple repositories
        assert len(by_repo) >= 5

    @pytest.mark.asyncio
    async def test_filter_by_repo(self) -> None:
        """Test filtering by repository."""
        dataset = SWEBenchDataset(variant=SWEBenchVariant.LITE)
        await dataset.load()

        django_instances = dataset.get_instances(repo_filter="django")
        assert all("django" in i.repo for i in django_instances)

    @pytest.mark.asyncio
    async def test_limit_instances(self) -> None:
        """Test limiting number of instances."""
        dataset = SWEBenchDataset(variant=SWEBenchVariant.LITE)
        await dataset.load()

        limited = dataset.get_instances(limit=5)
        assert len(limited) == 5

    @pytest.mark.asyncio
    async def test_instance_fields(self) -> None:
        """Test that instances have required fields."""
        dataset = SWEBenchDataset(variant=SWEBenchVariant.LITE)
        await dataset.load()

        instance = dataset.instances[0]
        assert instance.instance_id
        assert instance.repo
        assert instance.base_commit
        assert instance.problem_statement
        assert instance.patch
