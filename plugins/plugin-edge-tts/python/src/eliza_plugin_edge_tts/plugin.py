"""Edge TTS plugin definition for ElizaOS."""

from __future__ import annotations

from dataclasses import dataclass, field

from .services.edge_tts_service import EdgeTTSService
from .types import EdgeTTSSettings


@dataclass
class EdgeTTSPlugin:
    """Free text-to-speech using Microsoft Edge's TTS service. No API key required."""

    name: str = "edge-tts"
    description: str = (
        "Free text-to-speech synthesis using Microsoft Edge TTS - "
        "no API key required, high-quality neural voices"
    )

    settings: EdgeTTSSettings = field(default_factory=EdgeTTSSettings)

    _service: EdgeTTSService | None = field(default=None, init=False, repr=False)

    @property
    def service(self) -> EdgeTTSService:
        if self._service is None:
            self._service = EdgeTTSService(settings=self.settings)
        return self._service

    async def text_to_speech(self, text: str) -> bytes:
        return await self.service.text_to_speech(text)

    async def close(self) -> None:
        self._service = None


edge_tts_plugin = EdgeTTSPlugin()
