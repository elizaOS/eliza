"""Lifecycle owner for the hermes-agent adapter.

Unlike :class:`eliza_adapter.server_manager.ElizaServerManager` which spawns a
long-running TypeScript HTTP server, the hermes-agent adapter is one-shot:
every ``send_message`` spawns its own short-lived Python subprocess against the
hermes-agent venv. So this manager is intentionally thin — ``start()``
validates the venv has hermes-agent importable (warm-up + fail-fast), and
``stop()`` is a no-op.

This shape lets the orchestrator treat all three agent adapters uniformly
without paying for an extra long-running process tier.
"""

from __future__ import annotations

import logging
from pathlib import Path

from hermes_adapter.client import HermesClient

logger = logging.getLogger(__name__)


class HermesAgentManager:
    """Lifecycle owner for one-shot hermes-agent invocations.

    Usage::

        mgr = HermesAgentManager()
        mgr.start()             # validates the venv (or no-op in in_process mode)
        out = mgr.client.send_message("say PONG")
        mgr.stop()              # no-op
    """

    def __init__(
        self,
        repo_path: Path | None = None,
        *,
        mode: str = "subprocess",
    ) -> None:
        if mode not in {"subprocess", "in_process"}:
            raise ValueError(f"Unknown mode {mode!r}; expected 'subprocess' or 'in_process'")
        self.mode = mode
        self._client = HermesClient(repo_path=repo_path, mode=mode)
        self._started = False

    @property
    def client(self) -> HermesClient:
        return self._client

    def start(self) -> None:
        """Warm up the venv and fail fast if hermes-agent is missing.

        For ``in_process`` mode this is a no-op (we trust the caller).
        """
        if self._started:
            return
        if self.mode == "in_process":
            self._started = True
            return
        probe = self._client.health()
        status = probe.get("status")
        if status != "ready":
            raise RuntimeError(
                "hermes-agent venv not ready. Run `pip install -e .` inside "
                f"{self._client.repo_path}/.venv before starting the manager. "
                f"Probe result: {probe}"
            )
        logger.info("HermesAgentManager started (venv=%s)", self._client.venv_python)
        self._started = True

    def stop(self) -> None:
        """No-op for the one-shot subprocess model."""
        self._started = False

    def is_running(self) -> bool:
        return self._started
