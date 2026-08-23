"""MLX contract tests: authoritative finish_reason drives admission (#25157).

Mocks mlx_lm.stream_generate with responses shaped exactly like the upstream
GenerationResponse (mlx_lm/generate.py @ d78bf58e):
  - token: single int per response
  - finish_reason: None on intermediate responses; "stop"/"length" on the final one

The LocalTextGenerator under test is exercised through generate_messages() with
backend="mlx"; mlx_lm itself is stubbed before import.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

TRAINING_SCRIPTS = Path(__file__).resolve().parents[1]


class FakeTokenizer:
    eos_token_id = 2

    def encode(self, text, *, add_special_tokens=True):
        del add_special_tokens
        return [ord(ch) % 256 for ch in text]

    def decode(self, ids, skip_special_tokens=True):
        del skip_special_tokens
        return "".join(chr(i % 256) for i in ids)

    def apply_chat_template(self, messages, *, tokenize, add_generation_prompt):
        assert tokenize is False
        return "|".join(m["content"] for m in messages)


def install_mlx_stub(monkeypatch, segments, final_reason):
    """Stub mlx_lm modules so local_inference can import without the real package."""

    class FakeDetokenizer:
        def __init__(self):
            self.text = ""

        def add_token(self, token):
            self.text += chr(token % 256)

    class FakeTokenizerWrapper:
        def __init__(self, inner):
            self.inner = inner
            self.eos_token_ids = {inner.eos_token_id}
            self.detokenizer = FakeDetokenizer()

    def stream_generate(model, tokenizer, prompt=None, max_tokens=256, sampler=None, **kw):
        del prompt, max_tokens, sampler, kw
        wrapped = tokenizer if isinstance(tokenizer, FakeTokenizerWrapper) else FakeTokenizerWrapper(tokenizer)
        for tok in segments:
            yield SimpleNamespace(
                text=chr(tok % 256),
                token=tok,
                logprobs=None,
                from_draft=False,
                prompt_tokens=1,
                prompt_tps=1.0,
                generation_tokens=len(segments),
                generation_tps=1.0,
                peak_memory=0.0,
                finish_reason=None,
            )
        # Final response repeats the last token and carries the authoritative reason.
        yield SimpleNamespace(
            text="",
            token=segments[-1] if segments else 0,
            logprobs=None,
            from_draft=False,
            prompt_tokens=1,
            prompt_tps=1.0,
            generation_tokens=len(segments),
            generation_tps=1.0,
            peak_memory=0.0,
            finish_reason=final_reason,
        )

    mlx_lm = SimpleNamespace(generate=lambda *a, **k: "", load=lambda *a, **k: (None, None))
    monkeypatch.setitem(sys.modules, "mlx_lm", mlx_lm)
    monkeypatch.setitem(
        sys.modules,
        "mlx_lm.generate",
        SimpleNamespace(stream_generate=stream_generate),
    )
    monkeypatch.setitem(sys.modules, "mlx_lm.sample_utils", SimpleNamespace())


def load_module():
    spec = importlib.util.spec_from_file_location(
        "local_inference_subject_25157",
        TRAINING_SCRIPTS / "rl" / "local_inference.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def local_module():
    return load_module()


def make_generator(local_module, tokenizer):
    gen = local_module.LocalTextGenerator.__new__(local_module.LocalTextGenerator)
    gen.backend = "mlx"
    gen.model_ref = "fake/model"
    gen.model = SimpleNamespace(config=SimpleNamespace(), generation_config=None)
    gen.tokenizer = tokenizer
    gen.device = "cpu"
    gen.adapter_path = None
    gen.cache_implementation = "dynamic"
    gen.turboquant_settings = None
    gen._sampler = None
    return gen


class TestMlxAuthoritativeFinishReason:
    def test_terminal_length_is_rejected_even_when_text_roundtrips_short(
        self, local_module, monkeypatch
    ):
        # Capped response whose decoded text would re-encode BELOW max_new_tokens:
        # only the authoritative "length" proves truncation.
        tokenizer = FakeTokenizer()
        install_mlx_stub(monkeypatch, [104, 105], final_reason="length")
        gen = make_generator(local_module, tokenizer)
        with pytest.raises(local_module.IncompleteGenerationError):
            gen.generate_messages([{"role": "user", "content": "hi"}], max_new_tokens=120)

    def test_terminal_stop_is_accepted(self, local_module, monkeypatch):
        tokenizer = FakeTokenizer()
        install_mlx_stub(monkeypatch, [104, 105, 2], final_reason="stop")
        gen = make_generator(local_module, tokenizer)
        out = gen.generate_messages([{"role": "user", "content": "hi"}], max_new_tokens=120)
        assert isinstance(out, str)

    def test_missing_final_reason_counts_as_unproven_budget_stop(
        self, local_module, monkeypatch
    ):
        # If no authoritative terminal signal ever arrives, the existing token
        # budget gate must fire on real ids rather than re-encoded text.
        tokenizer = FakeTokenizer()
        install_mlx_stub(monkeypatch, list(range(50)), final_reason=None)
        gen = make_generator(local_module, tokenizer)
        with pytest.raises(local_module.IncompleteGenerationError):
            gen.generate_messages([{"role": "user", "content": "hi"}], max_new_tokens=10)

    def test_token_ids_come_from_responses_not_reencoded_text(
        self, local_module, monkeypatch, capsys
    ):
        # The gate must consume the streamed token ints; if it re-encoded text,
        # a stripped/normalized decode would change the count and could pass.
        tokenizer = FakeTokenizer()
        captured: dict[str, object] = {}
        original_gate = local_module.require_complete_generated_tokens

        def spy(ids, **kw):
            captured["ids"] = list(ids)
            return original_gate(ids, **kw)

        monkeypatch.setattr(local_module, "require_complete_generated_tokens", spy)
        install_mlx_stub(monkeypatch, [104, 105], final_reason="stop")
        gen = make_generator(local_module, tokenizer)
        gen.generate_messages([{"role": "user", "content": "hi"}], max_new_tokens=120)
        assert captured["ids"] == [104, 105]
