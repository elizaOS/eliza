#!/usr/bin/env python3
"""Extract a Kokoro voice-style embedding (`ref_s`) from a directory of clips.

This is the fast path: NO LoRA training required. The user provides ~30 seconds
of clean audio (more is better up to ~5 min), we fit Kokoro's frozen 256-dim
`ref_s` tensor against the clips, and write a `voice.bin` file in the canonical
Kokoro voice-pack format.

Canonical format (matches `voices/<voice>.pt` shipped with hexgrad/Kokoro-82M):

    np.float32 array, shape (N, 1, 256), little-endian, raw bytes.
    N = 510 (one ref_s per phoneme-length bucket, 1..510).

For a single static voice we use the same ref_s for every bucket — Kokoro's
length-gated table is mainly useful when the source data has length-dependent
prosody, which a voice clone from a small set of clips does not.

The `kokoro` PyPI package (>=0.9.4) does NOT expose a standalone `style_encoder`
that turns an audio waveform into a ref_s directly. Two cloning modes are
supported:

  1. ``mel-fit`` (default when corpus has transcripts): minimize mel-spectrogram
     reconstruction loss between Kokoro's synthesized audio and the reference
     clips by gradient-descent on ref_s alone. Requires transcripts (loaded
     from sibling `.txt` files next to each `.wav`, LJSpeech-style). The model
     is frozen — only the 256-dim ref_s tensor receives gradients. Works on
     CPU for tiny corpora (under 1 min); meaningfully faster on CUDA.

  2. ``style-encoder``: use a separately-loaded StyleTTS-2 style encoder
     (NOT bundled in kokoro PyPI). When ``--style-encoder-checkpoint`` is
     supplied, load a TorchScript or state-dict file and run the existing
     mean-pooling path. Forward-compat for an upstream that exposes the
     style encoder again.

Initialization: when ``--init-from-voice <id>`` (e.g. ``af_bella``) is passed,
ref_s starts from that voice instead of zero; for small corpora this gives
the optimizer a sane prior and converges faster.

Usage:

    # Voice-clone path (mel-fit) — what Voice Wave 2 / I7 uses for sam:
    python3 scripts/kokoro/extract_voice_embedding.py \\
        --clips-dir packages/training/data/voice/same/audio \\
        --transcripts-dir /tmp/ai_voices/sam \\
        --base-model hexgrad/Kokoro-82M \\
        --init-from-voice af_bella \\
        --steps 200 \\
        --out /tmp/af_same.bin

    # CI smoke (no torch, no model): emits a zero-vector voice.bin so the
    # downstream tools can validate format without a GPU.
    python3 scripts/kokoro/extract_voice_embedding.py --synthetic-smoke --out /tmp/v.bin
"""

from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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


def _load_transcripts(
    clips: list[Path],
    transcripts_dir: Path | None,
) -> dict[str, str]:
    """Map clip-stem → transcript text. Reads sibling `.txt` next to each `.wav`
    when ``transcripts_dir`` is None; otherwise reads from ``transcripts_dir``.

    Skips clips whose transcript is unreadable or empty — the caller drops
    those clips from the mel-fit loop.
    """
    out: dict[str, str] = {}
    for clip in clips:
        if transcripts_dir is None:
            cand = clip.with_suffix(".txt")
        else:
            cand = transcripts_dir / f"{clip.stem}.txt"
        if not cand.exists():
            continue
        try:
            text = cand.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if not text:
            continue
        out[clip.stem] = text
    return out


def _init_ref_s_from_voice(
    voice_id: str,
    base_model: str,
    device: str,
) -> Any:
    """Download `voices/<voice_id>.pt` from the base-model HF repo and return
    a 256-dim ref_s tensor (first bucket, mean if multi-bucket). Raises
    SystemExit when the voice is not present in the HF repo.
    """
    import torch  # noqa: PLC0415
    from huggingface_hub import hf_hub_download  # noqa: PLC0415

    try:
        fp = hf_hub_download(base_model, f"voices/{voice_id}.pt")
    except Exception as exc:  # noqa: BLE001 — HF raises a wide tree, OK to widen
        raise SystemExit(
            f"failed to download voices/{voice_id}.pt from {base_model}: {exc}"
        ) from exc
    voice = torch.load(fp, map_location="cpu", weights_only=True)
    # Stock voices are (510, 1, 256); collapse to a single 256-dim init.
    if voice.dim() == 3 and voice.shape == (VOICE_BUCKETS, 1, VOICE_DIM):
        init = voice.mean(dim=0).squeeze().to(device)
    elif voice.dim() == 1 and voice.shape[0] == VOICE_DIM:
        init = voice.to(device)
    else:
        raise SystemExit(
            f"unexpected voice tensor shape {tuple(voice.shape)} in voices/{voice_id}.pt"
        )
    return init.float()


def _phonemize_transcript(text: str, lang: str = "a") -> str:
    """Phonemize via misaki (the same phonemizer kokoro uses). Returns the
    phoneme string suitable for KModel.forward (which maps phonemes -> ids).
    """
    from misaki import en  # type: ignore  # noqa: PLC0415

    # misaki returns (phonemes, tokens). We only need the phoneme string.
    # The kokoro pipeline uses en.G2P() under the hood; instantiate once.
    if not hasattr(_phonemize_transcript, "_g2p"):
        _phonemize_transcript._g2p = en.G2P(trf=False, british=(lang == "b"))  # type: ignore[attr-defined]
    g2p = _phonemize_transcript._g2p  # type: ignore[attr-defined]
    phonemes, _ = g2p(text)
    return phonemes


def _audio_to_mel(wav: Any, sample_rate: int) -> Any:
    """Compute an 80-bin log-mel matching Kokoro's iSTFTNet output.

    Kokoro uses StyleTTS-2's mel spec: n_fft=2048, hop_length=300, win_length=1200,
    n_mels=80, fmin=0, fmax=12000 at 24 kHz. This mirrors the decoder.MelSpec
    used during training.
    """
    import torch  # noqa: PLC0415
    import torchaudio  # noqa: PLC0415

    mel_fn = torchaudio.transforms.MelSpectrogram(
        sample_rate=sample_rate,
        n_fft=2048,
        win_length=1200,
        hop_length=300,
        n_mels=80,
        f_min=0,
        f_max=sample_rate // 2,
        power=1.0,
        normalized=False,
    )
    if not isinstance(wav, torch.Tensor):
        wav = torch.from_numpy(wav)
    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    mel = mel_fn(wav.float())
    # Match StyleTTS-2's log-mel convention.
    return torch.log(torch.clamp(mel, min=1e-5))


def _fit_ref_s_via_mel(
    args: argparse.Namespace,
    clips: list[Path],
    transcripts: dict[str, str],
) -> Any:
    """Optimize a single 256-dim ref_s tensor by minimizing mel-reconstruction
    loss between Kokoro's synthesized audio and the reference clips.

    Returns a (256,) float32 tensor on CPU.
    """
    import torch  # noqa: PLC0415
    from kokoro import KModel  # type: ignore  # noqa: PLC0415

    device = (
        "cuda"
        if torch.cuda.is_available()
        else ("mps" if torch.backends.mps.is_available() else "cpu")
    )
    log.info("device=%s steps=%d clips_with_transcripts=%d/%d", device, args.steps, len(transcripts), len(clips))

    # Note: we keep the model in `train()` mode so cuDNN RNN backward works
    # (cuDNN refuses to compute RNN gradients in eval mode). All parameters
    # are frozen — only ref_s receives gradients.
    model = KModel(repo_id=args.base_model).to(device).train()
    for p in model.parameters():
        p.requires_grad_(False)

    # Initial ref_s + anchor (the init point we regularize toward).
    if args.init_from_voice:
        anchor = _init_ref_s_from_voice(args.init_from_voice, args.base_model, device).detach()
        ref_s = anchor.clone()
        log.info("initialized ref_s from voice %s", args.init_from_voice)
    else:
        anchor = torch.zeros((VOICE_DIM,), device=device)
        ref_s = anchor.clone()
        log.info("initialized ref_s as zero vector")
    ref_s.requires_grad_(True)

    optimizer = torch.optim.Adam([ref_s], lr=args.lr)
    # L2 anchor regularization keeps the prosody half (ref_s[128:], which feeds
    # the duration/F0 predictor) close to the init point. Without this, the
    # mel-fit optimization happily destabilizes duration prediction (e.g. 5s
    # of audio for the init voice → 30s for an over-fit voice on the same
    # prompt). Apply only on the prosody half; the timbre half (ref_s[:128])
    # feeds the decoder and is fine to move freely.
    anchor_prosody = anchor[128:]

    # Pre-compute target mels + phonemized input_ids for each clip-with-transcript.
    pairs: list[tuple[Any, Any]] = []  # (input_ids, target_mel)
    for clip in clips:
        text = transcripts.get(clip.stem)
        if text is None:
            continue
        wav = _load_wav_mono(clip, target_sr=args.sample_rate)
        target_mel = _audio_to_mel(wav, args.sample_rate).to(device)
        try:
            phonemes = _phonemize_transcript(text, lang=args.voice_lang)
        except Exception as exc:  # noqa: BLE001 — phonemizer can raise on weird text
            log.warning("phonemize failed for %s: %s", clip.name, exc)
            continue
        ids_list = [model.vocab[p] for p in phonemes if p in model.vocab]
        if len(ids_list) + 2 > model.context_length:
            log.warning("skipping %s: phoneme sequence too long (%d > %d)", clip.name, len(ids_list) + 2, model.context_length)
            continue
        input_ids = torch.LongTensor([[0, *ids_list, 0]]).to(device)
        pairs.append((input_ids, target_mel))

    if not pairs:
        raise SystemExit("no usable (clip, transcript) pairs after filtering")

    log.info("mel-fit corpus: %d pairs", len(pairs))

    # Mel synthesis function: convert generated audio back to log-mel and L1-compare.
    import torchaudio  # noqa: PLC0415
    mel_fn = torchaudio.transforms.MelSpectrogram(
        sample_rate=args.sample_rate,
        n_fft=2048,
        win_length=1200,
        hop_length=300,
        n_mels=80,
        f_min=0,
        f_max=args.sample_rate // 2,
        power=1.0,
        normalized=False,
    ).to(device)

    def _audio_to_logmel(audio: Any) -> Any:
        if audio.dim() == 1:
            audio = audio.unsqueeze(0)
        mel = mel_fn(audio.float())
        return torch.log(torch.clamp(mel, min=1e-5))

    # `model.forward_with_tokens` is wrapped in @torch.no_grad. Override locally:
    # we need gradients to flow back to ref_s, so we re-implement the forward
    # without the no_grad decorator.
    def _forward_with_grad(input_ids: Any, ref_s_full: Any) -> Any:
        input_lengths = torch.full(
            (input_ids.shape[0],),
            input_ids.shape[-1],
            device=input_ids.device,
            dtype=torch.long,
        )
        text_mask = (
            torch.arange(int(input_lengths.max())).unsqueeze(0)
            .expand(input_lengths.shape[0], -1).type_as(input_lengths)
        )
        text_mask = torch.gt(text_mask + 1, input_lengths.unsqueeze(1)).to(device)
        bert_dur = model.bert(input_ids, attention_mask=(~text_mask).int())
        d_en = model.bert_encoder(bert_dur).transpose(-1, -2)
        s = ref_s_full[:, 128:]
        d = model.predictor.text_encoder(d_en, s, input_lengths, text_mask)
        x, _ = model.predictor.lstm(d)
        duration = model.predictor.duration_proj(x)
        duration = torch.sigmoid(duration).sum(axis=-1)
        # Use round only at inference; here use the soft duration for differentiability.
        pred_dur = torch.round(duration).clamp(min=1).long().squeeze()
        indices = torch.repeat_interleave(
            torch.arange(input_ids.shape[1], device=device), pred_dur
        )
        pred_aln_trg = torch.zeros(
            (input_ids.shape[1], indices.shape[0]), device=device
        )
        pred_aln_trg[indices, torch.arange(indices.shape[0])] = 1
        pred_aln_trg = pred_aln_trg.unsqueeze(0).to(device)
        en = d.transpose(-1, -2) @ pred_aln_trg
        F0_pred, N_pred = model.predictor.F0Ntrain(en, s)
        t_en = model.text_encoder(input_ids, input_lengths, text_mask)
        asr = t_en @ pred_aln_trg
        audio = model.decoder(asr, F0_pred, N_pred, ref_s_full[:, :128]).squeeze()
        return audio

    # Training loop.
    losses: list[float] = []
    step = 0
    while step < args.steps:
        # Cycle through pairs in order.
        for input_ids, target_mel in pairs:
            if step >= args.steps:
                break
            optimizer.zero_grad(set_to_none=True)
            ref_s_full = ref_s.unsqueeze(0)  # (1, 256)
            try:
                synth_audio = _forward_with_grad(input_ids, ref_s_full)
            except torch.cuda.OutOfMemoryError as exc:
                log.warning("OOM at step %d, dropping batch: %s", step, str(exc).split("\n")[0])
                torch.cuda.empty_cache()
                step += 1
                continue
            except Exception as exc:  # noqa: BLE001
                log.warning("forward failed at step %d: %s", step, exc)
                step += 1
                continue
            synth_mel = _audio_to_logmel(synth_audio)
            # Crop to min length to allow comparison even if synth duration mismatched.
            t_min = min(synth_mel.shape[-1], target_mel.shape[-1])
            recon_loss = (synth_mel[..., :t_min] - target_mel[..., :t_min]).abs().mean()
            # Anchor regularization on the prosody half of ref_s. weight=0.5
            # is enough to keep duration prediction stable while still letting
            # the timbre half (ref_s[:128]) move freely.
            anchor_loss = (ref_s[128:] - anchor_prosody).pow(2).mean()
            loss = recon_loss + args.anchor_weight * anchor_loss
            loss.backward()
            optimizer.step()
            losses.append(float(loss.detach().cpu()))
            if step % args.log_every == 0:
                log.info("step %d/%d loss=%.4f", step, args.steps, losses[-1])
            step += 1

    if losses:
        log.info(
            "mel-fit done: final loss=%.4f mean(last10)=%.4f",
            losses[-1],
            sum(losses[-10:]) / max(1, len(losses[-10:])),
        )

    return ref_s.detach().cpu(), losses


def _extract_with_style_encoder(args: argparse.Namespace, clips: list[Path]) -> Any:
    """Legacy/forward-compat path: load a separately-supplied StyleTTS-2 style
    encoder checkpoint and average ref_s over the clips. Used when an upstream
    style encoder is available.
    """
    import torch  # noqa: PLC0415

    device = (
        "cuda"
        if torch.cuda.is_available()
        else ("mps" if torch.backends.mps.is_available() else "cpu")
    )
    style_encoder = torch.jit.load(str(args.style_encoder_checkpoint), map_location=device).eval()

    vectors: list[Any] = []
    with torch.no_grad():
        for clip in clips:
            wav = _load_wav_mono(clip, target_sr=args.sample_rate)
            wav_t = torch.from_numpy(wav).unsqueeze(0).to(device)
            ref_s = style_encoder(wav_t)
            vectors.append(ref_s.squeeze().detach().cpu())
    return torch.stack(vectors, dim=0).mean(dim=0).float()


def _extract_with_kokoro(args: argparse.Namespace) -> int:
    try:
        import numpy as np  # noqa: PLC0415
        import torch  # noqa: F401, PLC0415
    except ImportError as exc:
        raise SystemExit(
            "Real extraction needs torch + the `kokoro` package. Install via "
            "`pip install -r packages/training/scripts/kokoro/requirements.txt`."
        ) from exc

    clips = _collect_clips(Path(args.clips_dir), args.max_clips)
    log.info("found %d clips under %s", len(clips), args.clips_dir)

    if args.style_encoder_checkpoint is not None:
        mean_vec = _extract_with_style_encoder(args, clips).numpy().astype(np.float32)
        mode = "style-encoder"
        losses: list[float] = []
    else:
        transcripts_dir = (
            Path(args.transcripts_dir) if args.transcripts_dir else Path(args.clips_dir)
        )
        transcripts = _load_transcripts(clips, transcripts_dir)
        if not transcripts:
            raise SystemExit(
                "mel-fit mode needs sibling `.txt` transcripts next to each `.wav`, "
                "or --transcripts-dir pointing at the upstream transcripts. "
                "If you have a StyleTTS-2 style encoder TorchScript, pass it "
                "via --style-encoder-checkpoint."
            )
        ref_s_final, losses = _fit_ref_s_via_mel(args, clips, transcripts)
        mean_vec = ref_s_final.numpy().astype(np.float32)
        mode = "mel-fit"

    if mean_vec.shape != (VOICE_DIM,):
        raise SystemExit(
            f"voice extractor returned vector of shape {mean_vec.shape}; expected ({VOICE_DIM},)."
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
                "mode": mode,
                "steps": args.steps if mode == "mel-fit" else None,
                "initFromVoice": args.init_from_voice if mode == "mel-fit" else None,
                "finalLoss": losses[-1] if losses else None,
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
        + "\n"
    )
    log.info("wrote %s + %s (%d clips, mode=%s)", out, sidecar, len(clips), mode)
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
    p.add_argument("--voice-lang", default="a", choices=["a", "b"], help="Phonemizer lang: a=US English, b=British English.")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help="Emit a zero-vector voice.bin without loading the model (CI smoke).",
    )
    p.add_argument(
        "--transcripts-dir",
        type=Path,
        default=None,
        help="Optional directory of sibling .txt transcripts (default: same as --clips-dir).",
    )
    p.add_argument(
        "--steps",
        type=int,
        default=200,
        help="Mel-fit optimization steps (passes over clip set). Default 200.",
    )
    p.add_argument(
        "--lr",
        type=float,
        default=0.01,
        help="Learning rate for ref_s optimization. Default 0.01. Higher rates "
        "(0.05+) destabilize duration prediction even with anchor regularization.",
    )
    p.add_argument(
        "--log-every",
        type=int,
        default=10,
        help="Log loss every N steps. Default 10.",
    )
    p.add_argument(
        "--init-from-voice",
        type=str,
        default=None,
        help="Initialize ref_s from a stock voice (e.g. af_bella) before fitting. Default: zero.",
    )
    p.add_argument(
        "--anchor-weight",
        type=float,
        default=0.5,
        help="L2 regularization weight pulling the prosody half of ref_s "
        "(ref_s[128:], feeds duration/F0 predictor) toward the init point. "
        "0.0 disables; 0.5 keeps duration stable. Default 0.5.",
    )
    p.add_argument(
        "--style-encoder-checkpoint",
        type=Path,
        default=None,
        help="Optional TorchScript style encoder (legacy path). When set, skips mel-fit and uses the encoder forward.",
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


if __name__ == "__main__":
    raise SystemExit(main())
