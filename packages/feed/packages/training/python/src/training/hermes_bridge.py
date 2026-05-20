from __future__ import annotations

import json
import logging
import subprocess
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class HermesBridgeError(RuntimeError):
    """Raised when the Hermes benchmark bridge returns an error."""


def default_workspace_root() -> Path:
    return Path(__file__).resolve().parents[6]


def default_bridge_script(hermes_root: Path) -> Path:
    workspace_root = default_workspace_root()
    candidates = (
        workspace_root / "babylon" / "scripts" / "scambench" / "hermes_benchmark_bridge.py",
        hermes_root / "scripts" / "benchmark_bridge.py",
    )
    return next((candidate for candidate in candidates if candidate.exists()), candidates[0])


def default_hermes_root() -> Path:
    workspace_root = default_workspace_root()
    candidates = (
        workspace_root / "external-sources" / "hermes-agent",
        workspace_root / "hermes-agent",
    )
    return next((candidate for candidate in candidates if candidate.exists()), candidates[0])


def default_hermes_python(hermes_root: Path) -> Path:
    candidates = (
        hermes_root / ".venv" / "bin" / "python",
        hermes_root / "venv" / "bin" / "python",
    )
    return next((candidate for candidate in candidates if candidate.exists()), candidates[0])


class HermesBridgeClient:
    def __init__(
        self,
        model: str,
        base_url: str,
        api_key: str = "benchmark-local",
        *,
        max_iterations: int = 4,
        hermes_root: str | Path | None = None,
        python_executable: str | Path | None = None,
        bridge_script: str | Path | None = None,
        skip_memory: bool = True,
        no_tools: bool = True,
        persistent: bool = False,
        rebuild_agent_per_request: bool = False,
        timeout_seconds: int = 120,
        max_retries: int = 2,
    ) -> None:
        self.hermes_root = Path(hermes_root or default_hermes_root()).resolve()
        self.python_executable = Path(
            python_executable or default_hermes_python(self.hermes_root)
        ).expanduser()
        self.bridge_script = Path(
            bridge_script or default_bridge_script(self.hermes_root)
        ).resolve()

        if not self.python_executable.exists():
            raise FileNotFoundError(f"Hermes Python executable not found: {self.python_executable}")
        if not self.bridge_script.exists():
            raise FileNotFoundError(f"Hermes bridge script not found: {self.bridge_script}")

        self.persistent = persistent
        self._command = [
            str(self.python_executable),
            str(self.bridge_script),
            "--model",
            model,
            "--base-url",
            base_url,
            "--api-key",
            api_key,
            "--max-iterations",
            str(max_iterations),
        ]
        if not skip_memory:
            self._command.append("--no-skip-memory")
        if not no_tools:
            self._command.append("--no-tools")
        if rebuild_agent_per_request:
            self._command.append("--rebuild-agent-per-request")
        self.timeout_seconds = timeout_seconds
        self.max_retries = max_retries
        self._proc: subprocess.Popen[str] | None = None
        if self.persistent:
            self._ensure_process()

    def _ensure_process(self) -> subprocess.Popen[str]:
        if self._proc is not None and self._proc.poll() is None:
            return self._proc
        self._proc = subprocess.Popen(
            self._command,
            cwd=str(self.hermes_root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            bufsize=1,
        )
        return self._proc

    def complete(
        self,
        *,
        system_message: str,
        user_message: str,
        conversation_history: list[dict[str, Any]] | None = None,
    ) -> str:
        payload = {
            "type": "complete",
            "systemMessage": system_message,
            "userMessage": user_message,
            "conversationHistory": conversation_history or [],
        }
        last_error: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                if self.persistent:
                    self._ensure_process()
                    response = self._round_trip(payload)
                else:
                    response = self._run_oneshot(payload)
                if not response.get("ok"):
                    raise HermesBridgeError(str(response.get("error", "Hermes bridge call failed")))
                final_response = response.get("finalResponse")
                if not isinstance(final_response, str):
                    raise HermesBridgeError("Hermes bridge returned a non-string finalResponse")
                return final_response
            except HermesBridgeError as exc:
                last_error = exc
                if attempt < self.max_retries:
                    logger.warning(
                        "Hermes bridge attempt %d/%d failed: %s — retrying",
                        attempt,
                        self.max_retries,
                        exc,
                    )
                    time.sleep(min(2**attempt, 8))
                    if self.persistent and self._proc is not None:
                        self._kill_process()
                else:
                    raise
        raise last_error or HermesBridgeError("Hermes bridge exhausted retries")

    def _kill_process(self) -> None:
        """Force-kill the persistent subprocess so it can be restarted."""
        if self._proc is None:
            return
        if self._proc.poll() is None:
            self._proc.kill()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        self._proc = None

    def _run_oneshot(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            completed = subprocess.run(
                self._command,
                cwd=str(self.hermes_root),
                input=json.dumps(payload) + "\n",
                capture_output=True,
                text=True,
                check=False,
                timeout=self.timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise HermesBridgeError(
                f"Hermes bridge oneshot timed out after {self.timeout_seconds}s"
            ) from exc
        if completed.returncode != 0:
            raise HermesBridgeError(
                "Hermes bridge oneshot call failed with code "
                f"{completed.returncode}: {completed.stderr.strip() or completed.stdout.strip()}"
            )

        for line in reversed(completed.stdout.splitlines()):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                parsed = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed

        raise HermesBridgeError(
            "Hermes bridge oneshot call returned no JSON response: "
            f"{completed.stdout.strip() or completed.stderr.strip()}"
        )

    def _round_trip(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self._proc is None:
            raise HermesBridgeError("Hermes bridge subprocess has not been started")
        if self._proc.stdin is None or self._proc.stdout is None:
            raise HermesBridgeError("Hermes bridge subprocess streams are unavailable")
        if self._proc.poll() is not None:
            raise HermesBridgeError(
                f"Hermes bridge exited before request with code {self._proc.returncode}"
            )

        self._proc.stdin.write(json.dumps(payload) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            raise HermesBridgeError(
                f"Hermes bridge terminated without a response (code {self._proc.poll()})"
            )
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise HermesBridgeError(f"Hermes bridge returned invalid JSON: {line}") from exc
        if not isinstance(parsed, dict):
            raise HermesBridgeError("Hermes bridge response was not a JSON object")
        return parsed

    def close(self) -> None:
        if self._proc is None:
            return
        if self._proc.poll() is not None:
            self._proc = None
            return
        try:
            self._round_trip({"type": "close"})
        except Exception:
            pass
        if self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=5)
        self._proc = None

    def __enter__(self) -> HermesBridgeClient:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()
