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

from benchmarks.lib.base_benchmark_client import (
    CEREBRAS_GPT_OSS_120B_PRICING,
    BaseBenchmarkClient,
    ModelPricing,
)

logger = logging.getLogger(__name__)


@dataclass
class MessageResponse:
    """Parsed response from the eliza benchmark server."""

    text: str
    thought: str | None
    actions: list[str]
    params: dict[str, object]


def _resolve_pricing(provider: str | None, model: str | None) -> ModelPricing | None:
    """Map (provider, model) to a pricing tuple.

    Currently only Cerebras gpt-oss-120b is wired; other models fall back to
    ``None`` so cost reporting becomes 0 rather than silently mispriced.
    """
    p = (provider or "").strip().lower()
    m = (model or "").strip().lower()
    if p == "cerebras" and m == "gpt-oss-120b":
        return CEREBRAS_GPT_OSS_120B_PRICING
    return None


class ElizaClient(BaseBenchmarkClient[MessageResponse]):
    """HTTP client for the eliza benchmark server.

    All communication uses stdlib ``urllib`` so there are no extra
    dependencies to install. Inherits :class:`BaseBenchmarkClient` for
    concurrency limiting, cost computation, and per-turn telemetry capture.
    """

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        *,
        concurrency: int = 4,
        provider: str | None = None,
        model: str | None = None,
    ) -> None:
        resolved_provider = (
            provider
            or os.environ.get("BENCHMARK_MODEL_PROVIDER")
            or "cerebras"
        ).strip().lower()
        resolved_model = (
            model
            or os.environ.get("BENCHMARK_MODEL_NAME")
            or os.environ.get("MODEL_NAME")
            or os.environ.get("CEREBRAS_MODEL")
            or "gpt-oss-120b"
        ).strip()
        super().__init__(
            concurrency=concurrency,
            pricing=_resolve_pricing(resolved_provider, resolved_model),
            model=resolved_model,
            provider=resolved_provider,
        )
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
        """POST /api/benchmark/message — send a message and get response.

        Captures per-turn telemetry (latency_ms, prompt/completion tokens,
        cost_usd) into ``self.telemetry_history`` so callers that want token
        accounting can read it back; the original delegate-aware path is
        preserved for the Hermes / OpenClaw harness routing.
        """
        if self._delegate is not None:
            return self._delegate.send_message(text, context)
        started = time.time()
        body: dict[str, object] = {"text": text}
        if context is not None:
            body["context"] = dict(context)
        raw = self._post("/api/benchmark/message", body)
        finished = time.time()
        response = _message_response_from_raw(raw)
        # The TS bench server emits a top-level ``usage`` field on the JSON
        # response (added 2026-05 to surface Cerebras token counts). Pull it
        # into telemetry; if it's missing, record zeros (telemetry still has
        # latency).
        raw_usage = raw.get("usage")
        usage_map: Mapping[str, object] | None = (
            raw_usage if isinstance(raw_usage, Mapping) else None
        )
        self.record_telemetry(
            started_at_epoch=started,
            finished_at_epoch=finished,
            usage=usage_map,
        )
        return response

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
    # Subclass override of BaseBenchmarkClient._send.
    # ------------------------------------------------------------------

    def _send(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> MessageResponse:
        """Pure-HTTP send_message — used by the base class telemetry wrapper.

        The public ``send_message`` keeps its existing surface (delegate-aware,
        directly returns a ``MessageResponse``); this ``_send`` exists so
        callers that want the telemetry-tracked path can use
        :meth:`send_message_tracked` from the base class.
        """
        body: dict[str, object] = {"text": text}
        if context is not None:
            body["context"] = dict(context)
        raw = self._post("/api/benchmark/message", body)
        return _message_response_from_raw(raw)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _auth_headers(self) -> dict[str, str]:
        # Delegate to the canonical helper on the base class so all three
        # adapters build the Bearer header identically.
        return self.build_auth_headers(self._token)

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


def _message_response_from_raw(raw: Mapping[str, object]) -> MessageResponse:
    """Map a parsed bench server JSON body to :class:`MessageResponse`.

    Centralized so :meth:`ElizaClient.send_message` and :meth:`ElizaClient._send`
    share the exact same parsing logic.
    """
    thought = raw.get("thought") if isinstance(raw.get("thought"), str) else None
    actions_raw = raw.get("actions") or []
    actions = (
        [str(a) for a in actions_raw]
        if isinstance(actions_raw, list)
        else []
    )
    params_raw = raw.get("params") or {}
    params = dict(params_raw) if isinstance(params_raw, dict) else {}
    return MessageResponse(
        text=str(raw.get("text", "")),
        thought=thought,
        actions=actions,
        params=params,
    )


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
