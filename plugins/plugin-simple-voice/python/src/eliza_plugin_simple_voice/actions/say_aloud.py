"""SAY_ALOUD Action - Speak text using SAM synthesizer."""

import re
import logging
from dataclasses import dataclass, field
from typing import Protocol, Any, Callable, Awaitable

from ..types import SamTTSOptions, SPEECH_TRIGGERS, VOCALIZATION_PATTERNS
from ..services.sam_tts_service import SamTTSService

logger = logging.getLogger(__name__)


class Memory(Protocol):
    """Memory protocol."""

    @property
    def content(self) -> dict[str, Any]: ...


class Runtime(Protocol):
    """Runtime protocol."""

    def get_service(self, service_type: str) -> object | None: ...


def extract_text_to_speak(message_text: str) -> str:
    """Extract text to speak from user message."""
    text = message_text.lower().strip()

    # Try quoted text
    for pattern in [
        r'say ["\']([^"\']+)["\']',
        r'speak ["\']([^"\']+)["\']',
        r'read ["\']([^"\']+)["\']',
        r'announce ["\']([^"\']+)["\']',
        r'["\']([^"\']+)["\']',
    ]:
        if match := re.search(pattern, text):
            return match.group(1)

    # Try text after keywords
    for pattern in [
        r"(?:say|speak|read)\s+(?:aloud\s+)?(?:this\s+)?:?\s*(.+)$",
        r"(?:can you|please)\s+(?:say|speak|read)\s+(?:aloud\s+)?(.+)$",
        r"(?:i want to hear|let me hear)\s+(.+)$",
        r"(?:read this|say this|speak this)\s*:?\s*(.+)$",
    ]:
        if match := re.search(pattern, text):
            result = match.group(1).strip()
            result = re.sub(r"\s+(out loud|aloud|please)$", "", result)
            return result.strip()

    return text


def extract_voice_options(message_text: str) -> SamTTSOptions:
    """Extract voice options from user message."""
    text = message_text.lower()
    options = SamTTSOptions()

    if any(p in text for p in ("higher voice", "high pitch", "squeaky")):
        options.pitch = 100
    elif any(p in text for p in ("lower voice", "low pitch", "deep voice")):
        options.pitch = 30

    if any(p in text for p in ("faster", "quickly", "speed up")):
        options.speed = 120
    elif any(p in text for p in ("slower", "slowly", "slow down")):
        options.speed = 40

    if any(p in text for p in ("robotic", "robot voice")):
        options.throat = 200
        options.mouth = 50
    elif any(p in text for p in ("smooth", "natural")):
        options.throat = 100
        options.mouth = 150

    return options


@dataclass
class SayAloudAction:
    """SAY_ALOUD Action - Speaks text using SAM synthesizer."""

    name: str = "SAY_ALOUD"
    description: str = "Speak text aloud using SAM retro speech synthesizer"
    examples: list[list[dict[str, Any]]] = field(default_factory=lambda: [
        [
            {"name": "{{user1}}", "content": {"text": "Can you say hello out loud?"}},
            {"name": "{{agent}}", "content": {"text": "I'll say hello.", "action": "SAY_ALOUD"}},
        ],
    ])

    async def validate(self, runtime: Runtime, message: Memory) -> bool:
        """Check if action should trigger."""
        text = message.content.get("text", "").lower()

        has_trigger = any(t in text for t in SPEECH_TRIGGERS)
        has_intent = (
            any(p in text for p in VOCALIZATION_PATTERNS)
            or re.search(r'say ["\'].*["\']', text) is not None
            or re.search(r'speak ["\'].*["\']', text) is not None
        )

        return has_trigger or has_intent

    async def handler(
        self,
        runtime: Runtime,
        message: Memory,
        callback: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> None:
        """Handle the SAY_ALOUD action."""
        logger.info("[SAY_ALOUD] Processing speech request")

        sam_service = runtime.get_service("SAM_TTS")
        if not isinstance(sam_service, SamTTSService):
            raise RuntimeError("SAM TTS service not available")

        text_to_speak = extract_text_to_speak(message.content.get("text", ""))
        voice_options = extract_voice_options(message.content.get("text", ""))

        logger.info(f'[SAY_ALOUD] Speaking: "{text_to_speak}"')

        audio = await sam_service.speak_text(text_to_speak, voice_options)

        if callback:
            await callback({
                "text": f'I spoke: "{text_to_speak}"',
                "action": "SAY_ALOUD",
                "audioData": list(audio),
            })


say_aloud_action = SayAloudAction()
