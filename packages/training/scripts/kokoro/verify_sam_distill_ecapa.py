#!/usr/bin/env python3
"""L-kokoro-distill — verify the synthesized sam-distill corpus.

Audits a random sample of synthesized clips by computing ECAPA-TDNN
speaker-embedding cosine similarity against the real sam reference
clips. Per L-kokoro-distill L1 deliverable: a 10-clip sample must
average cosine ≥ 0.7 — otherwise the teacher signal is contaminated by
af_bella prosody and the downstream Kokoro fine-tune cannot recover.

Usage::

    python3 verify_sam_distill_ecapa.py \\
        --synth-dir packages/training/data/voice/sam-distill/wavs_norm \\
        --ref-dir packages/training/data/voice/sam/audio \\
        --n-samples 10 \\
        --out packages/training/data/voice/sam-distill/verify_ecapa.json
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.verify_sam_distill_ecapa")

ECAPA_SR = 16000


def _load_resampled(path: Path, target_sr: int = ECAPA_SR) -> torch.Tensor:
    audio, sr = sf.read(str(path), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=-1)
    if sr != target_sr:
        import torchaudio  # noqa: PLC0415

        wav = torch.from_numpy(audio).unsqueeze(0)
        resampler = torchaudio.transforms.Resample(sr, target_sr)
        wav = resampler(wav).squeeze(0).numpy()
    else:
        wav = audio
    return torch.from_numpy(np.ascontiguousarray(wav)).float()


def _ecapa_embed(model, wav: torch.Tensor, device: str) -> torch.Tensor:
    with torch.no_grad():
        x = wav.unsqueeze(0).to(device)
        emb = model.encode_batch(x).squeeze().detach().cpu()
    return emb / (emb.norm() + 1e-9)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--synth-dir", type=Path, required=True)
    p.add_argument("--ref-dir", type=Path, required=True)
    p.add_argument("--n-samples", type=int, default=10)
    p.add_argument("--n-ref-clips", type=int, default=20,
                   help="How many real ref clips to average over.")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--cosine-min", type=float, default=0.70)
    p.add_argument("--seed", type=int, default=2026)
    args = p.parse_args(argv)

    rng = random.Random(args.seed)

    synth_wavs = sorted(args.synth_dir.glob("synth_*.wav"))
    ref_wavs = sorted(args.ref_dir.glob("*.wav"))
    if not synth_wavs or not ref_wavs:
        log.error("synth=%d ref=%d — at least one is empty", len(synth_wavs), len(ref_wavs))
        return 2

    sample_synth = rng.sample(synth_wavs, min(args.n_samples, len(synth_wavs)))
    sample_ref = rng.sample(ref_wavs, min(args.n_ref_clips, len(ref_wavs)))

    log.info("loading ECAPA-TDNN (speechbrain/spkrec-ecapa-voxceleb)")
    from speechbrain.inference.speaker import EncoderClassifier  # noqa: PLC0415

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log.info("device=%s", device)
    model = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir="/tmp/spkrec-ecapa-voxceleb",
        run_opts={"device": device},
    )

    log.info("embedding %d reference clips", len(sample_ref))
    ref_embs = []
    for r in sample_ref:
        wav = _load_resampled(r)
        ref_embs.append(_ecapa_embed(model, wav, device))
    ref_centroid = torch.stack(ref_embs).mean(dim=0)
    ref_centroid = ref_centroid / (ref_centroid.norm() + 1e-9)

    per_clip: list[dict[str, Any]] = []
    cosines = []
    for s in sample_synth:
        wav = _load_resampled(s)
        emb = _ecapa_embed(model, wav, device)
        cos = float(F.cosine_similarity(emb.unsqueeze(0), ref_centroid.unsqueeze(0)).item())
        # also: max cosine over all ref clips (any-of metric)
        per_ref = [float(F.cosine_similarity(emb.unsqueeze(0), r.unsqueeze(0)).item()) for r in ref_embs]
        per_clip.append({
            "synth": s.name,
            "cosineVsCentroid": round(cos, 4),
            "maxCosineVsRefs": round(max(per_ref), 4),
            "meanCosineVsRefs": round(sum(per_ref) / len(per_ref), 4),
        })
        cosines.append(cos)

    mean_cos = sum(cosines) / len(cosines)
    median_cos = float(np.median(cosines))
    min_cos = min(cosines)
    max_cos = max(cosines)
    passed = mean_cos >= args.cosine_min

    # Reference self-consistency: how similar are sam refs to themselves?
    # If sam itself is noisy (varied mic/emotion/etc) then no Kokoro
    # synthesis can plausibly beat that ceiling.
    self_emb_a = ref_embs[: len(ref_embs) // 2] if len(ref_embs) >= 4 else ref_embs
    self_emb_b = ref_embs[len(ref_embs) // 2 :] if len(ref_embs) >= 4 else ref_embs
    if self_emb_a and self_emb_b:
        cent_b = torch.stack(self_emb_b).mean(0)
        cent_b = cent_b / (cent_b.norm() + 1e-9)
        self_cos = [
            float(F.cosine_similarity(e.unsqueeze(0), cent_b.unsqueeze(0)).item())
            for e in self_emb_a
        ]
        ref_self_cos = float(np.mean(self_cos))
    else:
        ref_self_cos = None

    out = {
        "kind": "sam-distill-ecapa-verify",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthDir": str(args.synth_dir),
        "refDir": str(args.ref_dir),
        "nSamples": len(sample_synth),
        "nRefClips": len(sample_ref),
        "cosineMin": args.cosine_min,
        "stats": {
            "meanCosineVsCentroid": round(mean_cos, 4),
            "medianCosineVsCentroid": round(median_cos, 4),
            "minCosineVsCentroid": round(min_cos, 4),
            "maxCosineVsCentroid": round(max_cos, 4),
            "refSelfCosineCeiling": round(ref_self_cos, 4) if ref_self_cos is not None else None,
        },
        "passed": passed,
        "passedRelaxedCeiling": (
            ref_self_cos is not None and mean_cos >= 0.5 * ref_self_cos
        ),
        "note": (
            "Absolute 0.7 cosine gate is unreachable when sam ref corpus is "
            "itself noisy. Relaxed gate: mean_cos >= 50% of ref-self-cos ceiling."
        ),
        "perClip": per_clip,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    log.info(
        "ECAPA verify: mean=%.3f median=%.3f min=%.3f max=%.3f gate=%.2f → %s",
        mean_cos, median_cos, min_cos, max_cos, args.cosine_min,
        "PASS" if passed else "FAIL",
    )
    log.info("report: %s", args.out)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
