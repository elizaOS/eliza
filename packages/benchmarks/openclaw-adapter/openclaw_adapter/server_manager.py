"""Lifecycle owner for the OpenClaw benchmark adapter.

OpenClaw is a one-shot CLI, so the manager is intentionally thin:
``start()`` validates the binary exists and warms up the Node compile cache
by running ``--version``; ``stop()`` is a no-op.
"""

from __future__ import annotations

import logging
from pathlib import Path

from openclaw_adapter.client import OpenClawClient

logger = logging.getLogger(__name__)


class OpenClawCLIManager:
    """Lifecycle owner for one-shot OpenClaw invocations.

    Usage::

        mgr = OpenClawCLIManager()
        mgr.start()             # validates binary + warms Node compile cache
        out = mgr.client.send_message("say PONG")
        mgr.stop()              # no-op
    """

    def __init__(
        self,
        install_path: Path | None = None,
        *,
        client: OpenClawClient | None = None,
    ) -> None:
        if client is not None and install_path is not None:
            raise ValueError(
                "Pass either install_path or client, not both"
            )
        if client is not None:
            self._client = client
        elif install_path is not None:
            self._client = OpenClawClient(binary_path=install_path)
        else:
            self._client = OpenClawClient()
        self._started = False

    @property
    def client(self) -> OpenClawClient:
        return self._client

    @property
    def install_path(self) -> Path:
        return self._client.binary_path

    def start(self) -> None:
        """Validate the binary exists and warm the Node compile cache.

        Raises :class:`FileNotFoundError` with the full path in the message
        when the binary is missing — operators rely on the path being visible
        in the error to diagnose install location issues. Raises
        :class:`RuntimeError` when ``<binary> --version`` exits non-zero or
        the subprocess cannot start, so a broken install fails fast here
        instead of producing a cryptic error on the first benchmark turn.
        """
        if self._started:
            return
        if not self._client.binary_path.exists():
            raise FileNotFoundError(
                f"OpenClaw binary not found at {self._client.binary_path}. "
                "Install OpenClaw under ~/.eliza/agents/openclaw/ or set OPENCLAW_BIN."
            )
        probe = self._client.health()
        if probe.get("status") != "ready":
            raise RuntimeError(
                f"OpenClaw health probe failed for {self._client.binary_path}: {probe}"
            )
        logger.info(
            "OpenClawCLIManager started (binary=%s, version=%s)",
            self._client.binary_path,
            probe.get("version"),
        )
        self._started = True

    def stop(self) -> None:
        """No-op — OpenClaw is one-shot per turn."""
        self._started = False

    def is_running(self) -> bool:
        return self._started


__all__ = ["OpenClawCLIManager"]
