"""Model handlers for elizaOS Cloud Plugin."""

from elizaos_plugin_elizacloud.models.text import handle_text_small, handle_text_large
from elizaos_plugin_elizacloud.models.object import handle_object_small, handle_object_large
from elizaos_plugin_elizacloud.models.embeddings import (
    handle_text_embedding,
    handle_batch_text_embedding,
)
from elizaos_plugin_elizacloud.models.image import (
    handle_image_generation,
    handle_image_description,
)
from elizaos_plugin_elizacloud.models.speech import handle_text_to_speech
from elizaos_plugin_elizacloud.models.transcription import handle_transcription
from elizaos_plugin_elizacloud.models.tokenization import (
    handle_tokenizer_encode,
    handle_tokenizer_decode,
)

__all__ = [
    # Text generation
    "handle_text_small",
    "handle_text_large",
    # Object generation
    "handle_object_small",
    "handle_object_large",
    # Embeddings
    "handle_text_embedding",
    "handle_batch_text_embedding",
    # Image
    "handle_image_generation",
    "handle_image_description",
    # Audio
    "handle_text_to_speech",
    "handle_transcription",
    # Tokenization
    "handle_tokenizer_encode",
    "handle_tokenizer_decode",
]
