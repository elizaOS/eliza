"""Type definitions for the Simple Voice plugin."""

from dataclasses import dataclass


@dataclass
class SamTTSOptions:
    """SAM TTS Voice Configuration."""

    speed: int = 72
    """Speaking speed (20-200)"""

    pitch: int = 64
    """Voice pitch (0-255)"""

    throat: int = 128
    """Throat resonance (0-255)"""

    mouth: int = 128
    """Mouth articulation (0-255)"""


DEFAULT_SAM_OPTIONS = SamTTSOptions()

SPEECH_TRIGGERS = (
    "say aloud",
    "speak",
    "read aloud",
    "say out loud",
    "voice",
    "speak this",
    "say this",
    "read this",
    "announce",
    "proclaim",
    "tell everyone",
    "speak up",
    "use your voice",
    "talk to me",
    "higher voice",
    "lower voice",
    "change voice",
    "robotic voice",
    "retro voice",
)

VOCALIZATION_PATTERNS = (
    "can you say",
    "please say",
    "i want to hear",
    "let me hear",
)
