"""Manage the eliza benchmark server as a subprocess."""

from __future__ import annotations

import atexit
import logging
import os
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from eliza_adapter.client import ElizaClient

logger = logging.getLogger(__name__)


def _find_repo_root() -> Path:
    """Walk up from this file to find the elizaOS repo root.

    The repo root is the directory containing `packages/app-core/src/benchmark/server.ts`.
    Older layouts used `packages/eliza/`; both are checked.
    """
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "packages" / "app-core" / "src" / "benchmark" / "server.ts").exists():
            return parent
        if (parent / "packages" / "eliza" / "src" / "benchmark" / "server.ts").exists():
            return parent
    raise FileNotFoundError(
        "Could not locate repository root "
        "(expected packages/app-core/src/benchmark/server.ts or packages/eliza/src/benchmark/server.ts)"
    )


def _is_port_available(port: int) -> bool:
    """Return True when *port* can be bound on loopback."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _find_free_port() -> int:
    """Ask the OS for an available loopback TCP port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


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
        env_port = os.environ.get("ELIZA_BENCH_PORT", "").strip()
        if env_port:
            try:
                parsed_port = int(env_port)
                if 1 <= parsed_port <= 65535:
                    port = parsed_port
            except ValueError:
                logger.warning("Ignoring invalid ELIZA_BENCH_PORT=%r", env_port)
        if not os.environ.get("ELIZA_BENCH_URL") and not _is_port_available(port):
            replacement = _find_free_port()
            logger.warning(
                "Eliza benchmark port %d is already in use; using %d for this subprocess",
                port,
                replacement,
            )
            port = replacement
        self.port = port
        self.timeout = timeout
        self.repo_root = repo_root or _find_repo_root()
        self.host = os.environ.get("ELIZA_BENCH_HOST", "127.0.0.1").strip() or "127.0.0.1"
        client_host = "127.0.0.1" if self.host in {"0.0.0.0", "::"} else self.host
        self._proc: subprocess.Popen[str] | None = None
        self._stdout_log: Path | None = None
        self._stderr_log: Path | None = None
        self._stdout_handle = None
        self._stderr_handle = None
        existing_token = os.environ.get("ELIZA_BENCH_TOKEN", "").strip()
        self._token = existing_token or secrets.token_hex(32)
        self._client = ElizaClient(f"http://{client_host}:{port}", token=self._token)
        atexit.register(self.stop)

    @property
    def token(self) -> str:
        """Bearer token used to authenticate against the benchmark server."""
        return self._token

    @property
    def client(self) -> ElizaClient:
        return self._client

    # ------------------------------------------------------------------

    def start(self) -> None:
        """Spawn the benchmark server and block until it reports ready."""
        if self._proc is not None and self._proc.poll() is None:
            logger.info("Eliza benchmark server already running (pid=%d)", self._proc.pid)
            return

        candidates = [
            (
                self.repo_root / "packages" / "app-core" / "src" / "benchmark" / "server.ts",
                self.repo_root / "packages" / "app-core",
            ),
            (
                self.repo_root / "packages" / "eliza" / "src" / "benchmark" / "server.ts",
                self.repo_root / "packages" / "eliza",
            ),
        ]
        server_script: Path | None = None
        cwd: Path | None = None
        for script, script_cwd in candidates:
            if script.exists():
                server_script = script
                cwd = script_cwd
                break

        if server_script is None or cwd is None:
            tried = "\n  ".join(str(s) for s, _ in candidates)
            raise FileNotFoundError(
                f"Benchmark server script not found. Tried:\n  {tried}"
            )

        env = {
            **os.environ,
            "ELIZA_BENCH_HOST": self.host,
            "ELIZA_BENCH_PORT": str(self.port),
            "ELIZA_BENCH_TOKEN": self._token,
        }
        if env.get("ELIZA_BENCH_MOCK") == "true":
            for key in (
                "GROQ_API_KEY",
                "OPENAI_API_KEY",
                "OPENROUTER_API_KEY",
                "ANTHROPIC_API_KEY",
                "GOOGLE_GENERATIVE_AI_API_KEY",
                "TWITTER_BEARER_TOKEN",
                "TWITTER_CONSUMER_KEY",
                "TWITTER_CONSUMER_SECRET",
                "TWITTER_API_KEY",
                "TWITTER_API_SECRET_KEY",
                "TWITTER_CLIENT_ID",
                "TWITTER_CLIENT_SECRET",
                "TWITTER_OAUTH_ACCESS_TOKEN",
                "TWITTER_OAUTH_REFRESH_TOKEN",
                "TWITTER_OAUTH_RERESH_TOKEN",
            ):
                env[key] = ""
        os.environ.setdefault("ELIZA_BENCH_HOST", self.host)
        os.environ.setdefault("ELIZA_BENCH_URL", self._client.base_url)
        os.environ.setdefault("ELIZA_BENCH_TOKEN", self._token)

        logger.info(
            "Starting eliza benchmark server on %s:%d from %s ...",
            self.host,
            self.port,
            cwd,
        )

        # Clear stale tsx transformer caches. node --import tsx caches
        # transformed TypeScript by source-file content hash + version. When
        # core source files get renamed/restructured between runs (e.g.
        # `consolidatedReflectionAction` rename, evaluator removal), the cache
        # holds onto the old AST and the next boot fails with cryptic
        # `does not provide an export named X` errors. Purging on every start
        # is cheap (the cache rebuilds within seconds) and removes a tarpit.
        try:
            tmp_root = Path(tempfile.gettempdir())
            for entry in tmp_root.iterdir():
                if entry.name.startswith("tsx-") and entry.is_dir():
                    shutil.rmtree(entry, ignore_errors=True)
        except Exception as exc:  # never block server boot on cache cleanup
            logger.debug("tsx cache cleanup skipped: %s", exc)

        log_dir = Path(env.get("ELIZA_BENCH_LOG_DIR") or tempfile.gettempdir())
        log_dir.mkdir(parents=True, exist_ok=True)
        stdout_file = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            prefix=f"eliza-bench-server-{self.port}-",
            suffix=".stdout.log",
            dir=str(log_dir),
            delete=False,
        )
        stderr_file = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            prefix=f"eliza-bench-server-{self.port}-",
            suffix=".stderr.log",
            dir=str(log_dir),
            delete=False,
        )
        self._stdout_handle = stdout_file
        self._stderr_handle = stderr_file
        self._stdout_log = Path(stdout_file.name)
        self._stderr_log = Path(stderr_file.name)

        self._proc = subprocess.Popen(
            ["node", "--import", "tsx", str(server_script)],
            cwd=str(cwd),
            env=env,
            stdout=stdout_file,
            stderr=stderr_file,
            text=True,
            start_new_session=True,
        )

        # Wait for the ready sentinel or health check. Poll the child process
        # too; otherwise an early TypeScript/runtime crash leaves callers
        # waiting for the whole health timeout with no useful error.
        print("DEBUG: Waiting for server to be ready...", flush=True)
        deadline = time.monotonic() + self.timeout
        last_err = "server not ready"
        while time.monotonic() < deadline:
            return_code = self._proc.poll()
            if return_code is not None:
                print(f"DEBUG: Server exited before readiness (code={return_code})!", flush=True)
                self.dump_logs()
                self._proc = None
                raise RuntimeError(f"Eliza benchmark server exited before readiness (code={return_code})")
            try:
                if self._client.is_ready():
                    health = self._client.health()
                    if health.get("status") == "ready":
                        print("DEBUG: Server is ready!", flush=True)
                        return
                    last_err = f"Server health status not ready: {health}"
                else:
                    last_err = "Socket connection refused or timed out"
            except Exception as exc:
                last_err = str(exc)
            time.sleep(1.0)

        print("DEBUG: Timed out waiting for server!", flush=True)
        self.stop()
        raise TimeoutError(f"Eliza benchmark server not ready after {self.timeout}s: {last_err}")

    def dump_logs(self):
        for handle in (self._stdout_handle, self._stderr_handle):
            if handle:
                handle.flush()
                handle.close()
        self._stdout_handle = None
        self._stderr_handle = None

        for label, path in (("STDOUT", self._stdout_log), ("STDERR", self._stderr_log)):
            if not path or not path.exists():
                continue
            print(f"--- Server {label} ({path}) ---")
            text = path.read_text(encoding="utf-8", errors="replace")
            if len(text) > 20000:
                text = text[-20000:]
            print(text)

    def stop(self) -> None:
        """Stop the benchmark server subprocess."""
        if self._proc is None:
            return

        pid = self._proc.pid
        if self._proc.poll() is not None:
            logger.debug("Server process already exited (pid=%d)", pid)
        else:
            logger.info("Stopping eliza benchmark server (pid=%d) ...", pid)
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except Exception:
                self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                logger.warning("Server did not exit gracefully, killing...")
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except Exception:
                    self._proc.kill()
                self._proc.wait()
        
        self.dump_logs()
        self._proc = None

    def is_running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None
