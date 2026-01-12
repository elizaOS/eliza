import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

from ..services.sam_tts_service import SamTTSService
from ..types import SPEECH_TRIGGERS, VOCALIZATION_PATTERNS, SamTTSOptions

logger = logging.getLogger(__name__)


class Memory(Protocol):
    @property
    def content(self) -> dict[str, object]: ...


class Runtime(Protocol):
    def get_service(self, service_type: str) -> object | None: ...


def extract_text_to_speak(message_text: str) -> str:
    text = message_text.lower().strip()

    for pattern in [
        r'say ["\']([^"\']+)["\']',
        r'speak ["\']([^"\']+)["\']',
        r'read ["\']([^"\']+)["\']',
        r'announce ["\']([^"\']+)["\']',
        r'["\']([^"\']+)["\']',
    ]:
        if match := re.search(pattern, text):
            return match.group(1)

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
    name: str = "SAY_ALOUD"
    description: str = "Speak text aloud using SAM retro speech synthesizer"
    examples: list[list[dict[str, str | dict[str, str | object]]]] = field(
        default_factory=lambda: [
            [
                {"name": "{{user1}}", "content": {"text": "Can you say hello out loud?"}},
                {
                    "name": "{{agent}}",
                    "content": {"text": "I'll say hello.", "action": "SAY_ALOUD"},
                },
            ],
        ]
    )

    async def validate(self, runtime: Runtime, message: Memory) -> bool:
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
        callback: Callable[[dict[str, str | list[int]]], Awaitable[None]] | None = None,
    ) -> None:
        logger.info("[SAY_ALOUD] Processing speech request")

        sam_service = runtime.get_service("SAM_TTS")
        if not isinstance(sam_service, SamTTSService):
            raise RuntimeError("SAM TTS service not available")

        text_to_speak = extract_text_to_speak(message.content.get("text", ""))
        voice_options = extract_voice_options(message.content.get("text", ""))

        logger.info(f'[SAY_ALOUD] Speaking: "{text_to_speak}"')

        audio = await sam_service.speak_text(text_to_speak, voice_options)

        if callback:
            await callback(
                {
                    "text": f'I spoke: "{text_to_speak}"',
                    "action": "SAY_ALOUD",
                    "audioData": list(audio),
                }
            )


say_aloud_action = SayAloudAction()
