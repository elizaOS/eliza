"""Lifecycle owner for the OpenClaw benchmark adapter."""

from __future__ import annotations

from openclaw_adapter.client import OpenClawClient


class OpenClawCLIManager:
    """Thin manager matching the Eliza/Hermes adapter lifecycle shape."""

    def __init__(self, client: OpenClawClient | None = None) -> None:
        self._client = client or OpenClawClient()
        self._running = False

    @property
    def client(self) -> OpenClawClient:
        return self._client

    def start(self, timeout: float = 60.0) -> None:
        self._client.wait_until_ready(timeout=timeout)
        self._running = True

    def stop(self) -> None:
        self._running = False

    def is_running(self) -> bool:
        return self._running and self._client.is_ready()
