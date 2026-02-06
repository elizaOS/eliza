"""HTTP client for the milaidy benchmark server."""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Mapping

logger = logging.getLogger(__name__)


@dataclass
class MessageResponse:
    """Parsed response from the milaidy benchmark server."""

    text: str
    thought: str | None
    actions: list[str]
    params: dict[str, object]


class MilaidyClient:
    """HTTP client for the milaidy benchmark server.

    All communication uses stdlib ``urllib`` so there are no extra
    dependencies to install.
    """

    def __init__(self, base_url: str = "http://localhost:3939") -> None:
        self.base_url = base_url.rstrip("/")

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

    def wait_until_ready(self, timeout: float = 120.0, poll: float = 1.0) -> None:
        """Block until the benchmark server is healthy or *timeout* elapses."""
        deadline = time.monotonic() + timeout
        last_err: str = ""
        while time.monotonic() < deadline:
            try:
                resp = self.health()
                if resp.get("status") == "ready":
                    logger.info("Milaidy benchmark server is ready")
                    return
            except Exception as exc:
                last_err = str(exc)
            time.sleep(poll)
        raise TimeoutError(
            f"Milaidy benchmark server not ready after {timeout}s: {last_err}"
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _get(self, path: str) -> dict[str, object]:
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, method="GET")
        return self._do(req)

    def _post(self, path: str, body: dict[str, object]) -> dict[str, object]:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={"Content-Type": "application/json"},
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
                f"HTTP {exc.code} from milaidy benchmark server: {body}"
            ) from exc
