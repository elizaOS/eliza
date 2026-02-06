"""Tlon/Urbit HTTP API client."""

from __future__ import annotations

import asyncio
import logging
import random
import string
import time
from collections.abc import Callable
from typing import Any

import httpx

from elizaos_plugin_tlon.config import format_ship, normalize_ship
from elizaos_plugin_tlon.error import (
    AuthenticationError,
    ConnectionError,
    PokeError,
    ScryError,
    SubscribeError,
)

logger = logging.getLogger(__name__)


async def authenticate(url: str, code: str) -> str:
    """Authenticate with an Urbit ship and return the session cookie.

    Args:
        url: The Urbit ship URL
        code: The authentication code from +code

    Returns:
        The session cookie string

    Raises:
        AuthenticationError: If authentication fails
    """
    login_url = f"{url.rstrip('/')}/~/login"

    async with httpx.AsyncClient() as client:
        response = await client.post(
            login_url,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            content=f"password={code}",
        )

        if not response.is_success:
            raise AuthenticationError(f"Login failed with status {response.status_code}")

        cookie = response.headers.get("set-cookie")
        if not cookie:
            raise AuthenticationError("No authentication cookie received")

        return cookie


class TlonClient:
    """Tlon/Urbit HTTP API client with SSE support."""

    def __init__(
        self,
        url: str,
        cookie: str,
        ship: str | None = None,
        auto_reconnect: bool = True,
        max_reconnect_attempts: int = 10,
        reconnect_delay: float = 1.0,
        max_reconnect_delay: float = 30.0,
    ) -> None:
        """Initialize the client.

        Args:
            url: The Urbit ship URL
            cookie: The session cookie
            ship: Ship name (optional, will be extracted from cookie if not provided)
            auto_reconnect: Whether to auto-reconnect on disconnection
            max_reconnect_attempts: Maximum reconnection attempts
            reconnect_delay: Initial delay between reconnection attempts
            max_reconnect_delay: Maximum delay between reconnection attempts
        """
        self._url = url.rstrip("/")
        self._cookie = cookie.split(";")[0]
        self._ship = ship or self._resolve_ship_from_url(url)
        self._channel_id = self._generate_channel_id()
        self._channel_url = f"{self._url}/~/channel/{self._channel_id}"

        self._http_client: httpx.AsyncClient | None = None
        self._subscriptions: list[dict[str, Any]] = []
        self._event_handlers: dict[int, dict[str, Callable[..., None] | None]] = {}
        self._is_connected = False
        self._aborted = False

        self._auto_reconnect = auto_reconnect
        self._max_reconnect_attempts = max_reconnect_attempts
        self._reconnect_delay = reconnect_delay
        self._max_reconnect_delay = max_reconnect_delay
        self._reconnect_attempts = 0

    @property
    def url(self) -> str:
        """The Urbit ship URL."""
        return self._url

    @property
    def ship(self) -> str:
        """The ship name (without ~)."""
        return self._ship

    @property
    def is_connected(self) -> bool:
        """Whether the client is connected."""
        return self._is_connected

    @staticmethod
    def _generate_channel_id() -> str:
        """Generate a unique channel ID."""
        timestamp = int(time.time())
        random_suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
        return f"{timestamp}-{random_suffix}"

    @staticmethod
    def _resolve_ship_from_url(url: str) -> str:
        """Extract ship name from URL."""
        try:
            from urllib.parse import urlparse

            parsed = urlparse(url)
            host = parsed.hostname or ""
            if "." in host:
                return host.split(".")[0]
            return host
        except Exception:
            return ""

    async def _ensure_client(self) -> httpx.AsyncClient:
        """Ensure HTTP client is initialized."""
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(timeout=30.0)
        return self._http_client

    async def subscribe(
        self,
        app: str,
        path: str,
        event: Callable[[Any], None] | None = None,
        err: Callable[[Exception], None] | None = None,
        quit: Callable[[], None] | None = None,
    ) -> int:
        """Subscribe to an app's path for updates.

        Args:
            app: The app name
            path: The subscription path
            event: Callback for events
            err: Callback for errors
            quit: Callback for subscription end

        Returns:
            The subscription ID
        """
        sub_id = len(self._subscriptions) + 1
        subscription = {
            "id": sub_id,
            "action": "subscribe",
            "ship": self._ship,
            "app": app,
            "path": path,
        }

        self._subscriptions.append(subscription)
        self._event_handlers[sub_id] = {"event": event, "err": err, "quit": quit}

        if self._is_connected:
            await self._send_subscription(subscription)

        return sub_id

    async def _send_subscription(self, subscription: dict[str, Any]) -> None:
        """Send a subscription request."""
        client = await self._ensure_client()
        response = await client.put(
            self._channel_url,
            headers={
                "Content-Type": "application/json",
                "Cookie": self._cookie,
            },
            json=[subscription],
        )

        if not response.is_success and response.status_code != 204:
            raise SubscribeError(f"Subscribe failed: {response.status_code} - {response.text}")

    async def connect(self) -> None:
        """Connect to the Urbit ship and start receiving events."""
        client = await self._ensure_client()

        # Create channel with subscriptions
        response = await client.put(
            self._channel_url,
            headers={
                "Content-Type": "application/json",
                "Cookie": self._cookie,
            },
            json=self._subscriptions,
        )

        if not response.is_success and response.status_code != 204:
            raise ConnectionError(f"Channel creation failed: {response.status_code}")

        # Activate channel with a poke
        poke_response = await client.put(
            self._channel_url,
            headers={
                "Content-Type": "application/json",
                "Cookie": self._cookie,
            },
            json=[
                {
                    "id": int(time.time() * 1000),
                    "action": "poke",
                    "ship": self._ship,
                    "app": "hood",
                    "mark": "helm-hi",
                    "json": "Opening API channel",
                }
            ],
        )

        if not poke_response.is_success and poke_response.status_code != 204:
            raise ConnectionError(f"Channel activation failed: {poke_response.status_code}")

        self._is_connected = True
        self._reconnect_attempts = 0
        logger.info(f"[Tlon] Connected to ~{self._ship}")

    async def poke(self, app: str, mark: str, json_data: Any) -> int:
        """Send a poke to an app.

        Args:
            app: The app name
            mark: The mark type
            json_data: The JSON payload

        Returns:
            The poke ID
        """
        client = await self._ensure_client()
        poke_id = int(time.time() * 1000)

        response = await client.put(
            self._channel_url,
            headers={
                "Content-Type": "application/json",
                "Cookie": self._cookie,
            },
            json=[
                {
                    "id": poke_id,
                    "action": "poke",
                    "ship": self._ship,
                    "app": app,
                    "mark": mark,
                    "json": json_data,
                }
            ],
        )

        if not response.is_success and response.status_code != 204:
            raise PokeError(f"Poke failed: {response.status_code} - {response.text}")

        return poke_id

    async def scry(self, path: str) -> Any:
        """Perform a scry (read-only query).

        Args:
            path: The scry path

        Returns:
            The JSON response
        """
        client = await self._ensure_client()
        scry_url = f"{self._url}/~/scry{path}"

        response = await client.get(
            scry_url,
            headers={"Cookie": self._cookie},
        )

        if not response.is_success:
            raise ScryError(f"Scry failed: {response.status_code} for path {path}")

        return response.json()

    async def close(self) -> None:
        """Close the connection and cleanup."""
        self._aborted = True
        self._is_connected = False

        if self._http_client:
            try:
                # Unsubscribe from all
                unsubscribes = [
                    {"id": sub["id"], "action": "unsubscribe", "subscription": sub["id"]}
                    for sub in self._subscriptions
                ]

                if unsubscribes:
                    await self._http_client.put(
                        self._channel_url,
                        headers={
                            "Content-Type": "application/json",
                            "Cookie": self._cookie,
                        },
                        json=unsubscribes,
                    )

                # Delete channel
                await self._http_client.delete(
                    self._channel_url,
                    headers={"Cookie": self._cookie},
                )
            except Exception as e:
                logger.error(f"[Tlon] Error closing channel: {e}")
            finally:
                await self._http_client.aclose()
                self._http_client = None

        logger.info(f"[Tlon] Disconnected from ~{self._ship}")

    @classmethod
    async def create(
        cls,
        url: str,
        code: str,
        ship: str | None = None,
        **kwargs: Any,
    ) -> TlonClient:
        """Create and authenticate a new client.

        Args:
            url: The Urbit ship URL
            code: The authentication code
            ship: Optional ship name
            **kwargs: Additional arguments passed to __init__

        Returns:
            An authenticated TlonClient instance
        """
        cookie = await authenticate(url, code)
        return cls(url, cookie, ship=ship, **kwargs)
