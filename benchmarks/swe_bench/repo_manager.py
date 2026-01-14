"""Repository manager for SWE-bench evaluation."""

from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
from pathlib import Path
from typing import Sequence

from .types import CodeLocation, SWEBenchInstance

logger = logging.getLogger(__name__)


class RepositoryManager:
    """Manage git repositories for SWE-bench evaluation."""

    def __init__(self, workspace_dir: str):
        self.workspace_dir = Path(workspace_dir)
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        self.current_repo: Path | None = None
        self.current_instance: SWEBenchInstance | None = None
        self._current_repo_resolved: Path | None = None

    def _resolve_repo_path(self, file_path: str) -> Path | None:
        """Resolve a repository-relative path safely.

        Prevents path traversal outside the current repository root.
        """
        if self.current_repo is None:
            return None

        repo_root = self._current_repo_resolved or self.current_repo.resolve()
        self._current_repo_resolved = repo_root

        # Normalize to a repository-relative path.
        # If the user passes an absolute path, treat it as invalid.
        rel = Path(file_path)
        if rel.is_absolute():
            return None

        candidate = (repo_root / rel).resolve()
        if candidate == repo_root or candidate.is_relative_to(repo_root):
            return candidate
        return None

    async def setup_repo(self, instance: SWEBenchInstance) -> Path:
        """Clone repository and checkout to base commit."""
        repo_dir = self.workspace_dir / instance.instance_id.replace("/", "_")

        # Clean up existing directory if it exists
        if repo_dir.exists():
            logger.info(f"Cleaning up existing directory: {repo_dir}")
            shutil.rmtree(repo_dir)

        # Clone the repository (use longer timeout for git operations)
        clone_url = f"https://github.com/{instance.repo}.git"
        logger.info(f"Cloning {clone_url} to {repo_dir}...")

        try:
            await self._run_command(
                ["git", "clone", "--depth", "1000", clone_url, str(repo_dir)],
                timeout=300.0,  # 5 minute timeout for clone
            )
        except subprocess.CalledProcessError:
            # Try without depth limit if shallow clone fails
            logger.warning("Shallow clone failed, trying full clone...")
            await self._run_command(
                ["git", "clone", clone_url, str(repo_dir)],
                timeout=600.0,  # 10 minute timeout for full clone
            )

        # Fetch the specific commit if needed
        try:
            await self._run_command(
                ["git", "fetch", "origin", instance.base_commit],
                cwd=repo_dir,
                timeout=120.0,  # 2 minute timeout for fetch
            )
        except subprocess.CalledProcessError:
            # Commit might already be available
            pass

        # Checkout to base commit
        await self._run_command(
            ["git", "checkout", instance.base_commit],
            cwd=repo_dir,
            timeout=60.0,  # 1 minute timeout for checkout
        )

        self.current_repo = repo_dir
        self._current_repo_resolved = repo_dir.resolve()
        self.current_instance = instance
        logger.info(f"Repository ready at {repo_dir}")
        return repo_dir

    async def apply_patch(self, patch: str) -> tuple[bool, str]:
        """Apply a patch to the current repository.

        Returns:
            Tuple of (success, error_message)
        """
        if not self.current_repo:
            return False, "No repository set up"

        if not patch.strip():
            return False, "Empty patch"

        # First check if patch can be applied
        try:
            result = await self._run_command(
                ["git", "apply", "--check", "-"],
                cwd=self.current_repo,
                input_data=patch,
                check=False,
            )
            if result.returncode != 0:
                return False, f"Patch check failed: {result.stderr}"
        except Exception as e:
            return False, f"Patch check error: {str(e)}"

        # Apply the patch
        try:
            result = await self._run_command(
                ["git", "apply", "-"],
                cwd=self.current_repo,
                input_data=patch,
            )
            return True, ""
        except subprocess.CalledProcessError as e:
            return False, f"Failed to apply patch: {e.stderr}"

    async def get_diff(self) -> str:
        """Get the current diff in the repository."""
        if not self.current_repo:
            return ""

        result = await self._run_command(
            ["git", "diff"],
            cwd=self.current_repo,
        )
        return result.stdout

    async def reset_repo(self) -> None:
        """Reset the repository to the base commit."""
        if not self.current_repo or not self.current_instance:
            return

        await self._run_command(
            ["git", "checkout", "."],
            cwd=self.current_repo,
        )
        await self._run_command(
            ["git", "clean", "-fd"],
            cwd=self.current_repo,
        )

    async def read_file(self, file_path: str) -> str | None:
        """Read a file from the repository."""
        full_path = self._resolve_repo_path(file_path)
        if full_path is None:
            return None

        if not full_path.exists() or not full_path.is_file():
            return None

        try:
            return full_path.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            logger.error(f"Error reading file {file_path}: {e}")
            return None

    async def write_file(self, file_path: str, content: str) -> bool:
        """Write content to a file in the repository."""
        full_path = self._resolve_repo_path(file_path)
        if full_path is None:
            logger.error(f"Refusing to write outside repo: {file_path}")
            return False

        try:
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text(content, encoding="utf-8")
            return True
        except Exception as e:
            logger.error(f"Error writing file {file_path}: {e}")
            return False

    async def search_code(
        self,
        query: str,
        file_pattern: str = "*.py",
        max_results: int = 50,
    ) -> list[CodeLocation]:
        """Search for code patterns in the repository.

        Uses grep for reliable cross-platform search.
        """
        if not self.current_repo:
            return []

        results: list[CodeLocation] = []

        try:
            # Use grep directly for reliable search (ripgrep can hang on some repos)
            result = await self._run_command(
                ["grep", "-rn", f"--include={file_pattern}", query, "."],
                cwd=self.current_repo,
                check=False,
                timeout=30.0,
            )

            if result.returncode == 0:
                for line in result.stdout.split("\n"):
                    if ":" in line:
                        # Format: ./path/file.py:line:content
                        parts = line.split(":", 2)
                        if len(parts) >= 3:
                            # Safely parse line number
                            try:
                                line_num = int(parts[1])
                            except ValueError:
                                continue  # Skip lines with invalid line numbers

                            # Remove leading ./ from path
                            file_path = parts[0]
                            if file_path.startswith("./"):
                                file_path = file_path[2:]

                            results.append(
                                CodeLocation(
                                    file_path=file_path,
                                    start_line=line_num,
                                    end_line=line_num,
                                    content=parts[2],
                                )
                            )
                            if len(results) >= max_results:
                                break

        except subprocess.TimeoutExpired:
            logger.warning(f"Search timed out for query: {query}")
        except Exception as e:
            logger.error(f"Error searching code: {e}")

        return results

    async def get_file_tree(self, max_depth: int = 3) -> list[str]:
        """Get directory structure of repository."""
        if not self.current_repo:
            return []

        files: list[str] = []
        try:
            for path in self.current_repo.rglob("*"):
                if path.is_file() and ".git" not in str(path):
                    rel_path = path.relative_to(self.current_repo)
                    if len(rel_path.parts) <= max_depth:
                        files.append(str(rel_path))
        except Exception as e:
            logger.error(f"Error getting file tree: {e}")

        return sorted(files)

    async def get_python_files(self) -> list[str]:
        """Get all Python files in the repository."""
        if not self.current_repo:
            return []

        python_files: list[str] = []
        try:
            for path in self.current_repo.rglob("*.py"):
                if ".git" not in str(path):
                    rel_path = path.relative_to(self.current_repo)
                    python_files.append(str(rel_path))
        except Exception as e:
            logger.error(f"Error getting Python files: {e}")

        return sorted(python_files)

    async def get_file_context(
        self,
        file_path: str,
        line_number: int,
        context_lines: int = 10,
    ) -> str:
        """Get file content around a specific line."""
        content = await self.read_file(file_path)
        if content is None:
            return ""

        lines = content.split("\n")
        start = max(0, line_number - context_lines - 1)
        end = min(len(lines), line_number + context_lines)

        result_lines = []
        for i in range(start, end):
            marker = ">>>" if i == line_number - 1 else "   "
            result_lines.append(f"{marker} {i + 1:4d} | {lines[i]}")

        return "\n".join(result_lines)

    async def _run_command(
        self,
        cmd: Sequence[str],
        cwd: Path | None = None,
        input_data: str | None = None,
        check: bool = True,
        timeout: float = 30.0,
    ) -> subprocess.CompletedProcess[str]:
        """Run a shell command asynchronously with timeout."""
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdin=asyncio.subprocess.PIPE if input_data else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(input=input_data.encode() if input_data else None),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise subprocess.TimeoutExpired(cmd, timeout)

        result = subprocess.CompletedProcess(
            args=cmd,
            returncode=process.returncode or 0,
            stdout=stdout_bytes.decode("utf-8", errors="replace"),
            stderr=stderr_bytes.decode("utf-8", errors="replace"),
        )

        if check and result.returncode != 0:
            raise subprocess.CalledProcessError(
                result.returncode,
                cmd,
                output=result.stdout,
                stderr=result.stderr,
            )

        return result

    def cleanup(self) -> None:
        """Clean up the workspace."""
        if self.workspace_dir.exists():
            shutil.rmtree(self.workspace_dir)
