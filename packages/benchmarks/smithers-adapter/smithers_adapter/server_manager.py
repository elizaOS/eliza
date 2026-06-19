"""Lifecycle owner for the Smithers benchmark adapter.

Smithers turns run as one-shot ``bun`` subprocesses, so the manager is thin:
``start()`` validates that ``bun`` and the Smithers install are present and
materializes the harness script; ``stop()`` is a no-op.
"""

from __future__ import annotations

import logging
from pathlib import Path

from smithers_adapter.client import SmithersClient

logger = logging.getLogger(__name__)


class SmithersManager:
    """Lifecycle owner for one-shot Smithers invocations."""

    def __init__(
        self,
        install_dir: Path | None = None,
        *,
        client: SmithersClient | None = None,
    ) -> None:
        if client is not None and install_dir is not None:
            raise ValueError("Pass either install_dir or client, not both")
        self._client = client if client is not None else SmithersClient(install_dir=install_dir)
        self._started = False

    @property
    def client(self) -> SmithersClient:
        return self._client

    @property
    def install_dir(self) -> Path:
        return self._client.install_dir

    def start(self) -> None:
        """Validate bun + the Smithers install and materialize the harness."""
        probe = self._client.health()
        if probe.get("status") != "ready":
            raise RuntimeError(f"Smithers harness not ready: {probe.get('error')}")
        self._started = True
        logger.info("smithers harness ready (install=%s)", self.install_dir)

    def stop(self) -> None:
        self._started = False
