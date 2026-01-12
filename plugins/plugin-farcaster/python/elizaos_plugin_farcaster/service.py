from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field

from elizaos_plugin_farcaster.client import FarcasterClient
from elizaos_plugin_farcaster.config import FarcasterConfig
from elizaos_plugin_farcaster.error import ConfigError, FarcasterError
from elizaos_plugin_farcaster.types import Cast, FidRequest, Profile

logger = logging.getLogger(__name__)


@dataclass
class FarcasterService:
    config: FarcasterConfig
    client: FarcasterClient | None = None
    _running: bool = field(default=False, init=False)
    _poll_task: asyncio.Task[None] | None = field(default=None, init=False)
    _mention_callback: Callable[[Cast], None] | None = field(default=None, init=False)

    @classmethod
    def from_env(cls) -> FarcasterService:
        config = FarcasterConfig.from_env()
        return cls(config=config)

    async def start(self) -> None:
        if self._running:
            return

        self.config.validate()
        self.client = FarcasterClient(self.config)
        self._running = True

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
        while self._running:
            try:
                await self._check_mentions()
            except FarcasterError as e:
                logger.debug(f"Farcaster error during mention check: {e}")
            except Exception as e:  # noqa: BLE001
                logger.debug(f"Unexpected error during mention check: {e}")

            await asyncio.sleep(self.config.poll_interval)

    async def _check_mentions(self) -> None:
        if not self.client or not self._mention_callback:
            return

        request = FidRequest(fid=self.config.fid, page_size=50)
        mentions = await self.client.get_mentions(request)

        for cast in mentions:
            self._mention_callback(cast)

    def on_mention(self, callback: Callable[[Cast], None]) -> None:
        self._mention_callback = callback

    async def send_cast(
        self,
        text: str,
        reply_to: str | None = None,
    ) -> list[Cast]:
        if not self.client:
            raise ConfigError("Service not started")

        from elizaos_plugin_farcaster.types import CastId

        in_reply_to = CastId(hash=reply_to, fid=0) if reply_to else None
        return await self.client.send_cast(text, in_reply_to)

    async def get_cast(self, cast_hash: str) -> Cast:
        if not self.client:
            raise ConfigError("Service not started")
        return await self.client.get_cast(cast_hash)

    async def get_profile(self, fid: int | None = None) -> Profile:
        if not self.client:
            raise ConfigError("Service not started")
        return await self.client.get_profile(fid or self.config.fid)

    async def get_mentions(self, limit: int = 50) -> list[Cast]:
        if not self.client:
            raise ConfigError("Service not started")
        request = FidRequest(fid=self.config.fid, page_size=limit)
        return await self.client.get_mentions(request)

    async def get_timeline(self, limit: int = 50) -> tuple[list[Cast], str | None]:
        if not self.client:
            raise ConfigError("Service not started")
        request = FidRequest(fid=self.config.fid, page_size=limit)
        return await self.client.get_timeline(request)

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def fid(self) -> int:
        return self.config.fid
