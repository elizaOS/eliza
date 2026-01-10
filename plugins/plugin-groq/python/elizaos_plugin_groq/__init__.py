"""
elizaOS Groq Plugin - Fast LLM inference via Groq's LPU.

Provides text generation with Llama and other models, audio transcription,
and text-to-speech synthesis.
"""

__version__ = "1.0.4"

from elizaos_plugin_groq.client import GroqClient
from elizaos_plugin_groq.error import GroqError, GroqErrorCode
from elizaos_plugin_groq.types import (
    ChatMessage,
    GenerateObjectParams,
    GenerateTextParams,
    GroqConfig,
    MessageRole,
    TextToSpeechParams,
    TranscriptionParams,
)

__all__ = [
    "__version__",
    "GroqClient",
    "GroqConfig",
    "GenerateTextParams",
    "GenerateObjectParams",
    "TranscriptionParams",
    "TextToSpeechParams",
    "ChatMessage",
    "MessageRole",
    "GroqError",
    "GroqErrorCode",
]
