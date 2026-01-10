"""Simple Voice Plugin - Retro TTS using SAM Speech Synthesizer."""

from dataclasses import dataclass, field

from .actions.say_aloud import SayAloudAction, say_aloud_action
from .services.sam_tts_service import SamTTSService


@dataclass
class SimpleVoicePlugin:
    """Simple Voice Plugin - Retro SAM TTS with hardware bridge integration."""

    name: str = "@elizaos/plugin-simple-voice"
    description: str = "Retro text-to-speech using SAM Speech Synthesizer"
    actions: list[SayAloudAction] = field(default_factory=lambda: [say_aloud_action])
    services: list[type[SamTTSService]] = field(default_factory=lambda: [SamTTSService])


simple_voice_plugin = SimpleVoicePlugin()
