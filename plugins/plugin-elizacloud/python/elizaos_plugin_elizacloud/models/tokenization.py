"""Tokenization model handlers."""

import tiktoken

from elizaos_plugin_elizacloud.types import (
    DetokenizeTextParams,
    ElizaCloudConfig,
    TokenizeTextParams,
)


def _get_model_name(config: ElizaCloudConfig, model_type: str) -> str:
    """Get the actual model name based on model type."""
    if model_type == "TEXT_SMALL":
        return config.small_model
    return config.large_model


def _get_encoding(model_name: str) -> tiktoken.Encoding:
    """Get tiktoken encoding for a model, with fallback to cl100k_base."""
    try:
        return tiktoken.encoding_for_model(model_name)
    except KeyError:
        # Fallback to cl100k_base (used by GPT-4, GPT-3.5-turbo)
        return tiktoken.get_encoding("cl100k_base")


async def handle_tokenizer_encode(
    config: ElizaCloudConfig,
    params: TokenizeTextParams,
) -> list[int]:
    """Handle TEXT_TOKENIZER_ENCODE - tokenize text into token IDs.

    Args:
        config: ElizaOS Cloud configuration.
        params: Tokenization parameters with prompt and model type.

    Returns:
        List of token IDs.
    """
    model_name = _get_model_name(config, params.model_type)
    encoding = _get_encoding(model_name)
    return encoding.encode(params.prompt)


async def handle_tokenizer_decode(
    config: ElizaCloudConfig,
    params: DetokenizeTextParams,
) -> str:
    """Handle TEXT_TOKENIZER_DECODE - decode token IDs back to text.

    Args:
        config: ElizaOS Cloud configuration.
        params: Detokenization parameters with tokens and model type.

    Returns:
        Decoded text string.
    """
    model_name = _get_model_name(config, params.model_type)
    encoding = _get_encoding(model_name)
    return encoding.decode(params.tokens)





