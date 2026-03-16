"""Edge TTS plugin definition for elizaOS."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .services.edge_tts_service import EdgeTTSService
from .types import EdgeTTSSettings

if TYPE_CHECKING:
    pass


@dataclass
class EdgeTTSPlugin:
    """Edge TTS plugin for elizaOS.

    Provides free text-to-speech synthesis using Microsoft Edge's TTS service.
    No API key required - uses the same TTS engine as Microsoft Edge browser.

    Features:
        - High-quality neural voices
        - Multiple languages and locales
        - Adjustable rate, pitch, and volume
        - No API key or payment required
        - Voice presets compatible with OpenAI voice names
    """

    name: str = "edge-tts"
    description: str = (
        "Free text-to-speech synthesis using Microsoft Edge TTS - "
        "no API key required, high-quality neural voices"
    )

    settings: EdgeTTSSettings = field(default_factory=EdgeTTSSettings)

    _service: EdgeTTSService | None = field(default=None, init=False, repr=False)

    @property
    def service(self) -> EdgeTTSService:
        """Get the Edge TTS service instance."""
        if self._service is None:
            self._service = EdgeTTSService(settings=self.settings)
        return self._service

    async def text_to_speech(self, text: str) -> bytes:
        """Convert text to speech.

        Args:
            text: The text to convert to speech.

        Returns:
            Audio data as bytes.
        """
        return await self.service.text_to_speech(text)

    async def close(self) -> None:
        """Close the plugin and release resources."""
        self._service = None


# Default plugin instance
edge_tts_plugin = EdgeTTSPlugin()
