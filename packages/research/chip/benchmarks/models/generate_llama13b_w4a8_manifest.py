#!/usr/bin/env python3
"""Emit the checked Llama-13B-style W4A8 quantized-graph manifest.

Derives concrete per-matrix shapes from the standard 13B transformer config
(n_layers=40, d_model=5120, n_heads=40, d_ff=13824, vocab=32000) and writes a
``eliza.e1x.quantized_model_manifest.v1`` JSON file consumed by the E1X graph
mapper. This emits a *description* (shapes + quantization), never weights.

Per decoder block (MHA, n_kv_heads == n_heads):
  * attn_qkv_proj: rows = 3*d_model (fused q|k|v), cols = d_model
  * attn_out_proj: rows = d_model,   cols = d_model
  * mlp_gate_proj: rows = d_ff,      cols = d_model
  * mlp_up_proj:   rows = d_ff,      cols = d_model
  * mlp_down_proj: rows = d_model,   cols = d_ff
  * two norm vectors (input + post-attention), rows = d_model, cols = 1
Plus a token embedding, a final norm, and the lm_head (both vocab x d_model).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "benchmarks/models/llama13b-w4a8-manifest.json"

N_LAYERS = 40
D_MODEL = 5120
N_HEADS = 40
N_KV_HEADS = 40
D_FF = 13824
VOCAB = 32000
WEIGHT_BITS = 4
ACTIVATION_BITS = 8


def build_manifest() -> dict[str, object]:
    layers: list[dict[str, object]] = [
        {"name": "tok_embeddings", "kind": "embedding", "rows": VOCAB, "cols": D_MODEL},
    ]
    for block in range(N_LAYERS):
        layers.extend(
            [
                {"name": f"blk{block}.attn_norm", "kind": "norm", "rows": D_MODEL, "cols": 1},
                {
                    "name": f"blk{block}.attn_qkv_proj",
                    "kind": "attn_qkv_proj",
                    "rows": 3 * D_MODEL,
                    "cols": D_MODEL,
                },
                {
                    "name": f"blk{block}.attn_out_proj",
                    "kind": "attn_out_proj",
                    "rows": D_MODEL,
                    "cols": D_MODEL,
                },
                {"name": f"blk{block}.ffn_norm", "kind": "norm", "rows": D_MODEL, "cols": 1},
                {
                    "name": f"blk{block}.mlp_gate_proj",
                    "kind": "mlp_gate_proj",
                    "rows": D_FF,
                    "cols": D_MODEL,
                },
                {
                    "name": f"blk{block}.mlp_up_proj",
                    "kind": "mlp_up_proj",
                    "rows": D_FF,
                    "cols": D_MODEL,
                },
                {
                    "name": f"blk{block}.mlp_down_proj",
                    "kind": "mlp_down_proj",
                    "rows": D_MODEL,
                    "cols": D_FF,
                },
            ]
        )
    layers.append({"name": "output_norm", "kind": "norm", "rows": D_MODEL, "cols": 1})
    layers.append({"name": "lm_head", "kind": "lm_head", "rows": VOCAB, "cols": D_MODEL})

    return {
        "schema": "eliza.e1x.quantized_model_manifest.v1",
        "name": "llama_13b_w4a8",
        "architecture": "transformer_decoder",
        "config": {
            "n_layers": N_LAYERS,
            "d_model": D_MODEL,
            "n_heads": N_HEADS,
            "n_kv_heads": N_KV_HEADS,
            "d_ff": D_FF,
            "vocab_size": VOCAB,
        },
        "quant": {"weight_bits": WEIGHT_BITS, "activation_bits": ACTIVATION_BITS},
        "layers": layers,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out = args.out if args.out.is_absolute() else ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(build_manifest(), indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
