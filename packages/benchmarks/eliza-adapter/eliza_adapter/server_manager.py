"""Manage the eliza benchmark server as a subprocess."""

from __future__ import annotations

import atexit
import logging
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from eliza_adapter.client import ElizaClient

logger = logging.getLogger(__name__)


def _find_repo_root() -> Path:
    """Walk up from this file to find the repository root (contains packages/)."""
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "packages" / "eliza" / "package.json").exists():
            return parent
    raise FileNotFoundError(
        "Could not locate repository root (expected packages/eliza/package.json)"
    )


class ElizaServerManager:
    """Start and stop the eliza benchmark server subprocess.

    Usage::

        mgr = ElizaServerManager()
        mgr.start()          # spawns node process, waits until healthy
        client = mgr.client  # ready-to-use ElizaClient
        # ... run benchmarks ...
        mgr.stop()           # kills the subprocess
    """

    def __init__(
        self,
        port: int = 3939,
        timeout: float = 120.0,
        repo_root: Path | None = None,
    ) -> None:
        self.port = port
        self.timeout = timeout
        self.repo_root = repo_root or _find_repo_root()
        self._proc: subprocess.Popen[str] | None = None
        self._client = ElizaClient(f"http://localhost:{port}")
        atexit.register(self.stop)

    @property
    def client(self) -> ElizaClient:
        return self._client

    # ------------------------------------------------------------------

    def start(self) -> None:
        """Spawn the benchmark server and block until it reports ready."""
        if self._proc is not None and self._proc.poll() is None:
            logger.info("Eliza benchmark server already running (pid=%d)", self._proc.pid)
            return

        # Try standard monorepo location first
        server_script = (
            self.repo_root / "packages" / "eliza" / "src" / "benchmark" / "server.ts"
        )
        cwd = self.repo_root / "packages" / "eliza"
        
        # Fallback to repo root if eliza is top-level (e.g. current workspace structure)
        if not server_script.exists():
            server_script = (
                self.repo_root / "eliza" / "src" / "benchmark" / "server.ts"
            )
            cwd = self.repo_root / "eliza"

        if not server_script.exists():
            # Fallback for internal testing where repo_root might point differently
             server_script = (
                self.repo_root / "src" / "benchmark" / "server.ts"
            )
             cwd = self.repo_root

        if not server_script.exists():
            raise FileNotFoundError(f"Server script not found: {server_script} (checked packages/eliza, eliza, and root)")

        env = {**os.environ, "ELIZA_BENCH_PORT": str(self.port)}

        logger.info("Starting eliza benchmark server on port %d from %s ...", self.port, cwd)
        self._proc = subprocess.Popen(
            ["node", "--import", "tsx", str(server_script)],
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        # Wait for the ready sentinel or health check
        print("DEBUG: Waiting for server to be ready...", flush=True)
        try:
            self._client.wait_until_ready(timeout=self.timeout)
            print("DEBUG: Server is ready!", flush=True)
        except TimeoutError:
            print("DEBUG: Timed out waiting for server!", flush=True)
            # Dump stderr for debugging
            self.stop()
            raise

    def dump_logs(self):
        if self._proc:
             if self._proc.stdout:
                 print("--- Server STDOUT ---")
                 print(self._proc.stdout.read())
             if self._proc.stderr:
                 print("--- Server STDERR ---")
                 print(self._proc.stderr.read())

    def stop(self) -> None:
        """Stop the benchmark server subprocess."""
        if self._proc is None:
            return

        pid = self._proc.pid
        if self._proc.poll() is not None:
             logger.debug("Server process already exited (pid=%d)", pid)
        else:
             logger.info("Stopping eliza benchmark server (pid=%d) ...", pid)
             self._proc.terminate()
             try:
                 self._proc.wait(timeout=5)
             except subprocess.TimeoutExpired:
                 logger.warning("Server did not exit gracefully, killing...")
                 self._proc.kill()
                 self._proc.wait()
        
        self.dump_logs()
        self._proc = None

    def is_running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None
