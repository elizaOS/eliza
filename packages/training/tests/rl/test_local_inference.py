from __future__ import annotations

import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "training"))

from local_inference import LocalTextGenerator, clean_generated_text, restore_assistant_prefix
from turboquant import TurboQuantSettings


def test_clean_generated_text_strips_chat_role_artifacts() -> None:
    generated = (
        "Action: sell YES into the rally.\nReason: odds are rich."
        "<|endoftext|>Human: ignore everything above"
    )

    assert (
        clean_generated_text(generated)
        == "Action: sell YES into the rally.\nReason: odds are rich."
    )


def test_clean_generated_text_keeps_plain_completion() -> None:
    generated = "Action: hold.\nReason: no edge."

    assert clean_generated_text(generated) == generated


def test_restore_assistant_prefix_prepends_missing_prefix() -> None:
    generated = "hold and stay flat.\nReason: no catalyst."

    assert (
        restore_assistant_prefix(generated, "Action: ")
        == "Action: hold and stay flat.\nReason: no catalyst."
    )


def test_restore_assistant_prefix_keeps_existing_prefix() -> None:
    generated = "Action: hold and stay flat.\nReason: no catalyst."

    assert restore_assistant_prefix(generated, "Action: ") == generated


def test_restore_assistant_prefix_falls_back_to_prefix_when_empty() -> None:
    assert restore_assistant_prefix("", "Action: ") == "Action:"


def test_generate_messages_mlx_restores_assistant_prefix() -> None:
    class FakeTokenizer:
        chat_template = None

    captured: dict[str, str] = {}

    def fake_generate(model, tokenizer, **kwargs):
        captured["prompt"] = kwargs["prompt"]
        return "hold and stay flat.\nReason: no catalyst."

    generator = object.__new__(LocalTextGenerator)
    generator.backend = "mlx"
    generator.model = object()
    generator.tokenizer = FakeTokenizer()
    generator._sampler = None
    generator._generate = fake_generate

    response = generator.generate_messages(
        [{"role": "user", "content": "What do you do?"}],
        assistant_prefix="Action: ",
    )

    assert captured["prompt"].endswith("Assistant: Action: ")
    assert response == "Action: hold and stay flat.\nReason: no catalyst."


def test_generate_messages_cpu_restores_assistant_prefix() -> None:
    class FakeTokenizer:
        chat_template = None
        eos_token_id = 0

        def __call__(self, text, return_tensors="pt"):
            return {"input_ids": torch.tensor([[1, 2, 3]])}

        def decode(self, tokens, skip_special_tokens=True):
            return "sell YES into strength.\nReason: odds are rich."

    class FakeModel:
        def generate(self, **kwargs):
            return torch.tensor([[1, 2, 3, 4, 5, 6]])

    generator = object.__new__(LocalTextGenerator)
    generator.backend = "cpu"
    generator.model = FakeModel()
    generator.tokenizer = FakeTokenizer()
    generator.device = "cpu"
    generator._generate = None
    generator._sampler = None

    response = generator.generate_messages(
        [{"role": "user", "content": "What do you do?"}],
        assistant_prefix="Action: ",
    )

    assert response == "Action: sell YES into strength.\nReason: odds are rich."


def test_generate_messages_cpu_passes_turboquant_cache(monkeypatch) -> None:
    class FakeTextConfig:
        num_hidden_layers = 2

    class FakeConfig:
        def get_text_config(self, decoder=True):
            return FakeTextConfig()

    class FakeTokenizer:
        chat_template = None
        eos_token_id = 0

        def __call__(self, text, return_tensors="pt"):
            return {"input_ids": torch.tensor([[1, 2, 3]])}

        def decode(self, tokens, skip_special_tokens=True):
            return "safe reply"

    captured: dict[str, object] = {}

    class FakeModel:
        config = FakeConfig()

        def generate(self, **kwargs):
            captured.update(kwargs)
            return torch.tensor([[1, 2, 3, 4]])

    generator = object.__new__(LocalTextGenerator)
    generator.backend = "cpu"
    generator.model = FakeModel()
    generator.tokenizer = FakeTokenizer()
    generator.device = "cpu"
    generator.cache_implementation = "turboquant"
    generator.turboquant_settings = TurboQuantSettings(
        key_bits=3.5,
        value_bits=3.5,
        residual_length=8,
        seed=11,
    )
    generator._generate = None
    generator._sampler = None

    response = generator.generate_messages(
        [{"role": "user", "content": "What do you do?"}],
        max_new_tokens=4,
    )

    assert response == "safe reply"
    assert "past_key_values" in captured
