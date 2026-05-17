"""CLI entrypoint — `voice-emotion-bench {intrinsic, fidelity, text-intrinsic, roundtrip}`.

Heavy phases (running the Wav2Small ONNX over a real corpus, driving the
duet harness, loading the GoEmotions test split) live in `runner.py`. This
file is just the argparse shell; the heavy work is unit-testable in isolation.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time

from elizaos_voice_emotion.runner import (
    BenchOutput,
    run_fidelity,
    run_intrinsic,
    run_text_intrinsic,
)
from elizaos_voice_emotion.roundtrip import run_roundtrip


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="voice-emotion-bench")
    sub = p.add_subparsers(dest="command", required=True)

    intrinsic = sub.add_parser("intrinsic", help="Acoustic classifier intrinsic accuracy.")
    intrinsic.add_argument(
        "--suite",
        choices=["iemocap", "meld", "msp_podcast", "fixture"],
        required=True,
    )
    intrinsic.add_argument("--model", required=True, help="adapter id")
    intrinsic.add_argument("--onnx", type=pathlib.Path, required=False)
    intrinsic.add_argument("--corpus-manifest", type=pathlib.Path, required=False)
    intrinsic.add_argument("--out", type=pathlib.Path, default=pathlib.Path("bench-out.json"))

    fidelity = sub.add_parser("fidelity", help="Closed-loop emotion fidelity.")
    fidelity.add_argument("--duet-host", required=True)
    fidelity.add_argument(
        "--emotions",
        default="happy,sad,angry,nervous,calm,excited,whisper",
    )
    fidelity.add_argument("--rounds", type=int, default=10)
    fidelity.add_argument("--out", type=pathlib.Path, default=pathlib.Path("bench-fidelity.json"))

    text_intrinsic = sub.add_parser(
        "text-intrinsic",
        help="Text classifier intrinsic accuracy on GoEmotions.",
    )
    text_intrinsic.add_argument(
        "--suite",
        choices=["goemotions", "fixture"],
        default="goemotions",
    )
    text_intrinsic.add_argument(
        "--model",
        required=True,
        help="adapter id (`stage1-lm` | `roberta-go-emotions`)",
    )
    text_intrinsic.add_argument("--corpus-manifest", type=pathlib.Path, required=False)
    text_intrinsic.add_argument("--api-base", default=None)
    text_intrinsic.add_argument("--out", type=pathlib.Path, default=pathlib.Path("bench-text.json"))

    roundtrip = sub.add_parser(
        "roundtrip",
        help="W3-5 emotion roundtrip: TTS → audio → classifier → match score.",
    )
    roundtrip.add_argument(
        "--tts-backend",
        choices=["auto", "kokoro", "mms-tts"],
        default="auto",
        help="TTS backend to use (default: auto-detect).",
    )
    roundtrip.add_argument(
        "--onnx",
        type=pathlib.Path,
        required=False,
        help="Path to the Wav2Small ONNX (optional; falls back to SUPERB proxy).",
    )
    roundtrip.add_argument(
        "--voice",
        default="af_bella",
        help="Kokoro voice id (default: af_bella).",
    )
    roundtrip.add_argument(
        "--artifact-dir",
        type=pathlib.Path,
        required=False,
        help="Directory for WAV + predictions.json artifacts.",
    )
    roundtrip.add_argument(
        "--out",
        type=pathlib.Path,
        default=pathlib.Path("bench-roundtrip.json"),
        help="Path to write the summary JSON (in addition to artifact-dir).",
    )

    return p


def _emit(out: BenchOutput, target: pathlib.Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out.as_dict(), indent=2, sort_keys=True) + "\n")


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    started = time.time()
    if args.command == "intrinsic":
        out = run_intrinsic(
            suite=args.suite,
            model=args.model,
            onnx_path=args.onnx,
            corpus_manifest=args.corpus_manifest,
        )
    elif args.command == "fidelity":
        emotions = tuple(e.strip() for e in args.emotions.split(",") if e.strip())
        out = run_fidelity(
            duet_host=args.duet_host,
            emotions=emotions,
            rounds=args.rounds,
        )
    elif args.command == "text-intrinsic":
        out = run_text_intrinsic(
            suite=args.suite,
            model=args.model,
            corpus_manifest=args.corpus_manifest,
            api_base=args.api_base,
        )
    elif args.command == "roundtrip":
        import json as _json

        report = run_roundtrip(
            artifact_dir=args.artifact_dir,
            tts_backend=args.tts_backend,
            onnx_path=args.onnx,
            tts_voice=args.voice,
        )
        target = args.out
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(_json.dumps(report.as_dict(), indent=2, sort_keys=True) + "\n")
        sys.stderr.write(
            f"voice-emotion-bench roundtrip: top1={report.top1_match_rate:.1%} "
            f"n={report.n_total} matched={report.n_matched} "
            f"macroF1={report.macro_f1_7class:.3f} "
            f"elapsed={report.elapsed_seconds:.2f}s "
            f"artifacts={report.artifact_dir}\n"
        )
        return 0
    else:
        raise RuntimeError(f"unknown command: {args.command!r}")
    out.elapsed_seconds = round(time.time() - started, 3)
    _emit(out, args.out)
    sys.stderr.write(
        f"voice-emotion-bench: wrote {args.out} (macroF1={out.macro_f1:.3f}, "
        f"n={out.n}, elapsed={out.elapsed_seconds:.2f}s)\n",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
