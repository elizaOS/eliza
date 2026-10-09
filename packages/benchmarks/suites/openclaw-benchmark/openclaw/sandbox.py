"""
Sandbox executor for OpenClaw benchmark.

Provides isolated execution environments for running generated code safely.
Supports Docker isolation (preferred) or direct execution with timeouts.
"""

import json
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class ExecutionResult:
    """Result of executing code in the sandbox."""
    success: bool
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: float
    files_created: list[str] = field(default_factory=list)
    error: Optional[str] = None


@dataclass
class SandboxConfig:
    """Configuration for the sandbox executor."""
    use_docker: bool = False
    docker_image: str = "node:20-slim"
    timeout: int = 60  # seconds
    max_output_size: int = 100_000  # bytes
    allowed_commands: list[str] = field(default_factory=lambda: [
        "npm", "npx", "node", "git", "mkdir", "touch", "cat", "echo",
        "python3", "pip", "pytest", "tsc", "jest", "vitest"
    ])


class SandboxExecutor:
    """Execute code in an isolated environment."""

    def __init__(self, config: Optional[SandboxConfig] = None):
        self.config = config or SandboxConfig()
        self.workspace: Optional[Path] = None
        self._commands_executed: list[dict] = []
        self._files_created: dict[str, str] = {}

    def __enter__(self):
        """Create a temporary workspace."""
        self.workspace = Path(tempfile.mkdtemp(prefix="openclaw_"))
        self._commands_executed = []
        self._files_created = {}
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Clean up the workspace."""
        if self.workspace and self.workspace.exists():
            shutil.rmtree(self.workspace, ignore_errors=True)
        self.workspace = None

    def get_workspace(self) -> Path:
        """Get the current workspace path."""
        if not self.workspace:
            raise RuntimeError("Sandbox not initialized. Use 'with SandboxExecutor() as sandbox:'")
        return self.workspace

    def execute(self, command: str, timeout: Optional[int] = None) -> ExecutionResult:
        """Execute a command in the sandbox."""
        if not self.workspace:
            raise RuntimeError("Sandbox not initialized")

        timeout = timeout or self.config.timeout
        start_time = time.time()

        # Track the command
        cmd_entry = {
            "command": command,
            "timestamp": start_time,
            "workspace": str(self.workspace),
        }

        try:
            if self.config.use_docker:
                result = self._execute_docker(command, timeout)
            else:
                result = self._execute_direct(command, timeout)

            cmd_entry["exit_code"] = result.exit_code
            cmd_entry["success"] = result.success
            cmd_entry["duration_ms"] = result.duration_ms

        except Exception as e:
            result = ExecutionResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=str(e),
                duration_ms=(time.time() - start_time) * 1000,
                error=str(e),
            )
            cmd_entry["error"] = str(e)

        self._commands_executed.append(cmd_entry)

        # Track files created
        result.files_created = self._scan_new_files()

        return result

    def _execute_direct(self, command: str, timeout: int) -> ExecutionResult:
        """Execute command directly with subprocess.

        SECURITY: Only minimal environment variables are passed to prevent
        leaking API keys, credentials, or other secrets to executed code.
        """
        start_time = time.time()

        # Only pass minimal required environment variables
        # DO NOT pass **os.environ - that leaks secrets!
        safe_env = {
            # Required for basic operation
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": str(self.workspace),
            "USER": "sandbox",
            "SHELL": "/bin/sh",
            "TERM": "xterm",
            # Node.js specific
            "NODE_ENV": "test",
            "npm_config_cache": str(self.workspace / ".npm"),
            # Disable telemetry/analytics
            "DO_NOT_TRACK": "1",
            "DISABLE_OPENCOLLECTIVE": "true",
            "ADBLOCK": "true",
        }

        try:
            proc = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                timeout=timeout,
                cwd=self.workspace,
                env=safe_env,
            )

            stdout = proc.stdout.decode("utf-8", errors="replace")
            stderr = proc.stderr.decode("utf-8", errors="replace")

            # Truncate if too large
            if len(stdout) > self.config.max_output_size:
                stdout = stdout[:self.config.max_output_size] + "\n... (truncated)"
            if len(stderr) > self.config.max_output_size:
                stderr = stderr[:self.config.max_output_size] + "\n... (truncated)"

            return ExecutionResult(
                success=proc.returncode == 0,
                exit_code=proc.returncode,
                stdout=stdout,
                stderr=stderr,
                duration_ms=(time.time() - start_time) * 1000,
            )

        except subprocess.TimeoutExpired:
            return ExecutionResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=f"Command timed out after {timeout}s",
                duration_ms=timeout * 1000,
                error="timeout",
            )

    def _execute_docker(self, command: str, timeout: int) -> ExecutionResult:
        """Execute command in Docker container."""
        start_time = time.time()

        docker_cmd = [
            "docker", "run",
            "--rm",
            "--network=none",  # No network access
            f"--memory=512m",  # Memory limit
            f"--cpus=1",  # CPU limit
            f"-v", f"{self.workspace}:/workspace",
            "-w", "/workspace",
            self.config.docker_image,
            "sh", "-c", command,
        ]

        try:
            proc = subprocess.run(
                docker_cmd,
                capture_output=True,
                timeout=timeout,
            )

            stdout = proc.stdout.decode("utf-8", errors="replace")
            stderr = proc.stderr.decode("utf-8", errors="replace")

            return ExecutionResult(
                success=proc.returncode == 0,
                exit_code=proc.returncode,
                stdout=stdout,
                stderr=stderr,
                duration_ms=(time.time() - start_time) * 1000,
            )

        except subprocess.TimeoutExpired:
            # Kill the container
            subprocess.run(["docker", "kill", f"openclaw_{os.getpid()}"], capture_output=True)
            return ExecutionResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=f"Docker command timed out after {timeout}s",
                duration_ms=timeout * 1000,
                error="timeout",
            )

    def _scan_new_files(self) -> list[str]:
        """Scan for files created in the workspace."""
        if not self.workspace:
            return []

        files = []
        for f in self.workspace.rglob("*"):
            if f.is_file():
                rel_path = str(f.relative_to(self.workspace))
                if rel_path not in self._files_created:
                    self._files_created[rel_path] = f.read_text(errors="replace")[:1000]
                files.append(rel_path)
        return files

    def write_file(self, path: str, content: str) -> bool:
        """Write a file to the workspace."""
        if not self.workspace:
            raise RuntimeError("Sandbox not initialized")

        full_path = self.workspace / path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content)
        self._files_created[path] = content[:1000]
        return True

    def read_file(self, path: str) -> Optional[str]:
        """Read a file from the workspace."""
        if not self.workspace:
            return None

        full_path = self.workspace / path
        if full_path.exists():
            return full_path.read_text()
        return None

    def file_exists(self, path: str) -> bool:
        """Check if a file exists in the workspace."""
        if not self.workspace:
            return False
        return (self.workspace / path).exists()

    def list_files(self) -> list[str]:
        """List all files in the workspace."""
        if not self.workspace:
            return []
        return [
            str(f.relative_to(self.workspace))
            for f in self.workspace.rglob("*")
            if f.is_file()
        ]

    def get_executed_commands(self) -> list[dict]:
        """Get list of all commands executed."""
        return self._commands_executed.copy()

    def get_files_created(self) -> dict[str, str]:
        """Get dict of files created with content preview."""
        return self._files_created.copy()

    def get_result_data(self) -> dict:
        """Get result data for scoring."""
        return {
            "executed_commands": self._commands_executed,
            "files_created": self._files_created,
            "workspace": str(self.workspace) if self.workspace else None,
        }


def run_in_sandbox(
    commands: list[str],
    files: Optional[dict[str, str]] = None,
    config: Optional[SandboxConfig] = None,
) -> dict:
    """
    Convenience function to run commands in a sandbox and return results.

    Args:
        commands: List of commands to execute
        files: Optional dict of {path: content} files to create first
        config: Optional sandbox configuration

    Returns:
        Dict with execution results and file state
    """
    with SandboxExecutor(config) as sandbox:
        # Write initial files
        if files:
            for path, content in files.items():
                sandbox.write_file(path, content)

        # Execute commands
        results = []
        for cmd in commands:
            result = sandbox.execute(cmd)
            results.append({
                "command": cmd,
                "success": result.success,
                "exit_code": result.exit_code,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "duration_ms": result.duration_ms,
            })

            # Stop on failure if critical
            if not result.success and cmd.startswith("npm install"):
                break

        return {
            "results": results,
            "files": sandbox.list_files(),
            "commands": sandbox.get_executed_commands(),
            "files_created": sandbox.get_files_created(),
        }
