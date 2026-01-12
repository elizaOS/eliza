"""Tests for repository manager."""

import asyncio
import tempfile
from pathlib import Path

import pytest

from benchmarks.swe_bench.repo_manager import RepositoryManager
from benchmarks.swe_bench.types import SWEBenchInstance


class TestRepositoryManager:
    """Test RepositoryManager class."""

    @pytest.fixture
    def temp_workspace(self) -> Path:
        """Create a temporary workspace."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield Path(tmpdir)

    @pytest.fixture
    def repo_manager(self, temp_workspace: Path) -> RepositoryManager:
        """Create a repository manager."""
        return RepositoryManager(str(temp_workspace))

    def test_init(self, temp_workspace: Path) -> None:
        """Test initialization creates workspace."""
        manager = RepositoryManager(str(temp_workspace / "new_workspace"))
        assert manager.workspace_dir.exists()

    def test_read_file_no_repo(self, repo_manager: RepositoryManager) -> None:
        """Test reading file with no repo set up."""

        async def test() -> None:
            content = await repo_manager.read_file("nonexistent.py")
            assert content is None

        asyncio.run(test())

    def test_search_code_no_repo(self, repo_manager: RepositoryManager) -> None:
        """Test searching code with no repo set up."""

        async def test() -> None:
            results = await repo_manager.search_code("pattern")
            assert results == []

        asyncio.run(test())

    def test_get_file_tree_no_repo(self, repo_manager: RepositoryManager) -> None:
        """Test getting file tree with no repo set up."""

        async def test() -> None:
            files = await repo_manager.get_file_tree()
            assert files == []

        asyncio.run(test())

    def test_get_diff_no_repo(self, repo_manager: RepositoryManager) -> None:
        """Test getting diff with no repo set up."""

        async def test() -> None:
            diff = await repo_manager.get_diff()
            assert diff == ""

        asyncio.run(test())


@pytest.mark.integration
class TestRepositoryManagerIntegration:
    """Integration tests for RepositoryManager."""

    @pytest.fixture
    def temp_workspace(self) -> Path:
        """Create a temporary workspace."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield Path(tmpdir)

    @pytest.fixture
    def sample_instance(self) -> SWEBenchInstance:
        """Create a sample SWE-bench instance."""
        return SWEBenchInstance(
            instance_id="test__test-1",
            repo="octocat/Hello-World",  # Simple public repo for testing
            base_commit="7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
            problem_statement="Test issue",
            hints_text="",
            created_at="2023-01-01",
            patch="",
            test_patch="",
            fail_to_pass=[],
            pass_to_pass=[],
        )

    @pytest.mark.asyncio
    async def test_setup_repo(
        self, temp_workspace: Path, sample_instance: SWEBenchInstance
    ) -> None:
        """Test setting up a repository."""
        manager = RepositoryManager(str(temp_workspace))
        repo_dir = await manager.setup_repo(sample_instance)

        assert repo_dir.exists()
        assert (repo_dir / ".git").exists()
        assert manager.current_repo == repo_dir

    @pytest.mark.asyncio
    async def test_read_file(
        self, temp_workspace: Path, sample_instance: SWEBenchInstance
    ) -> None:
        """Test reading a file from repository."""
        manager = RepositoryManager(str(temp_workspace))
        await manager.setup_repo(sample_instance)

        content = await manager.read_file("README")
        assert content is not None
        assert "Hello World" in content

    @pytest.mark.asyncio
    async def test_get_file_tree(
        self, temp_workspace: Path, sample_instance: SWEBenchInstance
    ) -> None:
        """Test getting file tree."""
        manager = RepositoryManager(str(temp_workspace))
        await manager.setup_repo(sample_instance)

        files = await manager.get_file_tree()
        assert len(files) > 0
        assert "README" in files

    @pytest.mark.asyncio
    async def test_write_file(
        self, temp_workspace: Path, sample_instance: SWEBenchInstance
    ) -> None:
        """Test writing a file."""
        manager = RepositoryManager(str(temp_workspace))
        await manager.setup_repo(sample_instance)

        success = await manager.write_file("test.txt", "Hello")
        assert success

        content = await manager.read_file("test.txt")
        assert content == "Hello"

    @pytest.mark.asyncio
    async def test_get_diff(
        self, temp_workspace: Path, sample_instance: SWEBenchInstance
    ) -> None:
        """Test getting diff after changes."""
        manager = RepositoryManager(str(temp_workspace))
        await manager.setup_repo(sample_instance)

        # Make a change
        await manager.write_file("README", "Modified content")

        diff = await manager.get_diff()
        assert "Modified content" in diff or "README" in diff

    @pytest.mark.asyncio
    async def test_reset_repo(
        self, temp_workspace: Path, sample_instance: SWEBenchInstance
    ) -> None:
        """Test resetting repository."""
        manager = RepositoryManager(str(temp_workspace))
        await manager.setup_repo(sample_instance)

        # Make changes
        await manager.write_file("test.txt", "New file")

        # Reset
        await manager.reset_repo()

        # Check changes are gone
        content = await manager.read_file("test.txt")
        assert content is None

    @pytest.mark.asyncio
    async def test_apply_patch(
        self, temp_workspace: Path, sample_instance: SWEBenchInstance
    ) -> None:
        """Test applying a patch."""
        manager = RepositoryManager(str(temp_workspace))
        await manager.setup_repo(sample_instance)

        # Get original content
        original = await manager.read_file("README")
        assert original is not None

        # Create a simple patch (this is a simplified test)
        success, error = await manager.apply_patch("")
        assert not success  # Empty patch should fail
        assert "Empty patch" in error or error
