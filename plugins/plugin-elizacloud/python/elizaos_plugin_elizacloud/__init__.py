"""
elizaOS Cloud Plugin - Multi-model AI generation for elizaOS.

This package provides AI model handlers for elizaOS agents using
the ElizaOS Cloud API for text, embeddings, images, and audio.

Features:
- Text generation (small and large models)
- Structured object generation (small and large models)
- Text embeddings with batch support
- Image generation and description
- Text-to-speech generation
- Audio transcription
- Tokenization utilities
"""

__version__ = "1.7.4"

from elizaos_plugin_elizacloud.models import (
    handle_text_small,
    handle_text_large,
    handle_object_small,
    handle_object_large,
    handle_text_embedding,
    handle_batch_text_embedding,
    handle_image_generation,
    handle_image_description,
    handle_text_to_speech,
    handle_transcription,
    handle_tokenizer_encode,
    handle_tokenizer_decode,
)
from elizaos_plugin_elizacloud.providers import ElizaCloudClient
from elizaos_plugin_elizacloud.types import (
    ElizaCloudConfig,
    TextGenerationParams,
    ObjectGenerationParams,
    TextEmbeddingParams,
    ImageGenerationParams,
    ImageDescriptionParams,
    ImageDescriptionResult,
    TextToSpeechParams,
    TranscriptionParams,
    TokenizeTextParams,
    DetokenizeTextParams,
)

__all__ = [
    # Version
    "__version__",
    # Client
    "ElizaCloudClient",
    # Types
    "ElizaCloudConfig",
    "TextGenerationParams",
    "ObjectGenerationParams",
    "TextEmbeddingParams",
    "ImageGenerationParams",
    "ImageDescriptionParams",
    "ImageDescriptionResult",
    "TextToSpeechParams",
    "TranscriptionParams",
    "TokenizeTextParams",
    "DetokenizeTextParams",
    # Model Handlers - Text
    "handle_text_small",
    "handle_text_large",
    # Model Handlers - Object
    "handle_object_small",
    "handle_object_large",
    # Model Handlers - Embeddings
    "handle_text_embedding",
    "handle_batch_text_embedding",
    # Model Handlers - Image
    "handle_image_generation",
    "handle_image_description",
    # Model Handlers - Audio
    "handle_text_to_speech",
    "handle_transcription",
    # Model Handlers - Tokenization
    "handle_tokenizer_encode",
    "handle_tokenizer_decode",
]


def get_plugin() -> dict[str, object]:
    """Get the ElizaOS Cloud plugin definition for elizaOS."""
    return {
        "name": "@elizaos/plugin-elizacloud",
        "description": "ElizaOS Cloud plugin - Multi-model AI generation with text, image, and audio support",
        "version": __version__,
        "models": {
            "TEXT_SMALL": handle_text_small,
            "TEXT_LARGE": handle_text_large,
            "OBJECT_SMALL": handle_object_small,
            "OBJECT_LARGE": handle_object_large,
            "TEXT_EMBEDDING": handle_text_embedding,
            "IMAGE": handle_image_generation,
            "IMAGE_DESCRIPTION": handle_image_description,
            "TEXT_TO_SPEECH": handle_text_to_speech,
            "TRANSCRIPTION": handle_transcription,
            "TEXT_TOKENIZER_ENCODE": handle_tokenizer_encode,
            "TEXT_TOKENIZER_DECODE": handle_tokenizer_decode,
        },
    }
