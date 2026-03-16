"""TTS directive parser.

Parses [[tts]] directives from text:
- ``[[tts]]`` — simple marker to enable TTS for this message
- ``[[tts:provider=elevenlabs]]`` — specify provider
- ``[[tts:voice=alloy]]`` — specify voice
- ``[[tts:text]]...[[/tts:text]]`` — specify exact text to synthesize
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Optional

from elizaos_plugin_tts.types import TtsDirective, TtsProvider

# ---------------------------------------------------------------------------
# Regex patterns (mirrors the TypeScript implementation)
# ---------------------------------------------------------------------------

# Matches [[tts]] or [[tts:key=value ...]]
TTS_DIRECTIVE_PATTERN = re.compile(r"\[\[tts(?::([^\]]+))?\]\]", re.IGNORECASE)

# Matches [[tts:text]]...[[/tts:text]]
TTS_TEXT_PATTERN = re.compile(
    r"\[\[tts:text\]\]([\s\S]*?)\[\[/tts:text\]\]", re.IGNORECASE
)

# Matches key=value pairs inside directive parameters
KEY_VALUE_PATTERN = re.compile(r"(\w+)\s*=\s*([^\s,]+)")


# ---------------------------------------------------------------------------
# Provider normalisation
# ---------------------------------------------------------------------------

_PROVIDER_ALIASES: dict[str, TtsProvider] = {
    "elevenlabs": TtsProvider.ELEVENLABS,
    "eleven": TtsProvider.ELEVENLABS,
    "xi": TtsProvider.ELEVENLABS,
    "openai": TtsProvider.OPENAI,
    "oai": TtsProvider.OPENAI,
    "edge": TtsProvider.EDGE,
    "microsoft": TtsProvider.EDGE,
    "ms": TtsProvider.EDGE,
    "simple": TtsProvider.SIMPLE_VOICE,
    "simple-voice": TtsProvider.SIMPLE_VOICE,
    "sam": TtsProvider.SIMPLE_VOICE,
}


def normalize_provider(raw: str) -> Optional[TtsProvider]:
    """Normalize a raw provider string into a :class:`TtsProvider`."""
    return _PROVIDER_ALIASES.get(raw.lower().strip())


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def has_tts_directive(text: str) -> bool:
    """Return ``True`` if *text* contains any TTS directive."""
    return bool(TTS_DIRECTIVE_PATTERN.search(text) or TTS_TEXT_PATTERN.search(text))


def parse_tts_directive(text: str) -> Optional[TtsDirective]:
    """Parse TTS directives from *text*.

    Returns a :class:`TtsDirective` populated with whatever options were found,
    or ``None`` if no directive is present.
    """
    if not has_tts_directive(text):
        return None

    directive = TtsDirective()

    # Extract [[tts:text]]...[[/tts:text]] content
    text_match = TTS_TEXT_PATTERN.search(text)
    if text_match:
        full_match = text_match.group(0)
        content_start = full_match.index("]]") + 2
        content_end = full_match.rindex("[[")
        directive.text = full_match[content_start:content_end].strip()

    # Parse [[tts:key=value]] directives
    for m in TTS_DIRECTIVE_PATTERN.finditer(text):
        params = m.group(1)
        if params:
            for kv in KEY_VALUE_PATTERN.finditer(params):
                key = kv.group(1).lower()
                value = kv.group(2)

                if key == "provider":
                    directive.provider = normalize_provider(value)
                elif key == "voice":
                    directive.voice = value
                elif key == "model":
                    directive.model = value
                elif key == "speed":
                    try:
                        directive.speed = float(value)
                    except ValueError:
                        pass

    return directive


@dataclass
class JsonVoiceDirectiveResult:
    """Result of parsing a JSON voice directive."""

    directive: TtsDirective
    cleaned_text: str


def parse_json_voice_directive(text: str) -> Optional[JsonVoiceDirectiveResult]:
    """Parse a JSON voice directive from the first line of the reply.

    Supports the openclaw-classic format::

        { "voice": "abc123", "once": true }
        Actual reply text here...

    Supported keys: voice/voice_id/voiceId, model/model_id/modelId,
    speed, rate.
    """
    first_newline = text.find("\n")
    if first_newline == -1:
        return None

    first_line = text[:first_newline].strip()
    if not first_line.startswith("{") or not first_line.endswith("}"):
        return None

    try:
        obj: dict[str, object] = json.loads(first_line)
    except (json.JSONDecodeError, ValueError):
        return None

    voice_keys = ["voice", "voice_id", "voiceId", "model", "model_id", "modelId", "speed", "rate"]
    if not any(k in obj for k in voice_keys):
        return None

    directive = TtsDirective()

    voice = obj.get("voice") or obj.get("voice_id") or obj.get("voiceId")
    if isinstance(voice, str):
        directive.voice = voice

    model = obj.get("model") or obj.get("model_id") or obj.get("modelId")
    if isinstance(model, str):
        directive.model = model

    speed = obj.get("speed") if isinstance(obj.get("speed"), (int, float)) else None
    if speed is None:
        rate = obj.get("rate")
        if isinstance(rate, (int, float)):
            speed = float(rate)
    if speed is not None:
        directive.speed = float(speed)

    cleaned_text = text[first_newline + 1 :].strip()
    return JsonVoiceDirectiveResult(directive=directive, cleaned_text=cleaned_text)


def strip_tts_directives(text: str) -> str:
    """Strip all TTS directives from *text*, returning clean text."""
    cleaned = text

    # Remove [[tts:text]]...[[/tts:text]] blocks
    cleaned = TTS_TEXT_PATTERN.sub("", cleaned)

    # Remove [[tts:...]] directives
    cleaned = TTS_DIRECTIVE_PATTERN.sub("", cleaned)

    # Clean up extra whitespace
    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    return cleaned


def get_tts_text(text: str, directive: Optional[TtsDirective]) -> str:
    """Get the text to synthesize from a message.

    If the directive contains explicit text, return that.
    Otherwise return the message with directives stripped.
    """
    if directive and directive.text:
        return directive.text
    return strip_tts_directives(text)
