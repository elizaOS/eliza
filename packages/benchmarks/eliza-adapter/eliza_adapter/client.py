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
        return self._get("/api/benchmark/health")

    def reset(self, task_id: str, benchmark: str) -> dict[str, object]:
        """POST /api/benchmark/reset — start a fresh session for a task."""
        return self._post(
            "/api/benchmark/reset",
            {"task_id": task_id, "benchmark": benchmark},
        )

    def send_message(
        self,
        text: str,
        context: Mapping[str, object] | None = None,
    ) -> MessageResponse:
        """POST /api/benchmark/message — send a message and get response."""
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
        deadline = time.monotonic() + timeout
        last_err: str = ""
        while time.monotonic() < deadline:
            try:
                # First, check if the socket is open
                if not self.is_ready():
                    last_err = "Socket connection refused or timed out"
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
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw)  # type: ignore[no-any-return]
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"HTTP {exc.code} from eliza benchmark server: {body}"
            ) from exc
