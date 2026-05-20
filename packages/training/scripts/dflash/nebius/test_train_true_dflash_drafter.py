from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).with_name("train_true_dflash_drafter.py")


def _load_module():
    spec = importlib.util.spec_from_file_location("train_true_dflash_drafter", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_tensor_mapping_exports_dflash_runtime_names() -> None:
    module = _load_module()
    cases = {
        "fc.weight": "dflash_fc.weight",
        "hidden_norm.weight": "dflash_hidden_norm.weight",
        "norm.weight": "output_norm.weight",
        "layers.3.input_layernorm.weight": "blk.3.attn_norm.weight",
        "layers.3.post_attention_layernorm.weight": "blk.3.post_attention_norm.weight",
        "layers.3.self_attn.q_proj.weight": "blk.3.attn_q.weight",
        "layers.3.self_attn.k_proj.weight": "blk.3.attn_k.weight",
        "layers.3.self_attn.v_proj.weight": "blk.3.attn_v.weight",
        "layers.3.self_attn.o_proj.weight": "blk.3.attn_output.weight",
        "layers.3.self_attn.q_norm.weight": "blk.3.attn_q_norm.weight",
        "layers.3.self_attn.k_norm.weight": "blk.3.attn_k_norm.weight",
        "layers.3.mlp.gate_proj.weight": "blk.3.ffn_gate.weight",
        "layers.3.mlp.down_proj.weight": "blk.3.ffn_down.weight",
        "layers.3.mlp.up_proj.weight": "blk.3.ffn_up.weight",
    }
    for source, expected in cases.items():
        assert module._map_tensor_name(source) == expected


def test_tensor_mapping_rejects_unexpected_weights() -> None:
    module = _load_module()
    assert module._map_tensor_name("embed_tokens.weight") is None
    assert module._map_tensor_name("lm_head.weight") is None
    assert module._map_tensor_name("layers.0.self_attn.q_proj.bias") is None
