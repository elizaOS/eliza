"""Preserves complete model inputs while enforcing explicit token boundaries."""

from __future__ import annotations

from typing import Any


def tokenize_with_explicit_limit(
    tokenizer: Any,
    text: str | list[str],
    *,
    max_tokens: int,
    **kwargs: Any,
) -> Any:
    """Tokenize without mutation and reject input that exceeds ``max_tokens``."""
    if max_tokens <= 0:
        raise ValueError(f"max_tokens must be positive, received {max_tokens}")
    if "truncation" in kwargs or "max_length" in kwargs:
        raise ValueError("tokenization truncation options are forbidden")

    if kwargs.get("padding") == "max_length":
        kwargs["max_length"] = max_tokens
    encoded = tokenizer(text, truncation=False, **kwargs)
    input_ids = encoded["input_ids"]
    shape = getattr(input_ids, "shape", None)
    if shape is not None:
        observed = int(shape[-1])
    elif (
        isinstance(input_ids, list)
        and input_ids
        and isinstance(input_ids[0], list)
    ):
        observed = max(len(row) for row in input_ids)
    else:
        observed = len(input_ids)
    if observed > max_tokens:
        raise ValueError(
            f"Model input exceeds the configured token boundary "
            f"({observed} > {max_tokens}); the prompt was not truncated"
        )
    return encoded
