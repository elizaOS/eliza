"""Persona pool for the action-trajectory harness.

Eight personas, each with 0-3 prior memory turns. The personas vary by
register, language fluency, and verbosity. Memory entries simulate
realistic prior conversation context that primes the agent for the
current message.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Persona:
    name: str
    register: str  # "casual" | "formal" | "terse" | "verbose" | "non-native" | ...
    language: str  # primary language code
    memory_entries: tuple[dict[str, Any], ...] = field(default_factory=tuple)


# Eight personas, mixed register/language/memory depth.
PERSONAS: tuple[Persona, ...] = (
    Persona(
        name="alex",
        register="casual",
        language="en",
        memory_entries=(),
    ),
    Persona(
        name="sam",
        register="terse",
        language="en",
        memory_entries=(
            {"role": "user", "speaker": "sam", "content": "yo", "channel": "chat"},
            {"role": "assistant", "speaker": "milady", "content": "Hey, what's up?", "channel": "chat"},
        ),
    ),
    Persona(
        name="dr_chen",
        register="formal",
        language="en",
        memory_entries=(
            {"role": "user", "speaker": "dr_chen", "content": "Good morning. I have a small task for you.", "channel": "dm"},
            {"role": "assistant", "speaker": "milady", "content": "Good morning. I'm ready to help.", "channel": "dm"},
        ),
    ),
    Persona(
        name="priya",
        register="casual",
        language="es",
        memory_entries=(
            {"role": "user", "speaker": "priya", "content": "hola, cómo va", "channel": "chat"},
            {"role": "assistant", "speaker": "milady", "content": "¡Hola! Todo bien por aquí.", "channel": "chat"},
        ),
    ),
    Persona(
        name="kenji",
        register="terse",
        language="ja",
        memory_entries=(
            {"role": "user", "speaker": "kenji", "content": "おはよう", "channel": "chat"},
            {"role": "assistant", "speaker": "milady", "content": "おはようございます。", "channel": "chat"},
        ),
    ),
    Persona(
        name="luiza",
        register="verbose",
        language="pt",
        memory_entries=(),
    ),
    Persona(
        name="wei",
        register="formal",
        language="zh",
        memory_entries=(
            {"role": "user", "speaker": "wei", "content": "你好,有时间吗?", "channel": "dm"},
            {"role": "assistant", "speaker": "milady", "content": "你好,我在。", "channel": "dm"},
            {"role": "user", "speaker": "wei", "content": "好的,稍等一下。", "channel": "dm"},
        ),
    ),
    Persona(
        name="taylor",
        register="impatient",
        language="en",
        memory_entries=(
            {"role": "user", "speaker": "taylor", "content": "ok this is the third time I'm asking", "channel": "chat"},
            {"role": "assistant", "speaker": "milady", "content": "Sorry — let's get this sorted.", "channel": "chat"},
        ),
    ),
)


def by_name(name: str) -> Persona:
    for p in PERSONAS:
        if p.name == name:
            return p
    raise KeyError(f"unknown persona: {name}")


def by_language(lang: str) -> list[Persona]:
    return [p for p in PERSONAS if p.language == lang]
