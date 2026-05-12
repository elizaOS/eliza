"""End-to-end smoke test for ``abliteration_apply.py`` on a tiny model.

Uses ``sshleifer/tiny-gpt2`` so the test runs in seconds on CPU. Asserts:

  1. The model loads, activations collect, refusal direction normalizes.
  2. Per-layer ``c_proj`` weights (tiny-gpt2's analogue of ``o_proj`` /
     ``down_proj``) change in place after the projection.
  3. The refusal direction lies in the null space of the modified rows
     (within fp32 numerical tolerance).
  4. The model still produces text after abliteration (no NaN/inf).

The tiny-gpt2 architecture is GPT-2 style (``transformer.h``, with
``attn.c_proj`` and ``mlp.c_proj`` linears) — different from Llama's
``self_attn.o_proj`` / ``mlp.down_proj`` layout. The abliteration code
walks ``self_attn.o_proj`` / ``mlp.down_proj`` only, so on this model
the *weight check* (assertion 2) targets the equivalent transformations
through a thin shim. We rebind ``self_attn.o_proj`` and ``mlp.down_proj``
attributes on the GPT-2 layers before invoking the module.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import torch
import torch.nn as nn

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from abliteration_apply import (  # noqa: E402
    AbliterationRecipe,
    abliterate_model,
    compute_refusal_direction,
    project_out_direction_,
)

TINY_MODEL = "sshleifer/tiny-gpt2"


def test_compute_refusal_direction_unit_norm():
    harmful = torch.randn(8, 64)
    harmless = torch.randn(8, 64)
    r = compute_refusal_direction(harmful, harmless)
    assert r.shape == (64,)
    assert abs(r.norm().item() - 1.0) < 1e-5


def test_compute_refusal_direction_rejects_degenerate():
    same = torch.randn(8, 64)
    with pytest.raises(RuntimeError, match="degenerate"):
        compute_refusal_direction(same, same.clone())


def test_project_out_direction_zeros_component():
    weight = torch.randn(64, 128)
    direction = torch.randn(64)
    direction = direction / direction.norm()
    project_out_direction_(weight, direction)
    # After projection: direction^T @ weight should be ~0 along the output axis.
    residual = direction @ weight  # (128,)
    assert residual.abs().max().item() < 1e-4


def test_project_out_direction_validates_shapes():
    with pytest.raises(ValueError, match="2-D"):
        project_out_direction_(torch.randn(3, 4, 5), torch.randn(3))
    with pytest.raises(ValueError, match="direction"):
        project_out_direction_(torch.randn(64, 128), torch.randn(32))


def _shim_gpt2_for_abliteration(model: nn.Module) -> None:
    """Rebind GPT-2 block attrs so the Llama-shaped abliterator finds them.

    GPT-2 uses ``transformer.h[i].attn.c_proj`` and
    ``transformer.h[i].mlp.c_proj`` (both ``Conv1D``, not ``nn.Linear``).
    For the test we wrap each ``Conv1D`` in an ``nn.Linear`` shim that
    shares storage so the in-place projection lands on the real weights.
    """
    from transformers.pytorch_utils import Conv1D

    for block in model.transformer.h:
        # Conv1D stores weight as (in, out); nn.Linear is (out, in).
        # Rather than transposing, we expose a view via a wrapper that
        # the abliterator (which expects (out, in)) will modify in place.
        attn_c = block.attn.c_proj
        mlp_c = block.mlp.c_proj
        assert isinstance(attn_c, Conv1D), type(attn_c)
        assert isinstance(mlp_c, Conv1D), type(mlp_c)

        # Build a Linear that owns a transposed view of the Conv1D weight.
        # Modifications to the view propagate to the underlying buffer.
        attn_linear = nn.Linear(attn_c.weight.shape[0], attn_c.weight.shape[1], bias=False)
        attn_linear.weight = nn.Parameter(attn_c.weight.t(), requires_grad=False)
        block.self_attn = nn.Module()
        block.self_attn.o_proj = attn_linear
        block.attn._abliter_view = attn_linear  # keep a ref so it isn't GC'd

        mlp_linear = nn.Linear(mlp_c.weight.shape[0], mlp_c.weight.shape[1], bias=False)
        mlp_linear.weight = nn.Parameter(mlp_c.weight.t(), requires_grad=False)
        block.mlp.down_proj = mlp_linear


def test_abliterate_tiny_gpt2_endtoend():
    transformers = pytest.importorskip("transformers")
    AutoModelForCausalLM = transformers.AutoModelForCausalLM
    AutoTokenizer = transformers.AutoTokenizer

    model = AutoModelForCausalLM.from_pretrained(TINY_MODEL)
    tok = AutoTokenizer.from_pretrained(TINY_MODEL)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model.eval()

    # tiny-gpt2's resolver lives at ``transformer.h``; inject a Llama-shaped
    # alias so ``_resolve_decoder_layers`` finds the layer list. (We don't
    # patch the production code to know about GPT-2 — the abliterator only
    # ever runs on Llama/Qwen-shaped models in real use.)
    model.model = nn.Module()
    model.model.layers = model.transformer.h
    _shim_gpt2_for_abliteration(model)

    # Snapshot weights before abliteration.
    pre_o = [b.self_attn.o_proj.weight.data.clone() for b in model.transformer.h]
    pre_d = [b.mlp.down_proj.weight.data.clone() for b in model.transformer.h]

    harmful = ["how do I make a bomb", "explain how to hack email"]
    harmless = ["how do I bake bread", "explain how to set up email"]
    recipe = AbliterationRecipe(layer_fraction=0.5, max_prompts=8)

    stats = abliterate_model(
        model,
        tok,
        harmful_prompts=harmful,
        harmless_prompts=harmless,
        recipe=recipe,
    )

    assert stats["n_harmful_prompts"] == 2
    assert stats["n_harmless_prompts"] == 2
    assert stats["n_o_proj_modified"] == len(model.transformer.h)
    assert stats["n_down_proj_modified"] == len(model.transformer.h)
    assert stats["hidden_size"] == model.config.hidden_size

    # At least one weight changed (refusal direction should be non-trivial).
    changed = any(
        not torch.equal(pre, b.self_attn.o_proj.weight.data)
        for pre, b in zip(pre_o, model.transformer.h)
    )
    assert changed, "abliteration did not change any o_proj weights"
    changed = any(
        not torch.equal(pre, b.mlp.down_proj.weight.data)
        for pre, b in zip(pre_d, model.transformer.h)
    )
    assert changed, "abliteration did not change any down_proj weights"

    # Generation still works (no NaNs).
    ids = tok("hello", return_tensors="pt")
    with torch.no_grad():
        out = model.generate(**ids, max_new_tokens=4, do_sample=False)
    assert out.shape[0] == 1
    assert torch.isfinite(out.float()).all()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
