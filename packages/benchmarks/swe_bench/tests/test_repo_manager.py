"""Tests for repository manager."""

import asyncio
import subprocess
import tempfile
from pathlib import Path
from typing import Sequence

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
        assert manager.cache_dir == manager.workspace_dir / ".repo-cache"

    def test_repo_cache_path_is_repo_scoped(self, repo_manager: RepositoryManager) -> None:
        """Test repository mirror cache paths are stable per source repo."""
        assert (
            repo_manager._repo_cache_path("astropy/astropy").name
            == "astropy__astropy.git"
        )

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

    def test_get_diff_includes_untracked_files(self, temp_workspace: Path) -> None:
        """Test get_diff reports untracked file patches."""

        async def test() -> None:
            repo_dir = temp_workspace / "local_repo"
            repo_dir.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                ["git", "init"],
                cwd=repo_dir,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            manager = RepositoryManager(str(temp_workspace))
            manager.current_repo = repo_dir
            manager._current_repo_resolved = repo_dir.resolve()

            new_file = repo_dir / "new_file.txt"
            new_file.write_text("hello from untracked\n", encoding="utf-8")

            diff = await manager.get_diff()
            assert "diff --git a/new_file.txt b/new_file.txt" in diff
            assert "+hello from untracked" in diff

        asyncio.run(test())

    def test_cleanup_current_repo_removes_checkout_but_keeps_cache(
        self,
        temp_workspace: Path,
    ) -> None:
        """Test per-instance cleanup preserves the workspace cache directory."""
        manager = RepositoryManager(str(temp_workspace))
        repo_dir = temp_workspace / "instance_repo"
        repo_dir.mkdir()
        cache_dir = manager.cache_dir
        cache_dir.mkdir(parents=True)

        manager.current_repo = repo_dir
        manager._current_repo_resolved = repo_dir.resolve()
        manager.cleanup_current_repo()

        assert not repo_dir.exists()
        assert cache_dir.exists()
        assert manager.current_repo is None
        assert manager.current_instance is None

    def test_cleanup_current_repo_ignores_paths_outside_workspace(
        self,
        temp_workspace: Path,
    ) -> None:
        """Test cleanup does not delete monkeypatched or external repositories."""
        manager = RepositoryManager(str(temp_workspace / "workspace"))
        external_repo = temp_workspace / "external_repo"
        external_repo.mkdir()

        manager.current_repo = external_repo
        manager._current_repo_resolved = external_repo.resolve()
        manager.cleanup_current_repo()

        assert external_repo.exists()
        assert manager.current_repo is None

    def test_apply_patch_falls_back_to_unidiff_zero(
        self,
        temp_workspace: Path,
        repo_manager: RepositoryManager,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Test low-context model diffs can fall back to zero-context apply."""

        async def test() -> None:
            commands: list[list[str]] = []
            repo_manager.current_repo = temp_workspace

            async def fake_run_command(
                cmd: Sequence[str],
                **kwargs: object,
            ) -> subprocess.CompletedProcess[str]:
                command = list(cmd)
                commands.append(command)
                if command == ["git", "apply", "--check", "-"]:
                    return subprocess.CompletedProcess(
                        command,
                        returncode=1,
                        stdout="",
                        stderr="normal context failed",
                    )
                if command == ["git", "apply", "--check", "--unidiff-zero", "-"]:
                    return subprocess.CompletedProcess(
                        command,
                        returncode=0,
                        stdout="",
                        stderr="",
                    )
                if command == ["git", "apply", "--unidiff-zero", "-"]:
                    return subprocess.CompletedProcess(
                        command,
                        returncode=0,
                        stdout="",
                        stderr="",
                    )
                raise AssertionError(f"Unexpected command: {command}")

            monkeypatch.setattr(repo_manager, "_run_command", fake_run_command)

            success, error = await repo_manager.apply_patch(
                "diff --git a/module.py b/module.py\n"
                "--- a/module.py\n"
                "+++ b/module.py\n"
                "@@ -5,1 +5,1 @@\n"
                "-old\n"
                "+new\n"
            )

            assert success, error
            assert commands == [
                ["git", "apply", "--check", "-"],
                ["git", "apply", "--check", "--unidiff-zero", "-"],
                ["git", "apply", "--unidiff-zero", "-"],
            ]

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
