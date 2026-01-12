from .actions.say_aloud import SayAloudAction, say_aloud_action
from .plugin import SimpleVoicePlugin, simple_voice_plugin
from .sam_engine import SamEngine
from .services.sam_tts_service import SamTTSService
from .types import DEFAULT_SAM_OPTIONS, SPEECH_TRIGGERS, VOCALIZATION_PATTERNS, SamTTSOptions

__version__ = "0.1.0"
__all__ = [
    "SamTTSOptions",
    "DEFAULT_SAM_OPTIONS",
    "SPEECH_TRIGGERS",
    "VOCALIZATION_PATTERNS",
    "SamEngine",
    "SamTTSService",
    "SayAloudAction",
    "say_aloud_action",
    "SimpleVoicePlugin",
    "simple_voice_plugin",
]
