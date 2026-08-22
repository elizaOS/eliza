"""Tests lossless tokenization with a deterministic fake tokenizer."""

from __future__ import annotations

import pytest

from training.tokenization import tokenize_with_explicit_limit


class FakeTensor:
    def __init__(self, length: int) -> None:
        self.shape = (1, length)


class FakeTokenizer:
    def __init__(self) -> None:
        self.received_truncation: bool | None = None

    def __call__(self, text: str, *, truncation: bool, **_: object) -> dict[str, FakeTensor]:
        self.received_truncation = truncation
        return {"input_ids": FakeTensor(len(text))}


def test_preserves_complete_input_within_limit() -> None:
    tokenizer = FakeTokenizer()
    encoded = tokenize_with_explicit_limit(
        tokenizer,
        "complete",
        max_tokens=8,
        return_tensors="pt",
    )

    assert tokenizer.received_truncation is False
    assert encoded["input_ids"].shape[-1] == 8


def test_rejects_oversized_input_instead_of_truncating() -> None:
    tokenizer = FakeTokenizer()

    with pytest.raises(ValueError, match="prompt was not truncated"):
        tokenize_with_explicit_limit(
            tokenizer,
            "complete",
            max_tokens=7,
            return_tensors="pt",
        )

    assert tokenizer.received_truncation is False
