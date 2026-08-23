"""Tests that Tinker training admission preserves or rejects complete rows."""

import importlib.util
import sys
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).with_name("tinker_client.py")
SPEC = importlib.util.spec_from_file_location("tinker_integrity_subject", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
FeedTinkerClient = MODULE.FeedTinkerClient


class CharacterTokenizer:
    def apply_chat_template(self, messages, *, tokenize, add_generation_prompt):
        assert tokenize is False
        assert add_generation_prompt is True
        return "|".join(message["content"] for message in messages) + "|assistant:"

    def encode(self, text, *, add_special_tokens=True):
        del add_special_tokens
        return [ord(character) for character in text]


def client_with_tokenizer() -> FeedTinkerClient:
    client = FeedTinkerClient.__new__(FeedTinkerClient)
    client._tokenizer = CharacterTokenizer()
    return client


def test_prepare_datum_preserves_first_middle_and_last_sentinels() -> None:
    client = client_with_tokenizer()
    prompt = "FIRST-" + ("p" * 50) + "-MIDDLE-" + ("q" * 50) + "-LAST"
    completion = "RESPONSE-FIRST-" + ("r" * 50) + "-RESPONSE-LAST"

    datum = client.prepare_datum(
        [{"role": "user", "content": prompt}], completion, max_sequence_length=1_000
    )
    recovered = "".join(chr(token) for token in [*datum.input_tokens, datum.target_tokens[-1]])

    assert "FIRST-" in recovered
    assert "-MIDDLE-" in recovered
    assert "-LAST" in recovered
    assert "RESPONSE-FIRST-" in recovered
    assert "-RESPONSE-LAST" in recovered


def test_prepare_datum_rejects_oversized_complete_row_without_slicing() -> None:
    client = client_with_tokenizer()

    with pytest.raises(ValueError, match="TRAINING_ROW_SEQUENCE_LIMIT_EXCEEDED"):
        client.prepare_datum(
            [{"role": "user", "content": "FIRST-MIDDLE-LAST"}],
            "COMPLETE-RESPONSE",
            max_sequence_length=8,
        )


def test_prepare_datum_from_tokens_rejects_oversized_row_without_slicing() -> None:
    client = client_with_tokenizer()

    with pytest.raises(ValueError, match="TRAINING_ROW_SEQUENCE_LIMIT_EXCEEDED"):
        client.prepare_datum_from_tokens(
            list(range(12)), [-100, *range(11)], max_sequence_length=8
        )
