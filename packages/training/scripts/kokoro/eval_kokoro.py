#!/usr/bin/env python3
"""Evaluate a fine-tuned Kokoro checkpoint.

Computes four numbers and writes `<run-dir>/eval.json`. The canonical
definitions live in `docs/inference/voice-quality-metrics.md`; this
module is one of the consumers of that doc.

1. **UTMOS** (predicted MOS ∈ [1, 5]). Primary path is the SaruLab `utmos`
   PyPI package (the literal "U-Tokyo / SaruLab MOS" predictor). Fallback
   is `torchaudio.pipelines.SQUIM_SUBJECTIVE` — a non-matching-reference
   MOS predictor, also in [1, 5]. **NOT** SQUIM_OBJECTIVE: that returns
   (STOI, PESQ, SI-SDR), and SI-SDR is in dB, NOT MOS (Q1-quality audit
   §1.1). Both predictors run at 16 kHz; the eval resamples internally.

2. **WER** (word error rate) ∈ [0, +∞), gate ≤ 0.08. Round-trip through
   Whisper large-v3 (CUDA) / small (CPU): synthesize each eval transcript,
   resample to 16 kHz, transcribe, normalize text (lowercase + strip
   punctuation), Levenshtein WER against the reference.

3. **Speaker similarity** ∈ [-1, 1], gate ≥ 0.65 (relaxed 0.55 for
   small corpora — see `kokoro_same.yaml`). ECAPA-TDNN cosine
   between synth + reference, both resampled to 16 kHz (the rate
   speechbrain/spkrec-ecapa-voxceleb was trained on).

4. **RTF** (real-time factor) ∈ [0, +∞), gate ≥ 5.0.
   RTF = (synthesized audio seconds) / (wall clock seconds). Higher
   is faster; Kokoro 82M on RTX 5080 → ~100×.

The script applies the gates defined in the config (`config.gates`) and
emits a `passed: true|false` summary plus per-metric pass/fail. If
`--allow-gate-fail` is not set, a failed gate exits non-zero.

Synthetic-smoke (`--synthetic-smoke`) writes a stub eval.json with placeholder
metrics so downstream tooling can be tested without a real model.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from _config import load_config  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.eval")


def _apply_gates(metrics: dict[str, float], gates: dict[str, float]) -> dict[str, Any]:
    results = {
        "utmos": metrics["utmos"] >= gates["utmos_min"],
        "wer": metrics["wer"] <= gates["wer_max"],
        "speaker_similarity": metrics["speaker_similarity"] >= gates["speaker_similarity_min"],
        "rtf": metrics["rtf"] >= gates["rtf_min"],
    }
    return {"perMetric": results, "passed": all(results.values())}


# Comparison gate vs. a baseline eval (per R7 §4). The publish flow requires
# both `gateResult.passed` AND `comparison.beatsBaseline` so a fine-tune that
# clears the absolute gates but does NOT actually move the voice toward the
# target speaker is still rejected.
SPEAKER_SIM_BEAT_BASELINE_DELTA = 0.05


def _build_comparison(
    metrics: dict[str, float],
    baseline_path: Path,
) -> dict[str, Any]:
    """Diff the current run's metrics against a baseline eval.json.

    Returns the same shape every time so consumers (`push_voice_to_hf.py`,
    `publish_custom_kokoro_voice.sh`) can branch on `beatsBaseline`. If the
    baseline file is missing required fields the function raises rather
    than silently skipping — a malformed baseline is a publish-blocking bug,
    not a fall-through condition.
    """
    if not baseline_path.is_file():
        raise FileNotFoundError(f"baseline eval not found: {baseline_path}")
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    base_metrics = baseline.get("metrics")
    if not isinstance(base_metrics, dict):
        raise ValueError(
            f"baseline {baseline_path} missing `metrics` block (kind={baseline.get('kind')})"
        )
    required = ("utmos", "wer", "speaker_similarity", "rtf")
    missing = [k for k in required if k not in base_metrics]
    if missing:
        raise ValueError(f"baseline {baseline_path} missing metric keys: {missing}")

    utmos_delta = float(metrics["utmos"]) - float(base_metrics["utmos"])
    wer_delta = float(metrics["wer"]) - float(base_metrics["wer"])
    speaker_sim_delta = float(metrics["speaker_similarity"]) - float(
        base_metrics["speaker_similarity"]
    )
    rtf_delta = float(metrics["rtf"]) - float(base_metrics["rtf"])

    beats = (
        utmos_delta >= 0.0
        and wer_delta <= 0.0
        and speaker_sim_delta >= SPEAKER_SIM_BEAT_BASELINE_DELTA
    )

    return {
        "baselinePath": str(baseline_path),
        "baselineVoiceName": baseline.get("voiceName"),
        "baselineMetrics": {k: float(base_metrics[k]) for k in required},
        "utmosDelta": utmos_delta,
        "werDelta": wer_delta,
        "speakerSimDelta": speaker_sim_delta,
        "rtfDelta": rtf_delta,
        "speakerSimBeatThreshold": SPEAKER_SIM_BEAT_BASELINE_DELTA,
        "beatsBaseline": bool(beats),
    }


def _run_synthetic_smoke(args: argparse.Namespace, cfg: dict[str, Any]) -> int:
    metrics = {"utmos": 4.0, "wer": 0.04, "speaker_similarity": 0.78, "rtf": 12.5}
    gates_result = _apply_gates(metrics, cfg["gates"])
    out: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "kokoro-eval-report",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": True,
        "metrics": metrics,
        "gates": cfg["gates"],
        "gateResult": gates_result,
        "voiceName": cfg.get("voice_name", "eliza_custom"),
    }
    if args.baseline_eval:
        out["comparison"] = _build_comparison(metrics, Path(args.baseline_eval).resolve())
    out_path = Path(args.eval_out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    log.info("synthetic-smoke wrote %s", out_path)
    return 0


def _measure_rtf(synth_fn, prompts: list[str], device: str) -> tuple[float, float]:
    """Return (mean_rtf, total_audio_seconds)."""
    total_audio = 0.0
    total_wall = 0.0
    for prompt in prompts:
        t0 = time.time()
        audio, sr = synth_fn(prompt)
        dt = time.time() - t0
        total_audio += len(audio) / float(sr) if sr else 0.0
        total_wall += dt
    rtf = (total_audio / total_wall) if total_wall > 0 else 0.0
    return rtf, total_audio


def _real_eval(args: argparse.Namespace, cfg: dict[str, Any]) -> int:
    try:
        import numpy as np  # noqa: F401, PLC0415
        import torch  # noqa: PLC0415
        from kokoro import KPipeline  # type: ignore  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit(
            "Real eval needs torch + kokoro + whisper + speechbrain. Install via "
            "`pip install -r packages/training/scripts/kokoro/requirements.txt`."
        ) from exc

    run_dir = Path(args.run_dir).resolve()
    val_list_path = run_dir / "processed" / "val_list.txt"
    if not val_list_path.exists():
        raise FileNotFoundError(f"val_list.txt not found: {val_list_path}")
    val_lines = [line.strip() for line in val_list_path.read_text().splitlines() if line.strip()]
    if not val_lines:
        raise ValueError("val_list.txt is empty")

    # Pull text references from phonemes.jsonl (raw text is what Whisper compares against).
    phonemes_path = run_dir / "processed" / "phonemes.jsonl"
    by_id = {}
    if phonemes_path.exists():
        for line in phonemes_path.read_text().splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            by_id[rec["clip_id"]] = rec

    device = (
        "cuda"
        if torch.cuda.is_available()
        else ("mps" if torch.backends.mps.is_available() else "cpu")
    )
    pipeline = KPipeline(lang_code=cfg.get("voice_lang", "a"), repo_id=cfg["base_model"])

    # Voice resolution. The Kokoro `KPipeline.__call__` accepts:
    #   - a stock voice id string (e.g. "af_bella") — auto-downloads voices/<id>.pt
    #   - a path string ending in `.pt`
    #   - a torch.FloatTensor of shape (510, 1, 256)
    # eval_kokoro produces `.bin` files (raw float32 LE bytes); load those as a
    # tensor. When --voice-bin is not set, fall back to the baseline-voice id
    # (default af_bella) — this is what the absolute eval gates compare against.
    voice_bin = args.voice_bin
    if voice_bin and str(voice_bin).endswith(".bin"):
        import numpy as np  # noqa: PLC0415
        _arr = np.fromfile(str(voice_bin), dtype="<f4").reshape(510, 1, 256)
        voice_obj: Any = torch.from_numpy(_arr).float()
    elif voice_bin:
        voice_obj = str(voice_bin)
    else:
        voice_obj = args.baseline_voice_id

    def synth(prompt: str):
        out = pipeline(prompt, voice=voice_obj)
        for _gs, _ps, audio in out:
            return audio.cpu().numpy(), 24000
        raise RuntimeError("Kokoro pipeline produced no audio")

    # Whisper round-trip WER.
    import os  # noqa: PLC0415
    import whisper  # type: ignore  # noqa: PLC0415

    # ELIZA_KOKORO_EVAL_WHISPER overrides the default model when VRAM is
    # tight (e.g. RTX 5080 Laptop 16 GB with another GPU consumer running).
    # Default: large-v3 on CUDA (~6 GB), small on CPU.
    whisper_model = os.environ.get(
        "ELIZA_KOKORO_EVAL_WHISPER",
        "large-v3" if device == "cuda" else "small",
    )
    log.info("loading whisper model %s", whisper_model)
    asr = whisper.load_model(whisper_model)

    # ECAPA-TDNN speaker similarity.
    from speechbrain.inference.speaker import EncoderClassifier  # type: ignore  # noqa: PLC0415

    speaker_model = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        run_opts={"device": device},
    )

    # UTMOS — predicted MOS. Three candidate predictors, ordered by fidelity:
    #
    #   1. `utmos` PyPI package — SaruLab UTMOS, the canonical predictor (the
    #      "U" in UTMOS literally stands for "UTokyo-SaruLab MOS").
    #      Returns MOS ∈ [1, 5].
    #
    #   2. `torchaudio.pipelines.SQUIM_SUBJECTIVE` — non-matching-reference
    #      MOS predictor. Also returns MOS ∈ [1, 5]. Sample rate **16 kHz**.
    #
    #   3. **No** SQUIM_OBJECTIVE fallback. SQUIM_OBJECTIVE returns
    #      (STOI, PESQ, SI-SDR); the third tensor is SI-SDR in dB, NOT MOS.
    #      Using it was the source of the negative/30+ "UTMOS" numbers in
    #      I7's run (see .swarm/impl/Q1-quality.md §1.1).
    try:
        from utmos import Score as UtmosScore  # type: ignore  # noqa: PLC0415

        utmos = UtmosScore()

        def utmos_score(audio, sr):
            return float(utmos(audio, sr))

    except ImportError:
        log.warning(
            "utmos not installed; falling back to torchaudio SQUIM_SUBJECTIVE "
            "(MOS predictor with non-matching reference)"
        )
        from torchaudio.pipelines import SQUIM_SUBJECTIVE  # type: ignore  # noqa: PLC0415

        squim_sr = int(SQUIM_SUBJECTIVE.sample_rate)
        squim = SQUIM_SUBJECTIVE.get_model().to(device).eval()

        # SQUIM_SUBJECTIVE needs a non-matching clean reference (any clean
        # speech sample). We use the first val-set reference wav resampled
        # to the SQUIM sample rate. This is a documented use of the pipeline.
        first_ref_wav, _ = _load_wav_mono(
            run_dir / "processed" / val_lines[0].split("|", 2)[0],
            sr=squim_sr,
        )
        nmr_wav_t = torch.from_numpy(first_ref_wav).float().unsqueeze(0).to(device)

        def utmos_score(audio, sr):
            mono = _resample_audio(audio, src_sr=sr, dst_sr=squim_sr)
            wav_t = torch.from_numpy(mono).float().unsqueeze(0).to(device)
            with torch.no_grad():
                mos = squim(wav_t, nmr_wav_t)
            return float(mos.item())

    # Whisper expects 16 kHz audio (see whisper.audio.log_mel_spectrogram
    # docstring: "audio waveform in 16 kHz"). Kokoro emits 24 kHz; passing
    # 24 kHz directly distorts pitch/time and inflates WER (Q1-quality §1.2).
    asr_sr = 16000
    # ECAPA-TDNN speechbrain/spkrec-ecapa-voxceleb is trained on 16 kHz
    # VoxCeleb. Both synth + reference must be resampled to 16 kHz before
    # encoding so the embeddings live on the same manifold the model
    # was trained for (Q1-quality §1.3).
    spk_sr = 16000

    # Iterate val set, collect metrics.
    wer_total = 0.0
    sim_total = 0.0
    utmos_total = 0.0
    n = 0
    prompts: list[str] = []
    for line in val_lines:
        wav_rel, _phonemes, _spk = line.split("|", 2)
        clip_id = Path(wav_rel).stem
        ref = by_id.get(clip_id, {}).get("norm_text") or clip_id
        prompts.append(ref)

        audio, sr = synth(ref)
        # UTMOS (consumes audio at whatever sample rate utmos_score requires —
        # the SQUIM_SUBJECTIVE fallback resamples internally; the `utmos`
        # PyPI package accepts a sample-rate arg).
        utmos_total += utmos_score(audio, sr)
        # WER — resample synth to 16 kHz for Whisper, normalize both ref
        # and hyp text before computing edit distance.
        asr_audio = _resample_audio(audio, src_sr=sr, dst_sr=asr_sr)
        transcribed = asr.transcribe(asr_audio)["text"]
        wer_total += _word_error_rate(ref, transcribed)
        # Speaker sim — resample both sides to 16 kHz for ECAPA-TDNN.
        synth_16k = _resample_audio(audio, src_sr=sr, dst_sr=spk_sr)
        synth_emb = speaker_model.encode_batch(torch.from_numpy(synth_16k).unsqueeze(0))
        ref_wav, _ = _load_wav_mono(run_dir / "processed" / wav_rel, sr=spk_sr)
        ref_emb = speaker_model.encode_batch(torch.from_numpy(ref_wav).unsqueeze(0))
        cos = torch.nn.functional.cosine_similarity(
            synth_emb.squeeze(), ref_emb.squeeze(), dim=-1
        )
        sim_total += float(cos.item())
        n += 1

    # RTF on the same prompts.
    rtf, _ = _measure_rtf(synth, prompts, device)

    metrics = {
        "utmos": utmos_total / max(1, n),
        "wer": wer_total / max(1, n),
        "speaker_similarity": sim_total / max(1, n),
        "rtf": rtf,
    }
    gates_result = _apply_gates(metrics, cfg["gates"])

    out: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "kokoro-eval-report",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": False,
        "device": device,
        "metrics": metrics,
        "gates": cfg["gates"],
        "gateResult": gates_result,
        "voiceName": cfg.get("voice_name", "eliza_custom"),
        "nEvalClips": n,
    }
    if args.baseline_eval:
        out["comparison"] = _build_comparison(metrics, Path(args.baseline_eval).resolve())
    out_path = Path(args.eval_out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    log.info("wrote %s", out_path)

    if not gates_result["passed"] and not args.allow_gate_fail:
        log.error("eval gates failed: %s", gates_result["perMetric"])
        return 1
    return 0


# Punctuation we strip before WER computation. We deliberately keep
# apostrophes (so "don't" stays one token, matching Whisper output).
# `_PUNCT_RE` is module-level so the unit tests can import it.
import re  # noqa: E402

_PUNCT_RE = re.compile(r"[^\w\s']")
_WHITESPACE_RE = re.compile(r"\s+")


def _normalize_text_for_wer(s: str) -> str:
    """Normalize text before WER computation.

    Lowercase, strip punctuation (commas, periods, ellipses, quotes,
    etc.) except apostrophes, and collapse whitespace. This matches
    the behaviour of common WER tooling (jiwer's default
    `RemovePunctuation` + `ToLowerCase`) and avoids penalizing the
    model for punctuation it never produced.
    """
    s = s.lower()
    s = _PUNCT_RE.sub(" ", s)
    s = _WHITESPACE_RE.sub(" ", s).strip()
    return s


def _word_error_rate(ref: str, hyp: str) -> float:
    """Levenshtein WER on whitespace-split tokens after text normalization.

    Returns WER ∈ [0, +∞). Most production runs report ≤ 1.0 (because
    insertions + substitutions + deletions <= max(ref, hyp)), but a
    pathological hyp can exceed 1.0 — that's the standard WER definition.
    """
    ref_tokens = _normalize_text_for_wer(ref).split()
    hyp_tokens = _normalize_text_for_wer(hyp).split()
    if not ref_tokens:
        return 0.0 if not hyp_tokens else 1.0
    # Wagner–Fischer DP.
    n, m = len(ref_tokens), len(hyp_tokens)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if ref_tokens[i - 1] == hyp_tokens[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    return dp[n][m] / float(n)


def _resample_audio(audio, *, src_sr: int, dst_sr: int):
    """Resample a 1-D numpy waveform from `src_sr` to `dst_sr`.

    Identity-return when the rates match so callers can pass-through
    without paying the librosa import + resample cost. Uses
    `librosa.resample` with the default `kaiser_best` window — slow
    but high-quality, which is what we want for eval (not realtime).
    """
    if src_sr == dst_sr:
        return audio
    import librosa  # noqa: PLC0415

    return librosa.resample(audio, orig_sr=src_sr, target_sr=dst_sr)


def _load_wav_mono(path: Path, *, sr: int):
    import librosa  # noqa: PLC0415

    y, _ = librosa.load(str(path), sr=sr, mono=True)
    return y, sr


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--run-dir", type=Path, required=True)
    p.add_argument("--config", type=str, default="kokoro_lora_ljspeech.yaml")
    p.add_argument("--voice-bin", type=Path, default=None)
    p.add_argument(
        "--eval-out",
        type=Path,
        default=None,
        help="Where to write eval.json (default: <run-dir>/eval.json).",
    )
    p.add_argument("--allow-gate-fail", action="store_true")
    p.add_argument(
        "--baseline-eval",
        type=Path,
        default=None,
        help=(
            "Path to a baseline eval.json (e.g. af_bella). When set, eval.json "
            "gains a `comparison` block with per-metric deltas + a `beatsBaseline` "
            "boolean. Publish flows gate on `gateResult.passed && comparison.beatsBaseline`."
        ),
    )
    p.add_argument("--synthetic-smoke", action="store_true")
    p.add_argument(
        "--baseline-voice-id",
        type=str,
        default="af_bella",
        help="Stock Kokoro voice id used when --voice-bin is not set "
        "(baseline eval). Default af_bella.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cfg = load_config(args.config)
    if args.eval_out is None:
        args.eval_out = Path(args.run_dir) / "eval.json"
    if args.synthetic_smoke:
        return _run_synthetic_smoke(args, cfg)
    return _real_eval(args, cfg)


if __name__ == "__main__":
    raise SystemExit(main())
