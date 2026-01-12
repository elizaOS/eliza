from dataclasses import dataclass


@dataclass
class SamTTSOptions:
    speed: int = 72
    pitch: int = 64
    throat: int = 128
    mouth: int = 128


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
