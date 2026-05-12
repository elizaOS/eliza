#!/usr/bin/env python3
"""Extract a Kokoro voice-style embedding (`ref_s`) from a directory of clips.

This is the fast path: NO training required. The user provides ~30 seconds of
clean audio (more is better up to ~5 min), we run it through Kokoro's frozen
style encoder, average the resulting 256-dim ref_s vectors, and write a
`voice.bin` file in the canonical Kokoro voice-pack format.

Canonical format (matches `voices/<voice>.bin` shipped with hexgrad/Kokoro-82M):

    np.float32 array, shape (N, 1, 256), little-endian, raw bytes.
    N = 510 (one ref_s per phoneme-length bucket, 1..510).

For a single static voice we use the same ref_s for every bucket — Kokoro's
length-gated table is mainly useful when the source data has length-dependent
prosody, which a voice clone from a small set of clips does not.

Usage:

    python3 scripts/kokoro/extract_voice_embedding.py \\
        --clips-dir /path/to/clean_clips \\
        --base-model hexgrad/Kokoro-82M \\
        --out /tmp/myvoice.bin

    # CI smoke (no torch, no model): emits a zero-vector voice.bin so the
    # downstream tools can validate format without a GPU.
    python3 scripts/kokoro/extract_voice_embedding.py --synthetic-smoke --out /tmp/v.bin
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.extract_voice_embedding")

VOICE_DIM = 256
VOICE_BUCKETS = 510


def _write_voice_bin(path: Path, vector: "list[float] | object") -> None:
    """Write `voice.bin` in the canonical (N, 1, 256) float32 LE layout."""
    import numpy as np  # noqa: PLC0415

    if hasattr(vector, "detach"):
        arr = vector.detach().cpu().numpy()
    else:
        arr = np.asarray(vector, dtype=np.float32)
    if arr.shape != (VOICE_DIM,):
        raise ValueError(f"expected 256-dim vector, got shape {arr.shape}")
    table = np.tile(arr.astype(np.float32)[None, None, :], (VOICE_BUCKETS, 1, 1))
    table.astype("<f4").tofile(str(path))


def _run_synthetic_smoke(args: argparse.Namespace) -> int:
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        import numpy as np  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit("numpy is required even for the smoke path") from exc
    _write_voice_bin(out, np.zeros((VOICE_DIM,), dtype=np.float32))
    sidecar = out.with_suffix(".json")
    sidecar.write_text(
        json.dumps(
            {
                "kind": "kokoro-voice-embedding",
                "synthetic": True,
                "voiceName": args.voice_name,
                "dim": VOICE_DIM,
                "buckets": VOICE_BUCKETS,
                "clips": 0,
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
        + "\n"
    )
    log.info("synthetic-smoke wrote %s + %s", out, sidecar)
    return 0


def _collect_clips(clips_dir: Path, max_clips: int) -> list[Path]:
    if not clips_dir.exists():
        raise FileNotFoundError(f"clips dir {clips_dir} does not exist")
    paths = sorted(p for p in clips_dir.glob("**/*.wav") if p.is_file())
    if not paths:
        raise FileNotFoundError(f"no .wav files under {clips_dir}")
    return paths[:max_clips]


def _extract_with_kokoro(args: argparse.Namespace) -> int:
    try:
        import numpy as np  # noqa: PLC0415
        import torch  # noqa: PLC0415
        from kokoro import KModel  # type: ignore  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit(
            "Real extraction needs torch + the `kokoro` package. Install via "
            "`pip install -r packages/training/scripts/kokoro/requirements.txt`."
        ) from exc

    clips = _collect_clips(Path(args.clips_dir), args.max_clips)
    log.info("found %d clips under %s", len(clips), args.clips_dir)

    device = (
        "cuda"
        if torch.cuda.is_available()
        else ("mps" if torch.backends.mps.is_available() else "cpu")
    )
    model = KModel(repo_id=args.base_model).to(device).eval()

    style_encoder = getattr(model, "style_encoder", None)
    if style_encoder is None:
        raise SystemExit(
            "Loaded KModel has no `style_encoder` attribute — check the kokoro package "
            "version. The canonical KModel exposes the StyleTTS-2 style encoder there."
        )

    vectors: list[Any] = []  # type: ignore[name-defined]
    with torch.no_grad():
        for clip in clips:
            wav = _load_wav_mono(clip, target_sr=args.sample_rate)
            wav_t = torch.from_numpy(wav).unsqueeze(0).to(device)
            ref_s = style_encoder(wav_t)
            vectors.append(ref_s.squeeze().detach().cpu())

    mean_vec = torch.stack(vectors, dim=0).mean(dim=0).numpy().astype(np.float32)
    if mean_vec.shape != (VOICE_DIM,):
        raise SystemExit(
            f"style encoder returned vectors of shape {mean_vec.shape}; expected ({VOICE_DIM},)."
        )

    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    _write_voice_bin(out, mean_vec)
    sidecar = out.with_suffix(".json")
    sidecar.write_text(
        json.dumps(
            {
                "kind": "kokoro-voice-embedding",
                "synthetic": False,
                "voiceName": args.voice_name,
                "dim": VOICE_DIM,
                "buckets": VOICE_BUCKETS,
                "clips": len(clips),
                "baseModel": args.base_model,
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
        + "\n"
    )
    log.info("wrote %s + %s (%d clips)", out, sidecar, len(clips))
    return 0


def _load_wav_mono(path: Path, *, target_sr: int):
    import librosa  # noqa: PLC0415

    y, _sr = librosa.load(str(path), sr=target_sr, mono=True)
    return y


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--clips-dir", type=Path, help="Directory of clean .wav clips.")
    p.add_argument("--base-model", default="hexgrad/Kokoro-82M")
    p.add_argument("--sample-rate", type=int, default=24000)
    p.add_argument("--max-clips", type=int, default=200)
    p.add_argument("--voice-name", default="eliza_custom")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help="Emit a zero-vector voice.bin without loading the model (CI smoke).",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.synthetic_smoke:
        return _run_synthetic_smoke(args)
    if not args.clips_dir:
        log.error("--clips-dir is required (or use --synthetic-smoke)")
        return 2
    return _extract_with_kokoro(args)


# ToolSearch wanted `Any`; expose for type hints without importing typing module.
from typing import Any  # noqa: E402,F401

if __name__ == "__main__":
    raise SystemExit(main())
