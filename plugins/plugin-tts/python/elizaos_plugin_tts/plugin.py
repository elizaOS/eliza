"""Plugin TTS — Text-to-Speech coordinator for Eliza agents.

Provides a unified TTS interface that:
- Supports multiple providers (ElevenLabs, OpenAI, Edge, Simple Voice)
- Auto-selects providers based on available API keys
- Parses [[tts]] directives from messages
- Handles text processing and length limits
- Manages per-session TTS configuration
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from elizaos_plugin_tts.config import (
    clear_tts_config,
    get_tts_config,
    set_tts_config,
    should_apply_tts,
)
from elizaos_plugin_tts.directives import (
    get_tts_text,
    has_tts_directive,
    parse_json_voice_directive,
    parse_tts_directive,
    strip_tts_directives,
)
from elizaos_plugin_tts.text_processor import process_text_for_tts
from elizaos_plugin_tts.types import (
    TTS_PROVIDER_API_KEYS,
    TTS_PROVIDER_PRIORITY,
    TtsConfig,
    TtsProvider,
    TtsRequest,
    TtsResult,
)

logger = logging.getLogger("plugin-tts")

PLUGIN_NAME = "tts"
PLUGIN_DESCRIPTION = (
    "Text-to-speech coordinator with multi-provider support and [[tts]] directives"
)

PLUGIN_CONFIG = {
    "TTS_AUTO_MODE": "off",
    "TTS_DEFAULT_PROVIDER": "auto",
    "TTS_MAX_LENGTH": "1500",
    "TTS_SUMMARIZE": "true",
    "TTS_DEFAULT_VOICE": "",
}


# ---------------------------------------------------------------------------
# Provider availability helpers
# ---------------------------------------------------------------------------


def is_provider_available(runtime: Any, provider: TtsProvider) -> bool:
    """Check if a provider is available (has required API keys)."""
    if provider == TtsProvider.AUTO:
        return True

    required_keys = TTS_PROVIDER_API_KEYS[provider]
    if len(required_keys) == 0:
        return True

    get_setting = getattr(runtime, "get_setting", None)
    if get_setting is None:
        return False

    return any(
        (value := get_setting(key)) and str(value).strip() != ""
        for key in required_keys
    )


def get_best_provider(
    runtime: Any,
    preferred: Optional[TtsProvider] = None,
) -> TtsProvider:
    """Get the best available provider."""
    if (
        preferred is not None
        and preferred != TtsProvider.AUTO
        and is_provider_available(runtime, preferred)
    ):
        return preferred

    for provider in TTS_PROVIDER_PRIORITY:
        if is_provider_available(runtime, provider):
            return provider

    return TtsProvider.SIMPLE_VOICE


async def synthesize(runtime: Any, request: TtsRequest) -> TtsResult:
    """Synthesize text to speech."""
    provider = get_best_provider(runtime, request.provider)

    logger.debug("[TTS] Synthesizing with provider: %s", provider.value)

    params = {
        "text": request.text,
        "voice": request.voice,
        "model": request.model,
        "speed": request.speed,
        "provider": provider.value,
    }

    try:
        use_model = getattr(runtime, "use_model", None)
        if use_model is None:
            raise RuntimeError("Runtime does not support use_model")

        audio = await use_model("TEXT_TO_SPEECH", params)
        audio_bytes = audio if isinstance(audio, bytes) else bytes(audio)

        return TtsResult(
            audio=audio_bytes,
            format=request.format or "mp3",
            provider=provider,
        )
    except Exception as exc:
        logger.error("[TTS] Synthesis failed with %s: %s", provider.value, exc)
        raise


def format_tts_config(config: TtsConfig) -> str:
    """Format TTS configuration for display."""
    lines = [
        f"Auto: {config.auto.value}",
        f"Provider: {config.provider.value}",
        f"Max length: {config.max_length}",
        f"Summarize: {'yes' if config.summarize else 'no'}",
    ]
    if config.voice:
        lines.append(f"Voice: {config.voice}")
    return "\n".join(lines)
