"""Pytest unit + dry-run smoke tests for the quantization recipes.

These tests are CPU-only and avoid downloading anything large. They
exercise the import surface, recipe dataclasses, and CLI dry-run paths
of every recipe so a broken module is caught at unit-test time rather
than at training-rig invocation time. The end-to-end correctness tests
that require a real model live in:

    test_abliteration.py          -- runs vs sshleifer/tiny-gpt2
    test_polarquant.py            -- CLI runner; needs a real Qwen3 GPU
    test_turboquant.py            -- CLI runner; needs a real Qwen3 GPU
    test_qjl.py                   -- CLI runner; needs a real Qwen3 GPU
    test_fused_turboquant.py      -- CLI runner; needs a real Qwen3 GPU

They are NOT pytest-collectable on purpose: they download multi-GB
checkpoints and require a fixed val.jsonl shipped with the training
data. Run them by hand from the repo root.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))


def test_polarquant_recipe_serializes_with_paper_metadata():
    from polarquant_apply import PolarQuantRecipe

    recipe = PolarQuantRecipe(bits=4, block_size=128, use_qjl=True)
    payload = recipe.to_json()
    assert payload["bits"] == 4
    assert payload["block_size"] == 128
    assert payload["use_qjl"] is True
    assert payload["paper"] == "arXiv:2603.29078"
    assert "upstream_commit" in payload


def test_polarquant_dry_run_emits_recipe_json(capsys):
    from polarquant_apply import main

    rc = main(["--model", "Qwen/Qwen3-0.6B", "--output", "/tmp/_polarquant_unused", "--dry-run"])
    assert rc == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["model"] == "Qwen/Qwen3-0.6B"
    assert payload["recipe"]["bits"] == 4


def test_polarquant_dry_run_rejects_missing_calibration(tmp_path):
    from polarquant_apply import main

    bogus = tmp_path / "does-not-exist.jsonl"
    with pytest.raises(FileNotFoundError):
        main([
            "--model", "Qwen/Qwen3-0.6B",
            "--output", str(tmp_path / "out"),
            "--calibration", str(bogus),
            "--dry-run",
        ])


def test_fused_turboquant_recipe_metadata():
    from fused_turboquant_apply import FusedTurboQuantRecipe

    recipe = FusedTurboQuantRecipe(bits=4, compress_v=True, verify=True)
    payload = recipe.to_json()
    assert payload["bits"] == 4
    assert payload["paper"] == "arXiv:2504.19874"
    assert payload["library"] == "fused-turboquant 0.1.0"
    assert payload["kernels"] == "triton"


def test_fused_turboquant_dry_run_rejects_missing_calibration(tmp_path):
    from fused_turboquant_apply import main

    bogus = tmp_path / "does-not-exist.jsonl"
    with pytest.raises(FileNotFoundError):
        main([
            "--model", "Qwen/Qwen3-0.6B",
            "--output", str(tmp_path / "out"),
            "--calibration", str(bogus),
            "--dry-run",
        ])


def test_fp8_apply_dry_run_emits_capability_json(capsys):
    """fp8_apply.py is on the publish path (`--quant fp8`). Its dry-run
    must enumerate the capability check so users on the wrong GPU find
    out before they run a 20-minute conversion. The dry-run intentionally
    does NOT fail when CUDA is absent — it just records that fact in the
    JSON output."""
    from fp8_apply import main

    rc = main(["--model", "Qwen/Qwen3-0.6B", "--output", "/tmp/_fp8_unused", "--dry-run"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert "fp8_ok" in payload
    assert "reason" in payload


def test_qjl_apply_kv_bytes_per_token_analytic_qwen():
    """Sanity-check the analytic KV-bytes formula on a real Qwen3-0.6B config.

    No model download — just metadata via AutoConfig.
    """
    pytest.importorskip("transformers")
    from transformers import AutoConfig

    from qjl_apply import kv_bytes_per_token_analytic

    cfg = AutoConfig.from_pretrained("Qwen/Qwen3-0.6B", trust_remote_code=True)
    base_bpt, quant_bpt = kv_bytes_per_token_analytic(
        cfg,
        key_quantization_bits=256,
        key_quantization_bits_initial_layers=512,
        initial_layers_count=15,
        outlier_count_general=8,
        outlier_count_initial_layers=8,
        value_bits=4,
    )
    assert base_bpt > 0
    assert quant_bpt > 0
    # QJL+TurboQuant must shrink the cache vs bf16. >=4x is conservative;
    # the paper / our analytic formula show ~7x at proj_dim=256.
    assert base_bpt / quant_bpt >= 4.0


def test_common_helpers_handle_text_config_passthrough():
    from _common import full_attention_layer_indices, get_text_config, head_dim_of

    class FakeConfig:
        hidden_size = 1024
        num_attention_heads = 16
        num_hidden_layers = 4

    cfg = FakeConfig()
    assert get_text_config(cfg) is cfg
    assert head_dim_of(cfg) == 64
    assert full_attention_layer_indices(cfg) == [0, 1, 2, 3]


def test_common_layer_types_filters_full_attention_layers():
    from _common import full_attention_layer_indices

    class HybridConfig:
        num_hidden_layers = 8
        layer_types = [
            "linear_attention", "linear_attention", "linear_attention",
            "full_attention", "linear_attention", "linear_attention",
            "linear_attention", "full_attention",
        ]

    indices = full_attention_layer_indices(HybridConfig())
    assert indices == [3, 7]


def test_common_load_calibration_prompts_pulls_current_message_content(tmp_path):
    from _common import load_calibration_prompts

    p = tmp_path / "val.jsonl"
    p.write_text(
        "\n".join([
            json.dumps({"currentMessage": {"content": "first"}}),
            json.dumps({"currentMessage": {"content": "second"}}),
            "",
            json.dumps({"currentMessage": {"content": "third"}}),
        ]),
        encoding="utf-8",
    )
    out = load_calibration_prompts(p, n=2)
    assert out == ["first", "second"]


def test_common_load_calibration_prompts_raises_on_empty(tmp_path):
    from _common import load_calibration_prompts

    p = tmp_path / "empty.jsonl"
    p.write_text("", encoding="utf-8")
    with pytest.raises(RuntimeError, match="No prompts read"):
        load_calibration_prompts(p, n=1)


def test_push_model_quant_choices_match_real_recipes():
    """The published `--quant` choices must match recipes that actually
    produce a HF-loadable checkpoint. QJL is intentionally absent — it is
    a runtime-only KV projection. Abliteration is its own `--variant`,
    not a `--quant`."""
    sys.path.insert(0, str(_HERE.parent))
    from push_model_to_hf import QUANT_BLURBS

    expected = {"polarquant", "turboquant", "fp8", "gguf-q4_k_m", "gguf-q5_k_m", "gguf-q6_k"}
    assert set(QUANT_BLURBS) == expected
    # Every blurb must reference an arXiv id, GitHub PR, or vendor primer.
    for key, meta in QUANT_BLURBS.items():
        assert "paper" in meta and meta["paper"], f"{key} missing paper link"
        assert "blurb" in meta and meta["blurb"], f"{key} missing blurb"


def test_push_model_resolves_repo_id_with_quant_suffix():
    sys.path.insert(0, str(_HERE.parent))
    from push_model_to_hf import resolve_repo_id

    assert resolve_repo_id("qwen3.5-2b", None, "default", None) == "elizaos/eliza-1-2b"
    assert resolve_repo_id("qwen3.5-2b", "polarquant", "default", None) == (
        "elizaos/eliza-1-2b-polarquant"
    )
    assert resolve_repo_id("qwen3.6-27b", "gguf-q4_k_m", "default", None) == (
        "elizaos/eliza-1-27b-gguf-q4_k_m"
    )
    assert resolve_repo_id("qwen3.5-2b", None, "abliterated", None) == (
        "elizaos/eliza-1-2b-uncensored"
    )
    assert resolve_repo_id("qwen3.5-2b", "polarquant", "default", "custom/foo") == "custom/foo"


def test_push_model_card_inference_blocks_reference_real_imports():
    """Regression guard: the inference snippets we put in model cards must
    only reference symbols that actually exist in the repo. Two earlier
    versions of the script referenced `load_polarquant` and
    `wrap_with_turboquant` — neither was ever defined."""
    sys.path.insert(0, str(_HERE.parent))
    from push_model_to_hf import PushConfig, _quant_inference_block

    for quant in ("polarquant", "turboquant", "fp8", "gguf-q4_k_m"):
        cfg = PushConfig(
            registry_key="qwen3.5-2b",
            checkpoint=Path("/tmp/_unused"),
            repo_id=f"elizaos/eliza-1-2b-{quant}",
            quant=quant,
            variant="default",
            public=False,
            readme_only=False,
            dry_run=True,
        )
        block = _quant_inference_block(cfg)
        assert "load_polarquant" not in block, f"{quant} card references nonexistent load_polarquant"
        assert "wrap_with_turboquant" not in block, (
            f"{quant} card references nonexistent wrap_with_turboquant"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
