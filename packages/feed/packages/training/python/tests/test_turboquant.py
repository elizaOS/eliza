from __future__ import annotations

import sys
from pathlib import Path

import torch
from transformers import GPT2Config, GPT2LMHeadModel
from transformers.models.qwen3_5.configuration_qwen3_5 import Qwen3_5TextConfig
from transformers.models.qwen3_5.modeling_qwen3_5 import Qwen3_5ForCausalLM

sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "training"))

from turboquant import (
    Qwen35TurboQuantCache,
    TurboQuantCache,
    TurboQuantLayer,
    TurboQuantSettings,
    TurboQuantTensorQuantizer,
    build_generation_cache,
)


class _FakeTextConfig:
    num_hidden_layers = 3


class _FakeModelConfig:
    def get_text_config(self, decoder=True):
        return _FakeTextConfig()


def _tiny_qwen35_config() -> Qwen3_5TextConfig:
    return Qwen3_5TextConfig(
        vocab_size=64,
        hidden_size=32,
        intermediate_size=64,
        num_hidden_layers=2,
        num_attention_heads=4,
        num_key_value_heads=2,
        head_dim=8,
        linear_conv_kernel_dim=2,
        linear_key_head_dim=8,
        linear_value_head_dim=8,
        linear_num_key_heads=4,
        linear_num_value_heads=4,
        layer_types=["linear_attention", "full_attention"],
        bos_token_id=0,
        eos_token_id=1,
        pad_token_id=0,
    )


def test_build_generation_cache_constructs_turboquant_cache() -> None:
    cache = build_generation_cache(
        _FakeModelConfig(),
        cache_implementation="turboquant",
        turboquant_settings=TurboQuantSettings(),
    )

    assert isinstance(cache, TurboQuantCache)
    assert len(cache.layers) == 3


def test_build_generation_cache_constructs_qwen35_turboquant_cache() -> None:
    cache = build_generation_cache(
        _tiny_qwen35_config(),
        cache_implementation="turboquant",
        turboquant_settings=TurboQuantSettings(),
    )

    assert isinstance(cache, Qwen35TurboQuantCache)
    assert cache.layer_types == ["linear_attention", "full_attention"]


def test_turboquant_tensor_quantizer_supports_fractional_bits() -> None:
    quantizer = TurboQuantTensorQuantizer(
        dim=8,
        bits=2.5,
        use_qjl=False,
        seed=7,
        device=torch.device("cpu"),
        output_dtype=torch.float32,
    )
    tensor = torch.randn(2, 2, 3, 8)

    state = quantizer.compress(tensor)
    restored = quantizer.decompress(state)

    assert restored.shape == tensor.shape
    assert state.mse.outlier_channels is not None
    assert state.mse.outlier_codes is not None


def test_turboquant_layer_flushes_tail_into_compressed_prefix() -> None:
    layer = TurboQuantLayer(
        settings=TurboQuantSettings(
            key_bits=3.5,
            value_bits=3.5,
            residual_length=2,
            seed=19,
        ),
        layer_idx=0,
    )
    key_a = torch.randn(1, 2, 1, 8)
    value_a = torch.randn(1, 2, 1, 8)
    key_b = torch.randn(1, 2, 1, 8)
    value_b = torch.randn(1, 2, 1, 8)

    out_keys_a, out_values_a = layer.update(key_a, value_a)
    out_keys_b, out_values_b = layer.update(key_b, value_b)

    assert out_keys_a.shape[-2] == 1
    assert out_values_a.shape[-2] == 1
    assert out_keys_b.shape[-2] == 2
    assert out_values_b.shape[-2] == 2
    assert layer.get_seq_length() == 2
    assert layer._compressed_keys is not None
    assert layer._compressed_values is not None
    assert layer.keys.shape[-2] == 1
    assert layer.values.shape[-2] == 1


def test_turboquant_cache_runs_transformers_generate_smoke() -> None:
    config = GPT2Config(
        vocab_size=64,
        n_positions=32,
        n_ctx=32,
        n_embd=16,
        n_layer=2,
        n_head=2,
        bos_token_id=0,
        eos_token_id=1,
    )
    model = GPT2LMHeadModel(config)
    input_ids = torch.tensor([[0, 2, 3]], dtype=torch.long)
    cache = TurboQuantCache(
        model.config,
        TurboQuantSettings(
            key_bits=3.0,
            value_bits=3.0,
            residual_length=4,
            seed=23,
        ),
    )

    outputs = model.generate(
        input_ids=input_ids,
        max_new_tokens=2,
        do_sample=False,
        use_cache=True,
        past_key_values=cache,
        pad_token_id=config.eos_token_id,
        eos_token_id=config.eos_token_id,
    )

    assert outputs.shape[1] == input_ids.shape[1] + 2


def test_qwen35_turboquant_cache_runs_transformers_generate_smoke() -> None:
    config = _tiny_qwen35_config()
    model = Qwen3_5ForCausalLM(config)
    input_ids = torch.tensor([[0, 2, 3]], dtype=torch.long)
    cache = build_generation_cache(
        model.config,
        cache_implementation="turboquant",
        turboquant_settings=TurboQuantSettings(
            key_bits=3.5,
            value_bits=3.5,
            residual_length=4,
            seed=31,
        ),
    )

    outputs = model.generate(
        input_ids=input_ids,
        max_new_tokens=2,
        do_sample=False,
        use_cache=True,
        past_key_values=cache,
        pad_token_id=config.pad_token_id,
        eos_token_id=config.eos_token_id,
    )

    assert isinstance(cache, Qwen35TurboQuantCache)
    assert outputs.shape[1] == input_ids.shape[1] + 2
    assert cache.get_seq_length() == outputs.shape[1] - 1
    assert cache.conv_states[0] is not None


def test_qwen35_turboquant_cache_accepts_integer_mask_query_length() -> None:
    cache = build_generation_cache(
        _tiny_qwen35_config(),
        cache_implementation="turboquant",
        turboquant_settings=TurboQuantSettings(
            key_bits=3.5,
            value_bits=3.5,
            residual_length=4,
            seed=31,
        ),
    )

    kv_length, kv_offset = cache.get_mask_sizes(3, 1)

    assert kv_length == 3
    assert kv_offset == 0
