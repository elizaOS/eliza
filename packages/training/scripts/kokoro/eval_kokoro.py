#!/usr/bin/env python3
"""Evaluate a fine-tuned Kokoro checkpoint.

Computes four numbers and writes `<run-dir>/eval.json`:

1. **UTMOS** (predicted MOS via the SaruLab UTMOS model). Falls through to a
   torchaudio SQUIM-MOS predictor if `utmos` isn't installed; both are
   imperfect proxies for human MOS but stable enough to gate runs.

2. **WER** (word error rate) via Whisper large-v3 round-trip: synthesize each
   eval transcript, transcribe the synth, compute WER against the reference.

3. **Speaker similarity**: ECAPA-TDNN cosine between the synth and a held-out
   reference clip. SpeechBrain provides the pretrained model.

4. **RTF** (real-time factor): synthesis throughput on the current device.
   RTF = (synthesized audio seconds) / (wall clock seconds).

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


def _run_synthetic_smoke(args: argparse.Namespace, cfg: dict[str, Any]) -> int:
    metrics = {"utmos": 4.0, "wer": 0.04, "speaker_similarity": 0.78, "rtf": 12.5}
    gates_result = _apply_gates(metrics, cfg["gates"])
    out = {
        "schemaVersion": 1,
        "kind": "kokoro-eval-report",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": True,
        "metrics": metrics,
        "gates": cfg["gates"],
        "gateResult": gates_result,
        "voiceName": cfg.get("voice_name", "eliza_custom"),
    }
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

    voice_bin = args.voice_bin

    def synth(prompt: str):
        out = pipeline(prompt, voice=str(voice_bin) if voice_bin else None)
        for _gs, _ps, audio in out:
            return audio.cpu().numpy(), 24000
        raise RuntimeError("Kokoro pipeline produced no audio")

    # Whisper round-trip WER.
    import whisper  # type: ignore  # noqa: PLC0415

    asr = whisper.load_model("large-v3" if device == "cuda" else "small")

    # ECAPA-TDNN speaker similarity.
    from speechbrain.inference.speaker import EncoderClassifier  # type: ignore  # noqa: PLC0415

    speaker_model = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        run_opts={"device": device},
    )

    # UTMOS — optional.
    try:
        from utmos import Score as UtmosScore  # type: ignore  # noqa: PLC0415

        utmos = UtmosScore()

        def utmos_score(audio, sr):
            return float(utmos(audio, sr))

    except ImportError:
        log.warning("utmos not installed; falling back to torchaudio SQUIM-MOS")
        import torchaudio  # noqa: PLC0415
        from torchaudio.pipelines import SQUIM_OBJECTIVE  # type: ignore  # noqa: PLC0415

        squim = SQUIM_OBJECTIVE.get_model().to(device).eval()

        def utmos_score(audio, sr):
            wav_t = torch.from_numpy(audio).float().unsqueeze(0).to(device)
            with torch.no_grad():
                _stoi, _pesq, mos = squim(wav_t)
            return float(mos.item())

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
        # UTMOS
        utmos_total += utmos_score(audio, sr)
        # WER
        transcribed = asr.transcribe(audio)["text"]
        wer_total += _word_error_rate(ref, transcribed)
        # Speaker sim
        synth_emb = speaker_model.encode_batch(torch.from_numpy(audio).unsqueeze(0))
        ref_wav, _ = _load_wav_mono(run_dir / "processed" / wav_rel, sr=24000)
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

    out = {
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
    out_path = Path(args.eval_out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    log.info("wrote %s", out_path)

    if not gates_result["passed"] and not args.allow_gate_fail:
        log.error("eval gates failed: %s", gates_result["perMetric"])
        return 1
    return 0


def _word_error_rate(ref: str, hyp: str) -> float:
    """Simple Levenshtein WER on whitespace-split tokens."""
    ref_tokens = ref.lower().split()
    hyp_tokens = hyp.lower().split()
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
    p.add_argument("--synthetic-smoke", action="store_true")
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
