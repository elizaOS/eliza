"""Manage the milaidy benchmark server as a subprocess."""

from __future__ import annotations

import atexit
import logging
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from milaidy_adapter.client import MilaidyClient

logger = logging.getLogger(__name__)


def _find_repo_root() -> Path:
    """Walk up from this file to find the repository root (contains packages/)."""
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "packages" / "milaidy" / "package.json").exists():
            return parent
    raise FileNotFoundError(
        "Could not locate repository root (expected packages/milaidy/package.json)"
    )


class MilaidyServerManager:
    """Start and stop the milaidy benchmark server subprocess.

    Usage::

        mgr = MilaidyServerManager()
        mgr.start()          # spawns node process, waits until healthy
        client = mgr.client  # ready-to-use MilaidyClient
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
        self._client = MilaidyClient(f"http://localhost:{port}")
        atexit.register(self.stop)

    @property
    def client(self) -> MilaidyClient:
        return self._client

    # ------------------------------------------------------------------

    def start(self) -> None:
        """Spawn the benchmark server and block until it reports ready."""
        if self._proc is not None and self._proc.poll() is None:
            logger.info("Milaidy benchmark server already running (pid=%d)", self._proc.pid)
            return

        server_script = (
            self.repo_root / "packages" / "milaidy" / "src" / "benchmark" / "server.ts"
        )
        if not server_script.exists():
            raise FileNotFoundError(f"Server script not found: {server_script}")

        env = {**os.environ, "MILAIDY_BENCH_PORT": str(self.port)}

        logger.info("Starting milaidy benchmark server on port %d ...", self.port)
        self._proc = subprocess.Popen(
            ["node", "--import", "tsx", str(server_script)],
            cwd=str(self.repo_root / "packages" / "milaidy"),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        # Wait for the ready sentinel or health check
        try:
            self._client.wait_until_ready(timeout=self.timeout)
        except TimeoutError:
            # Dump stderr for debugging
            if self._proc.stderr:
                stderr_text = ""
                try:
                    self._proc.stderr.close()
                except Exception:
                    pass
                logger.error("Server stderr: %s", stderr_text)
            self.stop()
            raise

        logger.info(
            "Milaidy benchmark server ready (pid=%d, port=%d)",
            self._proc.pid,
            self.port,
        )

    def stop(self) -> None:
        """Stop the benchmark server subprocess."""
        if self._proc is None:
            return

        pid = self._proc.pid
        if self._proc.poll() is not None:
            logger.debug("Server process already exited (pid=%d)", pid)
            self._proc = None
            return

        logger.info("Stopping milaidy benchmark server (pid=%d) ...", pid)
        try:
            self._proc.send_signal(signal.SIGTERM)
            self._proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            logger.warning("Server did not exit, sending SIGKILL (pid=%d)", pid)
            self._proc.kill()
            self._proc.wait(timeout=5)
        except Exception as exc:
            logger.warning("Error stopping server: %s", exc)
        finally:
            self._proc = None

    def is_running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None
