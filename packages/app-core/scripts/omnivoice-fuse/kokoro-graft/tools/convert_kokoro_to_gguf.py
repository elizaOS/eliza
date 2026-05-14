#!/usr/bin/env python3
# convert_kokoro_to_gguf.py: Kokoro-82M PyTorch checkpoint -> GGUF.
#
# Mirrors the OmniVoice convert.py pattern (sibling file in the standalone
# omnivoice.cpp checkout): walk the source state dict, keep native dtypes,
# emit a single GGUF that the fused Kokoro engine in
# `omnivoice/src/kokoro-engine.cpp` consumes via the shared `gguf-weights.h`
# loader.
#
# Source checkpoint: `hexgrad/Kokoro-82M` on Hugging Face. The `kokoro` PyPI
# package (`pip install kokoro`) exposes the loader: `KModel(repo_id=...)`.
# We do NOT depend on the `onnx-community/Kokoro-82M-v1.0-ONNX` re-export -
# this script reads the original PyTorch weights so the conversion is
# lossless (the ONNX re-export already constant-folds the iSTFT basis,
# losing the explicit window kernel that we want to write as a clean
# CONV_TRANSPOSE_1D constant tensor).
#
# Output: `kokoro-82m-v1_0.gguf` containing:
#
#   GGUF KV header
#     general.architecture           = "kokoro"
#     general.name                   = "kokoro-82m-v1.0"
#     kokoro.version                 = "v1.0"
#     kokoro.sample_rate             = 24000
#     kokoro.hop_length              = 600     (fft_hop @ 24kHz, 25 ms)
#     kokoro.win_length              = 2400    (fft_window @ 24kHz, 100 ms)
#     kokoro.n_fft                   = 2048
#     kokoro.phoneme_vocab_size      = 178
#     kokoro.max_phoneme_length      = 510
#     kokoro.text_encoder.depth      = 4
#     kokoro.text_encoder.hidden     = 512
#     kokoro.text_encoder.n_head     = 8
#     kokoro.style_dim               = 256
#     kokoro.istftnet.n_blocks       = 4
#     kokoro.istftnet.upsample_rates = [10, 6, 2, 2, 2]
#     kokoro.istftnet.n_mels         = 80
#
#   Tensors (block-relative names; see omnivoice/src/kokoro-engine.h for the
#   block layout):
#     text_encoder.embed.weight
#     text_encoder.layers.{i}.attn.{q,k,v,o}_proj.weight
#     text_encoder.layers.{i}.attn.{q,k,v,o}_proj.bias
#     text_encoder.layers.{i}.mlp.{up,down,gate}.weight
#     text_encoder.layers.{i}.norm{1,2}.{weight,bias}
#     text_encoder.final_norm.{weight,bias}
#
#     prosody_predictor.lstm.{w_ih,w_hh,b_ih,b_hh}
#     prosody_predictor.duration_proj.{weight,bias}
#     prosody_predictor.f0_predictor.{block_i}.{conv.{weight,bias},norm.{weight,bias}}
#     prosody_predictor.n_predictor.{block_i}.{conv.{weight,bias},norm.{weight,bias}}
#
#     length_regulator.alignment_proj.{weight,bias}  (small)
#
#     istftnet.input_proj.{weight,bias}
#     istftnet.blocks.{i}.upsample_conv.{weight,bias}        # ConvTranspose1d
#     istftnet.blocks.{i}.mrf.{j}.convs.{k}.{weight,bias}     # MRF residuals
#     istftnet.blocks.{i}.mrf.{j}.snake.{alpha,inv_beta}      # Snake params
#     istftnet.output_conv.{weight,bias}                      # -> (mag, phase) 2*n_fft/2+1 channels
#     istftnet.istft.basis.weight                             # frozen synthesis basis [n_fft, 2, hop_length]
#     istftnet.istft.window.weight                            # frozen Hann window [n_fft]
#
# Voice-pack `.bin` files (per-position 256-dim ref_s tensors) are NOT
# embedded in the GGUF - they ship as separate `voices/<voice>.bin` files
# alongside the GGUF, matching the existing on-disk layout
# (`packages/shared/src/local-inference/catalog.ts:127-138`).
#
# Usage:
#   python convert_kokoro_to_gguf.py \
#       --src ~/.cache/huggingface/hub/models--hexgrad--Kokoro-82M/snapshots/<sha> \
#       --out kokoro-82m-v1_0.gguf
#
#   # smoke mode: write a synthetic GGUF with the right KV header but
#   # zero-initialized tensors, for CI / FFI symbol checks:
#   python convert_kokoro_to_gguf.py --synthetic --out kokoro-smoke.gguf
#
# References:
#   - hexgrad/kokoro: https://github.com/hexgrad/kokoro
#   - StyleTTS-2:     https://arxiv.org/abs/2306.07691
#   - iSTFTNet:       https://arxiv.org/abs/2203.02395
#   - Sister script:  plugins/plugin-local-inference/native/omnivoice.cpp/convert.py

from __future__ import annotations

import argparse
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# numpy and gguf imported lazily so `--synthetic` mode in a minimal CI
# environment doesn't drag in the full ML stack.

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def log(tag: str, msg: str) -> None:
    print(f"[{tag}] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Tensor-name plan
# ---------------------------------------------------------------------------
#
# The Kokoro PyTorch state dict uses dotted names like
# `bert.encoder.layer.0.attention.self.query.weight`. We rewrite to the
# layout the C++ engine expects (see header of this file). Mapping is
# explicit (no regex magic) so a change in upstream naming surfaces as a
# loud KeyError, not a silent miscopy.

KOKORO_VERSION = "v1.0"
KOKORO_SAMPLE_RATE = 24_000
KOKORO_HOP_LENGTH = 600
KOKORO_WIN_LENGTH = 2_400
KOKORO_N_FFT = 2_048
KOKORO_PHONEME_VOCAB = 178
KOKORO_MAX_PHONEME = 510
KOKORO_STYLE_DIM = 256

KOKORO_TEXT_ENCODER_DEPTH = 4
KOKORO_TEXT_ENCODER_HIDDEN = 512
KOKORO_TEXT_ENCODER_HEADS = 8

KOKORO_ISTFTNET_BLOCKS = 4
KOKORO_ISTFTNET_UPSAMPLE_RATES = [10, 6, 2, 2, 2]
KOKORO_ISTFTNET_N_MELS = 80


@dataclass(frozen=True)
class TensorMap:
    """One source-state-dict name -> one GGUF tensor name + dtype policy.

    keep_dtype : if True, preserve the source dtype (BF16/F16/F32);
                 if False, the converter is allowed to cast at write time.
    """

    src_name: str
    dst_name: str
    keep_dtype: bool = True


def text_encoder_tensor_plan() -> list[TensorMap]:
    out: list[TensorMap] = [
        TensorMap("bert.embeddings.word_embeddings.weight", "text_encoder.embed.weight"),
        TensorMap(
            "bert.embeddings.position_embeddings.weight",
            "text_encoder.pos_embed.weight",
        ),
        TensorMap(
            "bert.embeddings.LayerNorm.weight", "text_encoder.embed_norm.weight"
        ),
        TensorMap("bert.embeddings.LayerNorm.bias", "text_encoder.embed_norm.bias"),
    ]
    for i in range(KOKORO_TEXT_ENCODER_DEPTH):
        b = f"bert.encoder.layer.{i}"
        d = f"text_encoder.layers.{i}"
        out.extend(
            [
                TensorMap(f"{b}.attention.self.query.weight", f"{d}.attn.q_proj.weight"),
                TensorMap(f"{b}.attention.self.query.bias", f"{d}.attn.q_proj.bias"),
                TensorMap(f"{b}.attention.self.key.weight", f"{d}.attn.k_proj.weight"),
                TensorMap(f"{b}.attention.self.key.bias", f"{d}.attn.k_proj.bias"),
                TensorMap(f"{b}.attention.self.value.weight", f"{d}.attn.v_proj.weight"),
                TensorMap(f"{b}.attention.self.value.bias", f"{d}.attn.v_proj.bias"),
                TensorMap(
                    f"{b}.attention.output.dense.weight", f"{d}.attn.o_proj.weight"
                ),
                TensorMap(f"{b}.attention.output.dense.bias", f"{d}.attn.o_proj.bias"),
                TensorMap(
                    f"{b}.attention.output.LayerNorm.weight", f"{d}.norm1.weight"
                ),
                TensorMap(f"{b}.attention.output.LayerNorm.bias", f"{d}.norm1.bias"),
                TensorMap(f"{b}.intermediate.dense.weight", f"{d}.mlp.up.weight"),
                TensorMap(f"{b}.intermediate.dense.bias", f"{d}.mlp.up.bias"),
                TensorMap(f"{b}.output.dense.weight", f"{d}.mlp.down.weight"),
                TensorMap(f"{b}.output.dense.bias", f"{d}.mlp.down.bias"),
                TensorMap(f"{b}.output.LayerNorm.weight", f"{d}.norm2.weight"),
                TensorMap(f"{b}.output.LayerNorm.bias", f"{d}.norm2.bias"),
            ]
        )
    return out


def prosody_predictor_tensor_plan() -> list[TensorMap]:
    # Duration LSTM + linear, plus a small per-token F0 + N predictor stack.
    out: list[TensorMap] = []
    # Duration LSTM (1 layer, 1 direction; 256 hidden).
    out.extend(
        [
            TensorMap(
                "predictor.duration_proj.lstm.weight_ih_l0",
                "prosody.duration_lstm.w_ih",
            ),
            TensorMap(
                "predictor.duration_proj.lstm.weight_hh_l0",
                "prosody.duration_lstm.w_hh",
            ),
            TensorMap(
                "predictor.duration_proj.lstm.bias_ih_l0", "prosody.duration_lstm.b_ih"
            ),
            TensorMap(
                "predictor.duration_proj.lstm.bias_hh_l0", "prosody.duration_lstm.b_hh"
            ),
            TensorMap(
                "predictor.duration_proj.linear.weight",
                "prosody.duration_proj.weight",
            ),
            TensorMap(
                "predictor.duration_proj.linear.bias", "prosody.duration_proj.bias"
            ),
        ]
    )
    # F0 + N predictor: 3 conv blocks each with norm.
    for kind in ("F0", "N"):
        for i in range(3):
            b = f"predictor.{kind}.{i}"
            d = f"prosody.{kind.lower()}_predictor.block_{i}"
            out.extend(
                [
                    TensorMap(f"{b}.conv.weight", f"{d}.conv.weight"),
                    TensorMap(f"{b}.conv.bias", f"{d}.conv.bias"),
                    TensorMap(f"{b}.norm.weight", f"{d}.norm.weight"),
                    TensorMap(f"{b}.norm.bias", f"{d}.norm.bias"),
                ]
            )
        out.append(
            TensorMap(
                f"predictor.{kind}_proj.weight", f"prosody.{kind.lower()}_proj.weight"
            )
        )
        out.append(
            TensorMap(
                f"predictor.{kind}_proj.bias", f"prosody.{kind.lower()}_proj.bias"
            )
        )
    return out


def istftnet_tensor_plan() -> list[TensorMap]:
    out: list[TensorMap] = [
        TensorMap("decoder.encode.weight", "istftnet.input_proj.weight"),
        TensorMap("decoder.encode.bias", "istftnet.input_proj.bias"),
    ]
    for i in range(KOKORO_ISTFTNET_BLOCKS):
        b = f"decoder.generator.ups.{i}"
        d = f"istftnet.blocks.{i}"
        out.append(TensorMap(f"{b}.weight", f"{d}.upsample_conv.weight"))
        out.append(TensorMap(f"{b}.bias", f"{d}.upsample_conv.bias"))
        # Multi-Receptive-Field residual blocks (3 per upsample, 3 convs each).
        for j in range(3):
            for k in range(3):
                bb = f"decoder.generator.resblocks.{i*3+j}.convs1.{k}"
                dd = f"{d}.mrf.{j}.convs.{k}"
                out.append(TensorMap(f"{bb}.weight", f"{dd}.weight"))
                out.append(TensorMap(f"{bb}.bias", f"{dd}.bias"))
            # Snake parameters (per residual block).
            out.append(
                TensorMap(
                    f"decoder.generator.resblocks.{i*3+j}.activations.0.alpha",
                    f"{d}.mrf.{j}.snake.alpha",
                )
            )
    out.extend(
        [
            TensorMap("decoder.generator.conv_post.weight", "istftnet.output_conv.weight"),
            TensorMap("decoder.generator.conv_post.bias", "istftnet.output_conv.bias"),
        ]
    )
    return out


def synthetic_istft_basis_tensors(np) -> dict[str, Any]:
    """Materialize the frozen iSTFT synthesis basis as a fixed tensor.

    iSTFTNet predicts (magnitude, phase) at n_fft/2+1 bins; the recovery is

        x_t = sum_{k=0}^{n_fft-1} basis[t, k] * spec[k]

    with `basis` derived from a Hann window of length `win_length` overlapped
    at stride `hop_length`. Pre-computing the basis here means the C++ engine
    treats iSTFT as a fixed-weight CONV_TRANSPOSE_1D (per the feasibility
    memo).
    """
    n_fft = KOKORO_N_FFT
    hop = KOKORO_HOP_LENGTH
    win = KOKORO_WIN_LENGTH
    assert n_fft >= win, "n_fft must be >= win_length"

    # Hann window padded to n_fft.
    hann = 0.5 * (1.0 - np.cos(2.0 * math.pi * np.arange(win) / win))
    window = np.zeros(n_fft, dtype=np.float32)
    pad = (n_fft - win) // 2
    window[pad : pad + win] = hann.astype(np.float32)

    # iSTFT basis: 2 channels (cos, sin) per FFT bin, length n_fft each,
    # multiplied by the synthesis window. Output shape:
    # [n_fft (kernel length), 2*(n_fft//2 + 1) (in-channels)].
    n_bins = n_fft // 2 + 1
    basis = np.zeros((n_fft, 2 * n_bins), dtype=np.float32)
    for k in range(n_bins):
        freq = 2.0 * math.pi * k / n_fft
        t = np.arange(n_fft, dtype=np.float32)
        basis[:, 2 * k] = np.cos(freq * t) * window
        basis[:, 2 * k + 1] = -np.sin(freq * t) * window
    return {
        "istftnet.istft.basis.weight": basis,
        "istftnet.istft.window.weight": window,
    }


# ---------------------------------------------------------------------------
# GGUF writer
# ---------------------------------------------------------------------------


def write_kv_header(w, *, synthetic: bool) -> None:
    w.add_string("general.architecture", "kokoro")
    w.add_string("general.name", f"kokoro-82m-{KOKORO_VERSION}")
    w.add_string("kokoro.version", KOKORO_VERSION)
    w.add_uint32("kokoro.sample_rate", KOKORO_SAMPLE_RATE)
    w.add_uint32("kokoro.hop_length", KOKORO_HOP_LENGTH)
    w.add_uint32("kokoro.win_length", KOKORO_WIN_LENGTH)
    w.add_uint32("kokoro.n_fft", KOKORO_N_FFT)
    w.add_uint32("kokoro.phoneme_vocab_size", KOKORO_PHONEME_VOCAB)
    w.add_uint32("kokoro.max_phoneme_length", KOKORO_MAX_PHONEME)
    w.add_uint32("kokoro.text_encoder.depth", KOKORO_TEXT_ENCODER_DEPTH)
    w.add_uint32("kokoro.text_encoder.hidden", KOKORO_TEXT_ENCODER_HIDDEN)
    w.add_uint32("kokoro.text_encoder.n_head", KOKORO_TEXT_ENCODER_HEADS)
    w.add_uint32("kokoro.style_dim", KOKORO_STYLE_DIM)
    w.add_uint32("kokoro.istftnet.n_blocks", KOKORO_ISTFTNET_BLOCKS)
    w.add_uint32("kokoro.istftnet.n_mels", KOKORO_ISTFTNET_N_MELS)
    # Lists.
    w.add_array("kokoro.istftnet.upsample_rates", KOKORO_ISTFTNET_UPSAMPLE_RATES)
    if synthetic:
        w.add_bool("kokoro.synthetic", True)


def all_tensor_plans() -> list[TensorMap]:
    return (
        text_encoder_tensor_plan()
        + prosody_predictor_tensor_plan()
        + istftnet_tensor_plan()
    )


def write_synthetic_gguf(out_path: Path) -> int:
    """Write a tiny GGUF with the right KV header and zero-init tensors.

    Used by CI and by the fork's FFI symbol-verification step to confirm
    `eliza_inference_tts_synthesize_stream` recognises a Kokoro arch at all.
    The tensor shapes are correct, the values are not.
    """
    try:
        import numpy as np
        import gguf
    except ImportError as exc:
        raise SystemExit(
            "synthetic mode needs numpy + gguf (`pip install numpy gguf`)"
        ) from exc

    w = gguf.GGUFWriter(str(out_path), "kokoro")
    write_kv_header(w, synthetic=True)

    # We don't have a real state dict, so emit tiny tensors with the right
    # names so the loader can probe the header. Shape per tensor is the
    # smallest valid shape (1,1) or (1,) - the C++ loader rejects synthetic
    # GGUFs at runtime, but the conversion script must still pass type
    # checks.
    for tm in all_tensor_plans():
        shape = (1, 1) if "weight" in tm.dst_name else (1,)
        w.add_tensor(tm.dst_name, np.zeros(shape, dtype=np.float32))

    # iSTFT basis tensors are real (they're a closed-form constant).
    for name, arr in synthetic_istft_basis_tensors(np).items():
        w.add_tensor(name, arr)

    w.write_header_to_file()
    w.write_kv_data_to_file()
    w.write_tensors_to_file()
    w.close()
    log("synthetic", f"wrote {out_path}")
    return 0


def write_real_gguf(src_dir: Path, out_path: Path) -> int:
    """Load the PyTorch state dict from `src_dir`, walk the tensor plan, and
    write a real GGUF with native dtypes preserved.
    """
    try:
        import numpy as np  # noqa: F401
        import gguf
        import torch
    except ImportError as exc:
        raise SystemExit(
            "real conversion needs numpy + gguf + torch "
            "(`pip install numpy gguf torch`)"
        ) from exc

    # Try several common ckpt filenames.
    candidates = [
        src_dir / "kokoro-v1_0.pth",
        src_dir / "kokoro.pth",
        src_dir / "model.pt",
    ]
    ckpt_path = next((p for p in candidates if p.exists()), None)
    if ckpt_path is None:
        raise SystemExit(
            f"no Kokoro checkpoint found under {src_dir}; expected one of "
            f"{[c.name for c in candidates]}"
        )
    log("load", f"reading {ckpt_path}")
    state = torch.load(str(ckpt_path), map_location="cpu", weights_only=False)
    if not isinstance(state, dict):
        raise SystemExit(
            f"checkpoint {ckpt_path} did not deserialise to a state dict "
            f"(got {type(state).__name__})"
        )
    # `kokoro-v1_0.pth` ships as {'net': KModel-state-dict-with-name-prefix}.
    if "net" in state and isinstance(state["net"], dict):
        sd = state["net"]
    elif "model" in state and isinstance(state["model"], dict):
        sd = state["model"]
    else:
        sd = state  # type: ignore[assignment]

    w = gguf.GGUFWriter(str(out_path), "kokoro")
    write_kv_header(w, synthetic=False)

    missing: list[str] = []
    written = 0
    for tm in all_tensor_plans():
        if tm.src_name not in sd:
            missing.append(tm.src_name)
            continue
        t = sd[tm.src_name]
        # Convert the torch tensor to numpy, preserving dtype where useful.
        if t.dtype == torch.bfloat16:
            arr = t.detach().to(torch.float32).cpu().numpy()
            # gguf-py supports BF16 natively, but the upstream Kokoro ckpt
            # is float32 anyway - this branch stays as a guard for future
            # mixed-precision releases.
            w.add_tensor(tm.dst_name, arr)
        elif t.dtype in (torch.float16, torch.float32):
            arr = t.detach().to(torch.float32).cpu().numpy()
            w.add_tensor(tm.dst_name, arr)
        else:
            raise SystemExit(
                f"unsupported torch dtype {t.dtype} for tensor {tm.src_name}"
            )
        written += 1

    # iSTFT basis tensors (closed-form, always written regardless of ckpt).
    import numpy as np
    for name, arr in synthetic_istft_basis_tensors(np).items():
        w.add_tensor(name, arr)

    if missing:
        log("warn", f"{len(missing)} tensors missing from the source ckpt:")
        for name in missing[:10]:
            log("warn", f"  - {name}")
        if len(missing) > 10:
            log("warn", f"  ... and {len(missing) - 10} more")
        raise SystemExit(
            "refusing to write incomplete GGUF; update the tensor plan "
            "in this script to match the upstream state dict"
        )

    w.write_header_to_file()
    w.write_kv_data_to_file()
    w.write_tensors_to_file()
    w.close()
    log("done", f"wrote {out_path} ({written} model tensors + 2 iSTFT bases)")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "Convert a Kokoro-82M PyTorch checkpoint to GGUF for the fused "
            "kokoro-core engine in plugins/plugin-local-inference/native/llama.cpp."
        )
    )
    p.add_argument(
        "--src",
        type=Path,
        default=None,
        help=(
            "Directory containing the Kokoro PyTorch checkpoint (e.g. an HF "
            "snapshot of hexgrad/Kokoro-82M). Required unless --synthetic."
        ),
    )
    p.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Output GGUF path (typically kokoro-82m-v1_0.gguf).",
    )
    p.add_argument(
        "--synthetic",
        action="store_true",
        help=(
            "Write a tiny zero-init GGUF with the correct KV header. Used "
            "by CI and FFI symbol checks."
        ),
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.synthetic:
        return write_synthetic_gguf(args.out)
    if args.src is None:
        log("error", "--src is required for real conversion (or pass --synthetic)")
        return 2
    if not args.src.is_dir():
        log("error", f"--src must be an existing directory ({args.src})")
        return 2
    return write_real_gguf(args.src, args.out)


if __name__ == "__main__":
    raise SystemExit(main())
