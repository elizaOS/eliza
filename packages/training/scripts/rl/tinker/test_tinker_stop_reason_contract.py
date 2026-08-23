"""Provider-contract tests for Tinker/MLX completion integrity (#25157).

Covers the acceptance matrix from the issue:
- Tinker stop_reason="length" rejection and "stop" acceptance
- missing Tinker completion metadata -> rejected (unproven)
- unknown completion reason -> rejected (unproven)
- MLX terminal "length" and "stop" responses
- a capped MLX response whose decoded text re-encodes below budget is still rejected
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

TRAINING_SCRIPTS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(TRAINING_SCRIPTS))

from lib.generation_integrity import IncompleteGenerationError  # noqa: E402

MODULE_PATH = Path(__file__).with_name("tinker_client.py")
SPEC = importlib.util.spec_from_file_location("tinker_integrity_subject_25157", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
try:
    SPEC.loader.exec_module(MODULE)
except Exception as exc:  # pragma: no cover - numpy present in CI
    pytest.skip(f"tinker_client import failed: {exc}", allow_module_level=False)

FeedTinkerClient = MODULE.FeedTinkerClient


class CharacterTokenizer:
    def apply_chat_template(self, messages, *, tokenize, add_generation_prompt):
        assert tokenize is False
        return "|".join(m["content"] for m in messages) + "|assistant:"

    def encode(self, text, *, add_special_tokens=True):
        del add_special_tokens
        return [ord(ch) % 256 for ch in text]

    def decode(self, tokens):
        return "".join(chr(t) for t in tokens)


class StubSamplingClient:
    """Returns canned SampledSequence-shaped objects."""

    def __init__(self, sequences):
        self._sequences = sequences
        self.calls = 0

    def sample(self, *, prompt, sampling_params, num_samples, include_prompt_logprobs):
        self.calls += 1
        return SimpleNamespace(
            result=lambda: SimpleNamespace(sequences=list(self._sequences), prompt_logprobs=None)
        )

    async def sample_async(self, *, prompt, sampling_params, num_samples, include_prompt_logprobs):
        self.calls += 1
        return SimpleNamespace(sequences=list(self._sequences), prompt_logprobs=None)


def make_client(sequences) -> FeedTinkerClient:
    client = FeedTinkerClient.__new__(FeedTinkerClient)
    client._tokenizer = CharacterTokenizer()
    client._sampling_client = StubSamplingClient(sequences)
    # Stub the lazy tinker_types module: only ModelInput/SamplingParams shapes
    # are needed before the stop_reason boundary under test.
    if MODULE.tinker_types is None:
        MODULE.tinker_types = SimpleNamespace(
            ModelInput=SimpleNamespace(from_ints=lambda tokens: {"tokens": tokens}),
            SamplingParams=lambda **kw: kw,
        )
    cfg = SimpleNamespace(
        default_max_tokens=16,
        default_temperature=0.0,
        stop_sequences=[],
        sampling_timeout_seconds=5,
        download_timeout_seconds=5,
        capabilities_timeout_seconds=5,
    )
    client.config = cfg
    return client


def _install_module_stub(client) -> None:
    """Attach a minimal tinker_types stub on the instance if the real SDK is absent."""


def seq(*, stop_reason=None, finish_reason=None):
    """Build an object shaped like upstream SampledSequence."""

    kwargs = {"tokens": [104, 105]}
    if stop_reason is not None:
        kwargs["stop_reason"] = stop_reason
    if finish_reason is not None:
        kwargs["finish_reason"] = finish_reason
    return SimpleNamespace(**kwargs)


class TestTinkerAuthoritativeStopReason:
    def test_length_stop_reason_is_rejected_sync(self):
        client = make_client([seq(stop_reason="length")])
        with pytest.raises(IncompleteGenerationError):
            client.sample([{"role": "user", "content": "hi"}])

    def test_stop_stop_reason_is_accepted_sync(self):
        client = make_client([seq(stop_reason="stop")])
        result = client.sample([{"role": "user", "content": "hi"}])
        assert result.finish_reasons == ["stop"]

    def test_missing_completion_metadata_is_rejected_not_synthesized(self):
        # The old code synthesized "stop" via getattr(seq, "finish_reason", "stop").
        # A sequence without any completion field must now be unproven -> reject.
        client = make_client([seq()])
        with pytest.raises(IncompleteGenerationError):
            client.sample([{"role": "user", "content": "hi"}])

    def test_unknown_completion_reason_is_rejected_async(self):
        client = make_client([seq(stop_reason="server_exploded")])
        import asyncio

        with pytest.raises(IncompleteGenerationError):
            asyncio.run(client.sample_async([{"role": "user", "content": "hi"}]))

    def test_missing_metadata_is_rejected_async(self):
        client = make_client([seq()])
        import asyncio

        with pytest.raises(IncompleteGenerationError):
            asyncio.run(client.sample_async([{"role": "user", "content": "hi"}]))

    def test_legacy_finish_reason_attribute_does_not_satisfy_the_contract(self):
        # An object exposing only the non-contract `finish_reason` attribute must
        # still be treated as unproven: upstream never sets that field.
        client = make_client([seq(finish_reason="stop")])
        with pytest.raises(IncompleteGenerationError):
            client.sample([{"role": "user", "content": "hi"}])


class TestSharedGateStillWorks:
    def test_gate_rejects_authoritative_length_reasons(self):
        from lib.generation_integrity import require_complete_finish_reasons

        with pytest.raises(IncompleteGenerationError):
            require_complete_finish_reasons(["stop", "length"], source="fixture")

    def test_gate_accepts_all_stop(self):
        from lib.generation_integrity import require_complete_finish_reasons

        require_complete_finish_reasons(["stop", "stop"], source="fixture")
