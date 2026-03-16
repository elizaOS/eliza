"""Lobster service for subprocess execution."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any

from elizaos_plugin_lobster.types import (
    LobsterApprovalRequest,
    LobsterConfig,
    LobsterResult,
)

logger = logging.getLogger(__name__)


def resolve_executable_path(configured_path: str | None = None) -> str:
    """Resolve the lobster executable path."""
    if configured_path:
        # Security: ensure it's actually called "lobster"
        base = os.path.basename(configured_path)
        if base not in ("lobster", "lobster.exe"):
            raise ValueError(f"Invalid lobster path: {configured_path}")
        return configured_path

    # Try to find in PATH
    lobster = shutil.which("lobster")
    if lobster:
        return lobster

    return "lobster"


def normalize_cwd(cwd: str | None, allowed_base: str | None = None) -> str:
    """Normalize and validate working directory."""
    if not cwd:
        return os.getcwd()

    resolved = os.path.realpath(cwd)

    if allowed_base:
        allowed_resolved = os.path.realpath(allowed_base)
        if not resolved.startswith(allowed_resolved):
            raise ValueError(f"Working directory escapes sandbox: {cwd}")

    return resolved


class LobsterService:
    """Service for running Lobster pipelines."""

    def __init__(self, config: LobsterConfig | None = None) -> None:
        self._config = config or LobsterConfig()
        self._executable = resolve_executable_path(self._config.lobster_path)
        logger.info(f"Lobster service initialized with executable: {self._executable}")

    @property
    def timeout_seconds(self) -> float:
        """Get timeout in seconds."""
        return self._config.timeout_ms / 1000.0

    async def is_available(self) -> bool:
        """Check if lobster is available."""
        try:
            proc = await asyncio.create_subprocess_exec(
                self._executable,
                "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=5.0)
            return proc.returncode == 0
        except Exception as e:
            logger.debug(f"Lobster availability check failed: {e}")
            return False

    async def run(
        self,
        pipeline: str,
        args: dict[str, Any] | None = None,
        cwd: str | None = None,
    ) -> LobsterResult:
        """Run a Lobster pipeline."""
        try:
            working_dir = normalize_cwd(cwd)
        except ValueError as e:
            return LobsterResult(
                success=False,
                status="error",
                error=str(e),
            )

        cmd_args = [self._executable, "run", pipeline]
        if args:
            cmd_args.extend(["--args", json.dumps(args)])

        return await self._execute(cmd_args, working_dir)

    async def resume(
        self,
        token: str,
        approve: bool = True,
    ) -> LobsterResult:
        """Resume a paused Lobster pipeline."""
        action = "approve" if approve else "reject"
        cmd_args = [self._executable, "resume", token, "--action", action]

        return await self._execute(cmd_args, os.getcwd())

    async def _execute(
        self,
        cmd_args: list[str],
        cwd: str,
    ) -> LobsterResult:
        """Execute a lobster command and parse the result."""
        logger.info(f"Executing: {' '.join(cmd_args)} in {cwd}")

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd_args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
            )

            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    proc.communicate(),
                    timeout=self.timeout_seconds,
                )
            except TimeoutError:
                proc.kill()
                await proc.wait()
                return LobsterResult(
                    success=False,
                    status="error",
                    error="Lobster command timed out",
                )

            stdout = stdout_bytes.decode("utf-8", errors="replace")
            stderr = stderr_bytes.decode("utf-8", errors="replace")

            # Truncate if too large
            if len(stdout) > self._config.max_stdout_bytes:
                stdout = stdout[: self._config.max_stdout_bytes] + "\n... (truncated)"

            if proc.returncode != 0:
                return LobsterResult(
                    success=False,
                    status="error",
                    error=stderr or f"Lobster exited with code {proc.returncode}",
                )

            # Parse the JSON envelope from stdout
            return self._parse_envelope(stdout)

        except FileNotFoundError:
            return LobsterResult(
                success=False,
                status="error",
                error=f"Lobster executable not found: {self._executable}",
            )
        except Exception as e:
            return LobsterResult(
                success=False,
                status="error",
                error=str(e),
            )

    def _parse_envelope(self, stdout: str) -> LobsterResult:
        """Parse the JSON envelope from lobster output."""
        try:
            # Find the JSON envelope (should be the last line)
            lines = stdout.strip().split("\n")
            json_line = None

            for line in reversed(lines):
                line = line.strip()
                if line.startswith("{"):
                    json_line = line
                    break

            if not json_line:
                return LobsterResult(
                    success=False,
                    status="error",
                    error="No JSON envelope found in lobster output",
                )

            envelope = json.loads(json_line)
            status = envelope.get("status", "unknown")

            if status == "error":
                return LobsterResult(
                    success=False,
                    status="error",
                    error=envelope.get("error", "Unknown error"),
                )

            if status == "needs_approval":
                approval_data = envelope.get("approval", {})
                approval = LobsterApprovalRequest(
                    step_name=approval_data.get("step_name", ""),
                    description=approval_data.get("description", ""),
                    resume_token=approval_data.get("resume_token", ""),
                )
                return LobsterResult(
                    success=True,
                    status="needs_approval",
                    approval=approval,
                )

            if status == "success":
                return LobsterResult(
                    success=True,
                    status="success",
                    outputs=envelope.get("outputs"),
                )

            return LobsterResult(
                success=False,
                status="error",
                error=f"Unknown status: {status}",
            )

        except json.JSONDecodeError as e:
            return LobsterResult(
                success=False,
                status="error",
                error=f"Failed to parse lobster output: {e}",
            )
