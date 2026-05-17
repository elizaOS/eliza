"""Transcribe a set of 16 kHz mono wavs with llama-mtmd-cli and score WER.

Used by T-asr to verify each K-quant ladder GGUF produced by
gguf_asr_apply.py. The harness:

  1. Spawns ``llama-mtmd-cli`` with ``--model <quant>.gguf`` and
     ``--mmproj <mmproj-Q8_0>.gguf``.
  2. For each (wav, reference) pair, sends ``--audio <wav>`` and an ASR
     prompt; captures the model's transcript.
  3. Aggregates jiwer WER across the clip set; emits a JSON report.

Output schema matches what gets uploaded to the HF repo's ``eval.json``::

    {
      "tier": "1.7B",
      "mmproj_quant": "Q8_0",
      "results": {
        "Q3_K_M": {
          "wer": 0.14, "n_clips": 10,
          "elapsed_sec_total": 12.3,
          "rtf": 0.34,
          "per_clip": [{"file": "same_001.wav", "ref": "...",
                        "hyp": "...", "wer": 0.0, "elapsed_sec": 1.1}, ...]
        },
        ...
      }
    }
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import shlex
import subprocess
import sys
import time
import wave
from pathlib import Path
from typing import Iterable

import jiwer

log = logging.getLogger("eval_asr_wer")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        frames = wf.getnframes()
        rate = wf.getframerate()
        return frames / float(rate) if rate else 0.0


_TRANSFORM = jiwer.Compose(
    [
        jiwer.ToLowerCase(),
        jiwer.RemovePunctuation(),
        jiwer.RemoveMultipleSpaces(),
        jiwer.Strip(),
        jiwer.ReduceToListOfListOfWords(),
    ]
)


def _wer(ref: str, hyp: str) -> float:
    if not ref.strip() or not hyp.strip():
        return 1.0
    return float(
        jiwer.wer(
            ref,
            hyp,
            reference_transform=_TRANSFORM,
            hypothesis_transform=_TRANSFORM,
        )
    )


_LANG_TAG_RE = re.compile(r"^language\s+\S+\s*<asr_text>", re.IGNORECASE)
_CLOSE_TAG_RE = re.compile(r"</asr_text>.*$", re.DOTALL)


def _transcribe(
    mtmd: Path,
    model_gguf: Path,
    mmproj_gguf: Path,
    audio: Path,
    *,
    timeout: float = 120.0,
) -> str:
    """Run llama-mtmd-cli once and return the model's transcript."""
    cmd: list[str] = [
        str(mtmd),
        "--model",
        str(model_gguf),
        "--mmproj",
        str(mmproj_gguf),
        "--audio",
        str(audio),
        "--prompt",
        "Transcribe the audio to text.",
        "--n-predict",
        "256",
        "--temp",
        "0.0",
        "--ctx-size",
        "4096",
        "--log-colors",
        "off",
    ]
    log.debug("run: %s", " ".join(shlex.quote(x) for x in cmd))
    proc = subprocess.run(
        cmd,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        log.warning(
            "llama-mtmd-cli rc=%s, stderr tail:\n%s",
            proc.returncode,
            proc.stderr[-800:],
        )
        return ""
    out = proc.stdout.strip()
    # Qwen3-ASR wraps its transcript with `language English<asr_text>...`
    # plus an optional `</asr_text>` close tag.
    out = _LANG_TAG_RE.sub("", out).strip()
    out = _CLOSE_TAG_RE.sub("", out).strip()
    # Drop common chat-template artifacts.
    out = re.sub(r"<\|im_(start|end)\|>.*?$", "", out, flags=re.DOTALL).strip()
    return out


def _per_quant(
    mtmd: Path,
    quant_path: Path,
    mmproj_path: Path,
    pairs: list[tuple[Path, str]],
) -> dict:
    per_clip: list[dict] = []
    total_elapsed = 0.0
    total_audio = 0.0
    for wav, ref in pairs:
        t0 = time.monotonic()
        hyp = _transcribe(mtmd, quant_path, mmproj_path, wav)
        dt = time.monotonic() - t0
        audio_s = _wav_duration(wav)
        wer = _wer(ref, hyp)
        per_clip.append(
            {
                "file": wav.name,
                "ref": ref,
                "hyp": hyp,
                "wer": wer,
                "elapsed_sec": dt,
                "audio_sec": audio_s,
            }
        )
        total_elapsed += dt
        total_audio += audio_s
        log.info(
            "  %s wer=%.3f (%.2fs audio, %.2fs wall): %r",
            wav.name,
            wer,
            audio_s,
            dt,
            hyp[:80],
        )
    refs = [ref for _, ref in pairs]
    hyps = [c["hyp"] for c in per_clip]
    agg_wer = (
        float(
            jiwer.wer(
                refs,
                hyps,
                reference_transform=_TRANSFORM,
                hypothesis_transform=_TRANSFORM,
            )
        )
        if refs and any(h.strip() for h in hyps)
        else 1.0
    )
    rtf = (total_elapsed / total_audio) if total_audio > 0 else None
    return {
        "wer": agg_wer,
        "n_clips": len(pairs),
        "elapsed_sec_total": total_elapsed,
        "audio_sec_total": total_audio,
        "rtf": rtf,
        "size_bytes": quant_path.stat().st_size,
        "per_clip": per_clip,
    }


def _load_pairs(audio_dir: Path, ref_dir: Path, limit: int) -> list[tuple[Path, str]]:
    pairs: list[tuple[Path, str]] = []
    for wav in sorted(audio_dir.glob("*.wav")):
        ref = ref_dir / (wav.stem + ".txt")
        if not ref.exists():
            continue
        text = ref.read_text(encoding="utf-8").strip()
        if not text:
            continue
        pairs.append((wav, text))
        if len(pairs) >= limit:
            break
    return pairs


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--mtmd-binary", required=True, type=Path)
    ap.add_argument("--quant-dir", required=True, type=Path,
                    help="Directory containing eliza-1-asr-*.gguf + mmproj.")
    ap.add_argument("--mmproj-quant", default="Q8_0")
    ap.add_argument("--audio-dir", required=True, type=Path,
                    help="Directory of 16 kHz mono wavs.")
    ap.add_argument("--ref-dir", required=True, type=Path,
                    help="Directory of <stem>.txt reference transcripts.")
    ap.add_argument("--quants", default="Q3_K_M,Q4_K_M,Q5_K_M,Q6_K,Q8_0")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--report", required=True, type=Path)
    ap.add_argument("--tier", default="1.7B")
    args = ap.parse_args(list(argv) if argv is not None else None)

    pairs = _load_pairs(args.audio_dir, args.ref_dir, args.limit)
    if not pairs:
        log.error("No (audio, reference) pairs found.")
        return 2

    mmproj = args.quant_dir / f"eliza-1-asr-mmproj-{args.mmproj_quant}.gguf"
    if not mmproj.exists():
        log.error("missing mmproj: %s", mmproj)
        return 2

    quants = [q.strip() for q in args.quants.split(",") if q.strip()]
    report: dict[str, dict] = {}
    for q in quants:
        gguf = args.quant_dir / f"eliza-1-asr-{q}.gguf"
        if not gguf.exists():
            log.warning("skipping %s — %s missing", q, gguf)
            report[q] = {"skipped": True, "reason": "missing-gguf"}
            continue
        log.info("=== %s (%s, %s clips) ===", q, gguf.name, len(pairs))
        try:
            report[q] = _per_quant(args.mtmd_binary, gguf, mmproj, pairs)
        except subprocess.TimeoutExpired as ex:
            log.error("timeout for %s: %s", q, ex)
            report[q] = {"skipped": True, "reason": "timeout"}

    out = {
        "tier": args.tier,
        "mmproj_quant": args.mmproj_quant,
        "mmproj_size_bytes": mmproj.stat().st_size,
        "results": report,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(out, indent=2), encoding="utf-8")
    log.info("wrote %s", args.report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
