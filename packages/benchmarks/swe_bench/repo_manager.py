"""Repository manager for SWE-bench evaluation."""

from __future__ import annotations

import asyncio
import logging
import os
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
        self.cache_dir = Path(
            os.environ.get("SWE_BENCH_REPO_CACHE_DIR", self.workspace_dir / ".repo-cache")
        )
        self.current_repo: Path | None = None
        self.current_instance: SWEBenchInstance | None = None
        self._current_repo_resolved: Path | None = None

    def _repo_cache_path(self, repo: str) -> Path:
        cache_name = repo.replace("/", "__").replace(":", "_")
        return self.cache_dir / f"{cache_name}.git"

    async def _ensure_repo_mirror(self, instance: SWEBenchInstance) -> Path | None:
        """Create or update a bare mirror for a GitHub repository.

        Multiple SWE-bench instances often come from the same repository but use
        different base commits. A mirror lets each per-instance workspace clone
        locally instead of paying a fresh network clone for every task.
        """
        if os.environ.get("SWE_BENCH_DISABLE_REPO_CACHE", "").lower() in {
            "1",
            "true",
            "yes",
        }:
            return None

        mirror_dir = self._repo_cache_path(instance.repo)
        clone_url = f"https://github.com/{instance.repo}.git"
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            if mirror_dir.exists() and (mirror_dir / "HEAD").exists():
                await self._run_command(
                    ["git", "fetch", "--prune", "origin"],
                    cwd=mirror_dir,
                    check=False,
                    timeout=180.0,
                )
                return mirror_dir

            if mirror_dir.exists():
                shutil.rmtree(mirror_dir)
            logger.info(f"Creating repository mirror cache: {mirror_dir}")
            await self._run_command(
                ["git", "clone", "--mirror", clone_url, str(mirror_dir)],
                timeout=600.0,
            )
            return mirror_dir
        except Exception as exc:
            logger.warning("Repository mirror cache unavailable: %s", exc)
            if mirror_dir.exists():
                shutil.rmtree(mirror_dir, ignore_errors=True)
            return None

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

        # Reuse an existing local clone when possible to avoid repeated network clones.
        if repo_dir.exists() and (repo_dir / ".git").exists():
            logger.info(f"Reusing existing repository: {repo_dir}")
            try:
                await self._run_command(
                    ["git", "fetch", "origin"],
                    cwd=repo_dir,
                    check=False,
                    timeout=120.0,
                )
                await self._run_command(
                    ["git", "checkout", instance.base_commit],
                    cwd=repo_dir,
                    timeout=60.0,
                )
                await self._run_command(
                    ["git", "reset", "--hard", instance.base_commit],
                    cwd=repo_dir,
                    timeout=60.0,
                )
                await self._run_command(
                    ["git", "clean", "-fd"],
                    cwd=repo_dir,
                    timeout=60.0,
                )
                self.current_repo = repo_dir
                self._current_repo_resolved = repo_dir.resolve()
                self.current_instance = instance
                logger.info(f"Repository ready at {repo_dir}")
                return repo_dir
            except subprocess.CalledProcessError:
                logger.warning(
                    "Failed to reuse existing clone, falling back to fresh clone"
                )
                shutil.rmtree(repo_dir)
        elif repo_dir.exists():
            logger.info(f"Cleaning up existing directory: {repo_dir}")
            shutil.rmtree(repo_dir)

        # Clone the repository (use longer timeout for git operations)
        clone_url = f"https://github.com/{instance.repo}.git"
        mirror_dir = await self._ensure_repo_mirror(instance)
        clone_source = str(mirror_dir) if mirror_dir is not None else clone_url
        logger.info(f"Cloning {clone_source} to {repo_dir}...")

        try:
            if mirror_dir is not None:
                await self._run_command(
                    ["git", "clone", "--shared", str(mirror_dir), str(repo_dir)],
                    timeout=180.0,
                )
            else:
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

        apply_args = ["git", "apply", "-"]

        # First check if patch can be applied. If normal context matching fails,
        # allow zero-context application as a fallback for model diffs whose
        # bare ``@@`` hunks were line-number repaired by the SWE runner.
        try:
            result = await self._run_command(
                ["git", "apply", "--check", "-"],
                cwd=self.current_repo,
                input_data=patch,
                check=False,
            )
            if result.returncode != 0:
                zero_context = await self._run_command(
                    ["git", "apply", "--check", "--unidiff-zero", "-"],
                    cwd=self.current_repo,
                    input_data=patch,
                    check=False,
                )
                if zero_context.returncode != 0:
                    return False, f"Patch check failed: {result.stderr}"
                apply_args = ["git", "apply", "--unidiff-zero", "-"]
        except Exception as e:
            return False, f"Patch check error: {str(e)}"

        # Apply the patch
        try:
            result = await self._run_command(
                apply_args,
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

        tracked_diff = await self._run_command(
            ["git", "diff"],
            cwd=self.current_repo,
        )
        combined_diff = tracked_diff.stdout

        # Include untracked files so newly created files appear in generated patches.
        status = await self._run_command(
            ["git", "status", "--porcelain"],
            cwd=self.current_repo,
            check=False,
        )
        untracked_files: list[str] = []
        for line in status.stdout.splitlines():
            if line.startswith("?? "):
                file_path = line[3:].strip()
                if file_path:
                    untracked_files.append(file_path)

        for file_path in untracked_files:
            file_diff = await self._run_command(
                ["git", "diff", "--no-index", "--", "/dev/null", file_path],
                cwd=self.current_repo,
                check=False,
            )
            if file_diff.stdout:
                combined_diff += file_diff.stdout

        return combined_diff

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

    def cleanup_current_repo(self) -> None:
        """Remove the active per-instance checkout while preserving shared caches."""
        if self.current_repo is None:
            return

        repo_path = self.current_repo
        try:
            resolved_workspace = self.workspace_dir.resolve()
            resolved_repo = repo_path.resolve()
        except OSError:
            resolved_workspace = self.workspace_dir
            resolved_repo = repo_path

        if resolved_repo == resolved_workspace or not resolved_repo.is_relative_to(
            resolved_workspace
        ):
            self.current_repo = None
            self.current_instance = None
            self._current_repo_resolved = None
            return

        shutil.rmtree(repo_path, ignore_errors=True)
        self.current_repo = None
        self.current_instance = None
        self._current_repo_resolved = None
