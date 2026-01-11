"""
Tokenization utilities for OpenAI models.

Uses tiktoken for accurate token counting and encoding.
"""

from functools import lru_cache

import tiktoken
from tiktoken import Encoding


@lru_cache(maxsize=16)
def get_encoding_for_model(model_name: str) -> Encoding:
    """
    Get the appropriate tokenizer encoding for a model.

    Falls back to appropriate default encoding if the model isn't recognized:
    - Models containing "4o" use o200k_base (GPT-4o encoding)
    - Other models use cl100k_base (GPT-3.5/GPT-4 encoding)

    Args:
        model_name: The name of the model.

    Returns:
        The tiktoken Encoding for the model.
    """
    try:
        return tiktoken.encoding_for_model(model_name)
    except KeyError:
        # Fall back based on model name patterns
        if "4o" in model_name.lower():
            return tiktoken.get_encoding("o200k_base")
        return tiktoken.get_encoding("cl100k_base")


def tokenize(text: str, model: str = "gpt-5") -> list[int]:
    """
    Tokenize text into token IDs.

    Args:
        text: The text to tokenize.
        model: The model whose tokenizer to use.

    Returns:
        List of token IDs.
    """
    encoding = get_encoding_for_model(model)
    return encoding.encode(text)


def detokenize(tokens: list[int], model: str = "gpt-5") -> str:
    """
    Decode token IDs back to text.

    Args:
        tokens: The token IDs to decode.
        model: The model whose tokenizer to use.

    Returns:
        The decoded text.
    """
    encoding = get_encoding_for_model(model)
    return encoding.decode(tokens)


def count_tokens(text: str, model: str = "gpt-5") -> int:
    """
    Count the number of tokens in text.

    Args:
        text: The text to count tokens for.
        model: The model whose tokenizer to use.

    Returns:
        The number of tokens.
    """
    return len(tokenize(text, model))


def truncate_to_token_limit(text: str, max_tokens: int, model: str = "gpt-5") -> str:
    """
    Truncate text to fit within a token limit.

    Args:
        text: The text to truncate.
        max_tokens: Maximum number of tokens.
        model: The model whose tokenizer to use.

    Returns:
        The truncated text.
    """
    tokens = tokenize(text, model)
    if len(tokens) <= max_tokens:
        return text
    return detokenize(tokens[:max_tokens], model)
