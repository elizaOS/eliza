"""HTTP client for the eliza benchmark server."""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Mapping
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


@dataclass
class MessageResponse:
    """Parsed response from the eliza benchmark server."""

    text: str
    thought: str | None
    actions: list[str]
    params: dict[str, object]


class ElizaClient:
    """HTTP client for the eliza benchmark server.

    All communication uses stdlib ``urllib`` so there are no extra
    dependencies to install.
    """

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
    ) -> None:
        self._delegate = _build_delegate_client()
        resolved_url = (
            base_url
            or os.environ.get("ELIZA_BENCH_URL")
            or "http://localhost:3939"
        )
        self.base_url = resolved_url.rstrip("/")
        if token is None:
            env_token = os.environ.get("ELIZA_BENCH_TOKEN", "").strip()
            token = env_token or None
        self._token = token

    def set_token(self, token: str | None) -> None:
        """Set or clear the bearer token used for authenticated endpoints."""
        self._token = token

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def health(self) -> dict[str, object]:
        """GET /api/benchmark/health — check if the server is up."""
        if self._delegate is not None:
            return self._delegate.health()
        return self._get("/api/benchmark/health")

    def reset(
        self,
        task_id: str,
        benchmark: str,
        *,
        world_snapshot_path: str | None = None,
        now_iso: str | None = None,
    ) -> dict[str, object]:
        """Start a fresh session for a task.

        For most benchmarks this hits ``POST /api/benchmark/reset``. When
        ``benchmark == "lifeops_bench"`` and a world snapshot path is given,
        the call routes to the lifeops_bench-specific reset route which
        loads the LifeWorld JSON into an in-process fake backend keyed by
        ``task_id``.
        """
        if self._delegate is not None:
            return self._delegate.reset(
                task_id=task_id,
                benchmark=benchmark,
                world_snapshot_path=world_snapshot_path,
                now_iso=now_iso,
            )
        if benchmark == "lifeops_bench" and world_snapshot_path is not None:
            payload: dict[str, object] = {
                "task_id": task_id,
                "world_snapshot_path": world_snapshot_path,
            }
            if now_iso is not None:
                payload["now_iso"] = now_iso
            return self._post("/api/benchmark/lifeops_bench/reset", payload)
        return self._post(
            "/api/benchmark/reset",
            {"task_id": task_id, "benchmark": benchmark},
        )

    def lifeops_message(
        self,
        task_id: str,
        text: str,
        *,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        """POST /api/benchmark/lifeops_bench/message — runs the planner and
        executes any captured tool calls against the in-memory fake backend.

        Returns the raw JSON body — callers are expected to map it into a
        ``MessageTurn`` (see ``eliza_adapter.lifeops_bench``).
        """
        if self._delegate is not None:
            response = self._delegate.send_message(
                text,
                context={"benchmark": "lifeops_bench", "task_id": task_id, "tools": tools or []},
            )
            return {
                "text": response.text,
                "thought": response.thought,
                "actions": response.actions,
                "tool_calls": response.params.get("tool_calls", []),
                "usage": response.params.get("usage", {}),
            }
        body: dict[str, object] = {"task_id": task_id, "text": text}
        if tools:
            body["context"] = {"tools": tools}
        return self._post("/api/benchmark/lifeops_bench/message", body)

    def lifeops_world_state(self, task_id: str) -> dict[str, object]:
        """GET /api/benchmark/lifeops_bench/{task_id}/world_state — returns
        the LifeWorld JSON snapshot for state-hash scoring."""
        if self._delegate is not None:
            return {"task_id": task_id, "status": "unavailable", "world": None}
        return self._get(f"/api/benchmark/lifeops_bench/{task_id}/world_state")

    def lifeops_teardown(self, task_id: str) -> dict[str, object]:
        """POST /api/benchmark/lifeops_bench/teardown — frees the per-task
        fake backend on the server."""
        if self._delegate is not None:
            return {"task_id": task_id, "status": "ok"}
        return self._post(
            "/api/benchmark/lifeops_bench/teardown",
            {"task_id": task_id},
        )

    def send_message(
        self,
        text: str,
        context: Mapping[str, object] | None = None,
    ) -> MessageResponse:
        """POST /api/benchmark/message — send a message and get response."""
        if self._delegate is not None:
            return self._delegate.send_message(text, context)
        body: dict[str, object] = {"text": text}
        if context is not None:
            body["context"] = dict(context)

        raw = self._post("/api/benchmark/message", body)
        return MessageResponse(
            text=str(raw.get("text", "")),
            thought=raw.get("thought") if isinstance(raw.get("thought"), str) else None,
            actions=list(raw.get("actions", [])),
            params=dict(raw.get("params", {})),
        )

    def is_ready(self) -> bool:
        if self._delegate is not None:
            return bool(self._delegate.is_ready())
        import socket

        parsed = urlparse(self.base_url)
        host = parsed.hostname or "localhost"
        if parsed.port is not None:
            port = parsed.port
        elif parsed.scheme == "https":
            port = 443
        else:
            port = 80

        try:
            with socket.create_connection((host, port), timeout=1):
                return True
        except Exception:
            return False

    def wait_until_ready(self, timeout: float = 120.0, poll: float = 1.0) -> None:
        """Block until the benchmark server is healthy or *timeout* elapses."""
        if self._delegate is not None:
            return self._delegate.wait_until_ready(timeout=timeout, poll=poll)
        deadline = time.monotonic() + timeout
        last_err: str = ""
        progress = os.environ.get("ELIZA_BENCH_WAIT_PROGRESS", "").strip() == "1"
        next_progress = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                # First, check if the socket is open
                if not self.is_ready():
                    last_err = "Socket connection refused or timed out"
                    if progress and time.monotonic() >= next_progress:
                        print(f"DEBUG: Waiting for {self.base_url} ({last_err})", flush=True)
                        next_progress = time.monotonic() + 5.0
                    time.sleep(poll)
                    continue

                # Then, check the health endpoint
                resp = self.health()
                if resp.get("status") == "ready":
                    logger.info("Eliza benchmark server is ready")
                    return
                last_err = f"Server health status not 'ready': {resp}"
            except Exception as exc:
                last_err = str(exc)
            if progress and time.monotonic() >= next_progress:
                print(f"DEBUG: Waiting for {self.base_url} ({last_err})", flush=True)
                next_progress = time.monotonic() + 5.0
            time.sleep(poll)
        raise TimeoutError(
            f"Eliza benchmark server not ready after {timeout}s: {last_err}"
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _auth_headers(self) -> dict[str, str]:
        if self._token:
            return {"Authorization": f"Bearer {self._token}"}
        return {}

    def _get(self, path: str) -> dict[str, object]:
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, method="GET", headers=self._auth_headers())
        return self._do(req)

    def _post(self, path: str, body: dict[str, object]) -> dict[str, object]:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json", **self._auth_headers()}
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers=headers,
        )
        return self._do(req)

    @staticmethod
    def _do(req: urllib.request.Request) -> dict[str, object]:
        # Long ceiling: vending-bench day 1 with a fresh runtime (full plugin
        # init + first slow LLM call) regularly takes >5 min. Override via
        # ELIZA_BENCH_HTTP_TIMEOUT env var if the operator wants a tighter cap.
        try:
            timeout_s = float(os.environ.get("ELIZA_BENCH_HTTP_TIMEOUT", "1800"))
        except ValueError:
            timeout_s = 1800.0
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw)  # type: ignore[no-any-return]
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"HTTP {exc.code} from eliza benchmark server: {body}"
            ) from exc


def _build_delegate_client():
    """Return the selected non-Eliza harness client, if any.

    The orchestrator sets ``BENCHMARK_HARNESS`` / ``ELIZA_BENCH_HARNESS`` for
    every run. Existing benchmarks that already call ``ElizaClient`` therefore
    get Hermes/OpenClaw apples-to-apples transport without changing their
    scenario loops, context shaping, or tool inventories.
    """

    harness = (
        os.environ.get("ELIZA_BENCH_HARNESS")
        or os.environ.get("BENCHMARK_HARNESS")
        or ""
    ).strip().lower()
    provider = (os.environ.get("BENCHMARK_MODEL_PROVIDER") or "cerebras").strip().lower()
    model = (
        os.environ.get("BENCHMARK_MODEL_NAME")
        or os.environ.get("MODEL_NAME")
        or os.environ.get("CEREBRAS_MODEL")
        or "gpt-oss-120b"
    ).strip()
    if harness == "hermes":
        from hermes_adapter.client import HermesClient  # noqa: WPS433

        return HermesClient(provider=provider, model=model)
    if harness == "openclaw":
        from openclaw_adapter.client import OpenClawClient  # noqa: WPS433

        return OpenClawClient(provider=provider, model=model)
    return None
