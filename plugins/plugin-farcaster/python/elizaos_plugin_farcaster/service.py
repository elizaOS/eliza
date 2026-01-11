"""
Farcaster service for elizaOS.

Provides the main service interface for Farcaster integration.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field

from elizaos_plugin_farcaster.client import FarcasterClient
from elizaos_plugin_farcaster.config import FarcasterConfig
from elizaos_plugin_farcaster.error import ConfigError, FarcasterError
from elizaos_plugin_farcaster.types import Cast, FidRequest, Profile


@dataclass
class FarcasterService:
    """
    Farcaster service for elizaOS agents.

    Manages the Farcaster client lifecycle and provides high-level
    operations for casting, mentions, and timeline interactions.
    """

    config: FarcasterConfig
    client: FarcasterClient | None = None
    _running: bool = field(default=False, init=False)
    _poll_task: asyncio.Task[None] | None = field(default=None, init=False)
    _mention_callback: Callable[[Cast], None] | None = field(default=None, init=False)

    @classmethod
    def from_env(cls) -> FarcasterService:
        """Create a service from environment variables."""
        config = FarcasterConfig.from_env()
        return cls(config=config)

    async def start(self) -> None:
        """Start the Farcaster service."""
        if self._running:
            return

        self.config.validate()
        self.client = FarcasterClient(self.config)
        self._running = True

        # Start polling if in polling mode
        if self.config.mode == "polling" and self._mention_callback:
            self._poll_task = asyncio.create_task(self._poll_loop())

    async def stop(self) -> None:
        """Stop the Farcaster service."""
        if not self._running:
            return

        self._running = False

        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None

        if self.client:
            await self.client.close()
            self.client = None

    async def _poll_loop(self) -> None:
        """Poll for new mentions."""
        while self._running:
            try:
                await self._check_mentions()
            except FarcasterError as e:
                # Log error but continue polling
                print(f"Error checking mentions: {e}")
            except Exception as e:
                print(f"Unexpected error in poll loop: {e}")

            await asyncio.sleep(self.config.poll_interval)

    async def _check_mentions(self) -> None:
        """Check for new mentions and call the callback."""
        if not self.client or not self._mention_callback:
            return

        request = FidRequest(fid=self.config.fid, page_size=50)
        mentions = await self.client.get_mentions(request)

        for cast in mentions:
            self._mention_callback(cast)

    def on_mention(self, callback: Callable[[Cast], None]) -> None:
        """Register a callback for new mentions."""
        self._mention_callback = callback

    async def send_cast(
        self,
        text: str,
        reply_to: str | None = None,
    ) -> list[Cast]:
        """
        Send a cast.

        Args:
            text: The cast text.
            reply_to: Optional cast hash to reply to.

        Returns:
            List of sent casts.
        """
        if not self.client:
            raise ConfigError("Service not started")

        from elizaos_plugin_farcaster.types import CastId

        in_reply_to = CastId(hash=reply_to, fid=0) if reply_to else None
        return await self.client.send_cast(text, in_reply_to)

    async def get_cast(self, cast_hash: str) -> Cast:
        """Get a cast by hash."""
        if not self.client:
            raise ConfigError("Service not started")
        return await self.client.get_cast(cast_hash)

    async def get_profile(self, fid: int | None = None) -> Profile:
        """Get a profile by FID. Defaults to configured FID."""
        if not self.client:
            raise ConfigError("Service not started")
        return await self.client.get_profile(fid or self.config.fid)

    async def get_mentions(self, limit: int = 50) -> list[Cast]:
        """Get recent mentions."""
        if not self.client:
            raise ConfigError("Service not started")
        request = FidRequest(fid=self.config.fid, page_size=limit)
        return await self.client.get_mentions(request)

    async def get_timeline(self, limit: int = 50) -> tuple[list[Cast], str | None]:
        """Get the timeline."""
        if not self.client:
            raise ConfigError("Service not started")
        request = FidRequest(fid=self.config.fid, page_size=limit)
        return await self.client.get_timeline(request)

    @property
    def is_running(self) -> bool:
        """Check if the service is running."""
        return self._running

    @property
    def fid(self) -> int:
        """Get the configured FID."""
        return self.config.fid
