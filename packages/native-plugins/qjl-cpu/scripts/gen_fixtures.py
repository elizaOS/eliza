#!/usr/bin/env python3
"""Emit a parity-test fixture for the qjl-cpu standalone library.

The fixture is a tiny binary blob (much faster to parse from C than JSON)
plus a one-line ASCII header describing the shape:

    QJLFIXv1 head_dim=128 proj_dim=256 seed=42 n=100\n
    [proj  matrix : head_dim * proj_dim float32]
    [keys         : n * head_dim       float32]
    [exp signs    : n * (proj_dim / 8) uint8]
    [exp norms    : n                  uint16 (bf16)]
    [q_sketch     : n_heads * proj_dim float32]   <- query sketch (for score test)
    [exp scores   : n_heads * n        float32]   <- expected per-(head,token) score

The reference path is `qjl_pure_pytorch_quantize` from
packages/training/scripts/quantization/test_qjl.py, lifted inline so this
script is standalone and does not need to import the test module (its
imports include heavy training-only deps).
"""

from __future__ import annotations

import argparse
import math
import struct
from pathlib import Path

import torch


HEAD_DIM   = 128
PROJ_DIM   = 256
PROJ_SEED  = 42
N_HEADS    = 8
N_KV_HEADS = 2  # GQA factor 4 — matches Llama/Qwen3 sub-9B


def fp32_to_bf16(x: torch.Tensor) -> torch.Tensor:
    """IEEE round-to-nearest-even fp32 -> bf16 stored as uint16."""
    bits = x.contiguous().view(torch.uint32) if hasattr(torch, "uint32") else None
    # torch lacks .view(torch.uint32) directly on older versions; do it via numpy.
    import numpy as np
    a = x.detach().cpu().contiguous().numpy().view(np.uint32).copy()
    # Round-to-nearest-even.
    lsb = (a >> 16) & 1
    rounding = 0x7FFF + lsb
    a = a + rounding
    out = (a >> 16).astype(np.uint16)
    return torch.from_numpy(out)


def qjl_pure_pytorch_quantize(keys: torch.Tensor, proj: torch.Tensor):
    """Mirrors test_qjl.qjl_pure_pytorch_quantize for the inlier path.

    Args:
        keys: (N, head_dim) fp32.
        proj: (head_dim, proj_dim) fp32.
    Returns:
        packed:  (N, proj_dim/8) uint8, LSB-first packing.
        norm16:  (N,) uint16 (bf16 of L2 norm).
    """
    sk = keys.float() @ proj
    bits = (sk > 0).to(torch.uint8)
    n, p = bits.shape
    bits = bits.view(n, p // 8, 8)
    enc = (1 << torch.arange(8, dtype=torch.uint8)).view(1, 1, 8)
    packed = (bits * enc).sum(dim=-1).to(torch.uint8)
    norm = keys.float().norm(dim=-1)
    norm16 = fp32_to_bf16(norm)
    return packed, norm16


def expected_scores(q_sketch: torch.Tensor, packed: torch.Tensor,
                    norm16: torch.Tensor) -> torch.Tensor:
    """Reference GQA score path. Matches qjl_score_qk_ref.

    Args:
        q_sketch: (n_heads, proj_dim) fp32 — pre-projected query.
        packed:   (n_kv_heads, n_tokens, proj_dim/8) uint8.
        norm16:   (n_kv_heads, n_tokens) uint16 (bf16).
    Returns:
        scores: (n_heads, n_tokens) fp32.
    """
    n_heads = q_sketch.shape[0]
    n_kv, n_tok, _ = packed.shape
    gqa = n_heads // n_kv
    scl = math.sqrt(math.pi / 2.0) / float(PROJ_DIM)

    # Expand packed bytes to +/-1 fp32 lanes.
    bits = torch.zeros(n_kv, n_tok, PROJ_DIM, dtype=torch.float32)
    for j in range(PROJ_DIM):
        b = (packed[:, :, j // 8] >> (j % 8)) & 1
        bits[:, :, j] = torch.where(b == 1, 1.0, -1.0)

    # Reverse the bf16 cast: low 16 bits zeroed.
    import numpy as np
    norm_arr = norm16.cpu().numpy().astype(np.uint32) << 16
    norm_f = torch.from_numpy(norm_arr.view(np.float32).copy())  # (n_kv, n_tok)

    scores = torch.zeros(n_heads, n_tok, dtype=torch.float32)
    for hq in range(n_heads):
        hk = hq // gqa
        for t in range(n_tok):
            dot = (bits[hk, t] * q_sketch[hq]).sum().item()
            scores[hq, t] = scl * float(norm_f[hk, t]) * dot
    return scores


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--n", type=int, default=100, help="number of key vectors")
    ap.add_argument("--seed", type=int, default=PROJ_SEED)
    args = ap.parse_args()

    g = torch.Generator(device="cpu").manual_seed(args.seed)
    proj = torch.randn(HEAD_DIM, PROJ_DIM, generator=g, dtype=torch.float32)

    # Random key vectors. Use a separate seed so the per-row inputs aren't
    # accidentally aligned with the projection columns.
    g2 = torch.Generator(device="cpu").manual_seed(args.seed ^ 0xDEADBEEF)
    keys = torch.randn(args.n, HEAD_DIM, generator=g2, dtype=torch.float32)

    packed, norm16 = qjl_pure_pytorch_quantize(keys, proj)

    # GQA score: arrange first n_kv_heads * n_tokens of the packed blocks
    # as the K cache, draw query states + project them to get q_sketch.
    n_tokens = args.n // N_KV_HEADS
    if n_tokens == 0:
        raise SystemExit(f"--n={args.n} too small for n_kv_heads={N_KV_HEADS}")

    # Pull the front (n_kv_heads * n_tokens) blocks; reshape.
    used = N_KV_HEADS * n_tokens
    k_packed = packed[:used].view(N_KV_HEADS, n_tokens, PROJ_DIM // 8).contiguous()
    k_norm16 = norm16[:used].view(N_KV_HEADS, n_tokens).contiguous()

    g3 = torch.Generator(device="cpu").manual_seed(args.seed ^ 0xBADC0FFEE)
    q = torch.randn(N_HEADS, HEAD_DIM, generator=g3, dtype=torch.float32)
    q_sketch = q @ proj  # (N_HEADS, PROJ_DIM)

    scores = expected_scores(q_sketch, k_packed, k_norm16)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    header = (
        f"QJLFIXv1 head_dim={HEAD_DIM} proj_dim={PROJ_DIM} seed={args.seed}"
        f" n={args.n} n_heads={N_HEADS} n_kv_heads={N_KV_HEADS} n_tokens={n_tokens}\n"
    )
    with args.out.open("wb") as f:
        f.write(header.encode("ascii"))
        f.write(proj.contiguous().numpy().astype("<f4").tobytes())
        f.write(keys.contiguous().numpy().astype("<f4").tobytes())
        f.write(packed.contiguous().numpy().astype("<u1").tobytes())
        f.write(norm16.contiguous().numpy().astype("<u2").tobytes())
        f.write(q_sketch.contiguous().numpy().astype("<f4").tobytes())
        f.write(scores.contiguous().numpy().astype("<f4").tobytes())

    print(f"wrote {args.out}: header + {len(proj.flatten())*4} B proj + "
          f"{args.n*HEAD_DIM*4} B keys + {args.n*PROJ_DIM//8} B signs + "
          f"{args.n*2} B norms + q_sketch + scores")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
