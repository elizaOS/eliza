"""Codex CLI client with full conversation replay and JSONL execution receipts.

Each turn runs codex exec with an explicit sandbox. Account-file presence is
only a readiness hint; subprocess authentication and execution must succeed."""

from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import subprocess
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from .accounts import CodexAccount, account_for_turn, select_codex_accounts

logger = logging.getLogger(__name__)

_DEFAULT_MODEL = "gpt-5.5"
_DEFAULT_TIMEOUT_S = 1200.0


@dataclass
class MessageResponse:
    """Parsed response from a single Codex turn.

    Shape-compatible with the smithers/hermes/openclaw adapters so downstream
    benchmark runners read Codex turns identically.
    """

    text: str
    thought: str | None = None
    actions: list[str] = field(default_factory=list)
    params: dict[str, object] = field(default_factory=dict)


def resolve_codex_binary(explicit: str | None = None) -> str:
    """Return the ``codex`` executable path. Raises ``FileNotFoundError`` if absent."""
    candidate = explicit or os.environ.get("CODEX_BIN") or shutil.which("codex")
    if not candidate or not Path(candidate).exists():
        raise FileNotFoundError(
            "codex executable not found. Install the Codex CLI or set CODEX_BIN."
        )
    return str(candidate)


def _run_codex_process(command: list[str], *, input: str, env: Mapping[str, str],
                       cwd: Path | None, timeout: float) -> subprocess.CompletedProcess[str]:
    """Own the CLI process group and preserve full timeout output."""
    with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, env=env, cwd=cwd,
                          start_new_session=os.name == "posix") as process:
        def stop() -> None:
            try:
                if os.name == "posix":
                    # The leader may already have exited while a child keeps a
                    # captured pipe open; still stop the group in that case.
                    os.killpg(process.pid, signal.SIGKILL)
                elif process.poll() is None:
                    process.kill()
            except ProcessLookupError:
                pass

        try:
            stdout, stderr = process.communicate(input, timeout=timeout)
        except subprocess.TimeoutExpired:
            stop()
            stdout, stderr = process.communicate()
            raise subprocess.TimeoutExpired(command, timeout, output=stdout, stderr=stderr) from None
        except BaseException:
            stop()
            process.communicate()
            raise
        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


class CodexClient:
    """Client for one-shot turns against the Codex CLI, rotating CODEX_HOME per account."""

    def __init__(
        self,
        *,
        accounts_spec: str | int | None = None,
        state_dir: Path | None = None,
        accounts: list[CodexAccount] | None = None,
        codex_bin: str | None = None,
        model: str = _DEFAULT_MODEL,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
        reasoning_effort: str | None = None,
        cwd: Path | None = None,
        receipt_dir: Path | None = None,
        sandbox: str | None = None,
    ) -> None:
        if sandbox not in (None, "read-only", "workspace-write"):
            raise ValueError("Codex benchmark sandbox must be read-only or workspace-write")
        self.sandbox = sandbox
        self._codex_bin_explicit = codex_bin
        self.model = model
        self.timeout_s = float(timeout_s)
        self.reasoning_effort = reasoning_effort or os.environ.get("ELIZA_CODEX_REASONING_EFFORT")
        self.cwd = cwd.resolve() if cwd is not None else None
        self.receipt_dir = receipt_dir.resolve() if receipt_dir is not None else None
        self._attempt: dict[str, object] | None = None
        self._history: list[dict[str, object]] = []
        # Account selection is resolved eagerly so a bad --accounts value fails
        # at construction, not mid-run. When `accounts` is passed directly
        # (tests / pre-resolved), it is used verbatim.
        self.accounts = (
            accounts
            if accounts is not None
            else select_codex_accounts(accounts_spec, state_dir=state_dir)
        )
        self._task_id: str | None = None
        self._benchmark: str | None = None
        self._turn_index = 0

    @property
    def codex_bin(self) -> str:
        return resolve_codex_binary(self._codex_bin_explicit)

    def health(self) -> dict[str, object]:
        """Confirm the binary resolves and every selected account is authenticated."""
        try:
            binary = self.codex_bin
        except FileNotFoundError as exc:
            return {"status": "error", "error": str(exc)}
        if not self.accounts:
            return {"status": "error", "error": "no Codex accounts selected"}
        unauth = [a.account_id for a in self.accounts if not a.is_authenticated]
        if unauth:
            return {
                "status": "error",
                "error": f"Codex accounts not authenticated (no auth.json): {unauth}",
            }
        return {"status": "ready", "binary": binary, "accounts": [a.account_id for a in self.accounts]}

    def is_ready(self) -> bool:
        return self.health().get("status") == "ready"

    def reset(self, task_id: str, benchmark: str, **kwargs: object) -> dict[str, object]:
        del kwargs
        self._task_id = task_id
        self._benchmark = benchmark
        self._turn_index = 0
        self._history.clear()
        return {"task_id": task_id, "benchmark": benchmark, "status": "ready"}

    def account_for_current_turn(self) -> CodexAccount:
        return account_for_turn(self.accounts, self._turn_index)

    def build_command(self) -> list[str]:
        """Non-interactive ``codex exec`` command; the prompt is sent on stdin."""
        command = [
            self.codex_bin,
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            self.sandbox or ("workspace-write" if self.cwd is not None else "read-only"),
            "--model",
            self.model,
        ]
        if self.reasoning_effort:
            command.extend(["-c", f"model_reasoning_effort={json.dumps(self.reasoning_effort)}"])
        return [*command, "-"]

    def build_env(self, account: CodexAccount) -> dict[str, str]:
        env = dict(os.environ)
        env["CODEX_HOME"] = str(account.codex_home)
        if self.reasoning_effort:
            env["ELIZA_CODEX_REASONING_EFFORT"] = self.reasoning_effort
        return env

    def send_message(self, text: str, context: Mapping[str, object] | None = None) -> MessageResponse:
        """Optionally retain a complete attempt receipt, including failed turns.

        Receipt creation fails before execution if the configured directory is
        unwritable. No credential environment or authentication file is copied.
        """
        if self.receipt_dir is None:
            return self._send_message(text, context)
        attempt_dir = self.receipt_dir / str(uuid.uuid4())
        attempt_dir.mkdir(parents=True, exist_ok=False)
        receipt: dict[str, object] = {
            "status": "started", "benchmark": self._benchmark,
            "task_id": self._task_id, "model": self.model,
            "turn_index": self._turn_index, "started_at": time.time(),
            "history": self._history.copy(), "text": text,
            "context": dict(context) if context is not None else None,
        }
        target = attempt_dir / "attempt.json"

        def persist() -> None:
            temporary = attempt_dir / "attempt.json.tmp"
            temporary.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(target)

        persist()
        self._attempt = receipt
        try:
            response = self._send_message(text, context)
            receipt["status"] = "succeeded"
            receipt["response"] = {"text": response.text, "thought": response.thought,
                                   "actions": response.actions, "params": response.params}
            return response
        except BaseException as error:
            receipt["status"] = "failed"
            receipt["error"] = {"type": type(error).__name__, "message": str(error)}
            if isinstance(error, subprocess.TimeoutExpired):
                receipt["stdout"] = error.stdout
                receipt["stderr"] = error.stderr
            raise
        finally:
            self._attempt = None
            receipt["finished_at"] = time.time()
            persist()

    def _send_message(self, text: str, context: Mapping[str, object] | None = None) -> MessageResponse:
        """Run one Codex turn as the round-robin-selected account.

        Raises on binary/account/subprocess failure — never returns a fabricated
        response. ``context`` is accepted for API compatibility with the other
        harness clients.
        """
        turn: dict[str, object] = {"role": "user", "text": text}
        if context is not None:
            turn["context"] = dict(context)
        # Each exec is a fresh process. Replay the complete task transcript so
        # observations and prior tool outcomes survive process/account changes.
        prompt = json.dumps(
            {"benchmark": self._benchmark, "task_id": self._task_id,
             "messages": [*self._history, turn]},
            ensure_ascii=False,
        )
        account = self.account_for_current_turn()
        if not account.is_authenticated:
            raise RuntimeError(
                f"Codex account '{account.account_id}' is not authenticated "
                f"(missing {account.codex_home / 'auth.json'})"
            )
        cmd = self.build_command()
        env = self.build_env(account)
        if self._attempt is not None:
            self._attempt.update({"account_id": account.account_id, "command": cmd, "prompt": prompt})
        started = time.monotonic()
        result = _run_codex_process(
            cmd,
            input=prompt,
            env=env,
            cwd=self.cwd,
            timeout=self.timeout_s,
        )
        if self._attempt is not None:
            self._attempt.update({"returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
        latency_ms = (time.monotonic() - started) * 1000.0
        self._turn_index += 1
        if result.returncode != 0:
            raise RuntimeError(
                f"codex exec failed (rc={result.returncode}) for account "
                f"'{account.account_id}':\n{(result.stderr or '')[-4000:]}"
            )
        events: list[dict[str, object]] = []
        messages: list[str] = []
        usage: dict[str, object] | None = None
        for line in (result.stdout or "").splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            if not isinstance(event, dict):
                raise TypeError("codex exec emitted a non-object JSONL event")
            events.append(event)
            if event.get("type") in {"turn.failed", "error"}:
                raise RuntimeError(f"codex exec failed: {json.dumps(event)}")
            if event.get("type") == "turn.completed":
                raw_usage = event.get("usage")
                usage = raw_usage if isinstance(raw_usage, dict) else {}
            item = event.get("item")
            if (
                event.get("type") == "item.completed"
                and isinstance(item, dict)
                and item.get("type") == "agent_message"
                and isinstance(item.get("text"), str)
            ):
                messages.append(item["text"])
        if usage is None:
            raise RuntimeError("codex exec did not emit turn.completed")
        text_out = "\n".join(messages).strip()
        if not text_out:
            raise RuntimeError(
                f"codex exec produced no output for account '{account.account_id}'. "
                f"STDERR:\n{(result.stderr or '')[-2000:]}"
            )
        self._history.extend([turn, {"role": "assistant", "text": text_out, "events": events}])
        return MessageResponse(
            text=text_out,
            params={
                "account_id": account.account_id,
                "codex_home": str(account.codex_home),
                "model": self.model,
                "turn_index": self._turn_index - 1,
                "latency_ms": latency_ms,
                "usage": usage,
                "events": events,
            },
        )
