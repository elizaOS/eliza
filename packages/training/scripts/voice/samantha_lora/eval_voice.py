#!/usr/bin/env python3
"""Evaluate a Samantha LoRA adapter against publish-blocking quality gates.

Wraps the existing `eval_kokoro.py` harness — that script already
implements UTMOS / SQUIM-MOS, ASR WER, ECAPA speaker similarity, and
RTF. We pass our exported voice.bin in and compare the result against
the per-tier gates documented in
`packages/training/benchmarks/voice_gates.md`.

Outputs:

    <out>/eval.json        # raw eval_kokoro.py output (metrics + comparison)
    <out>/gate_report.json # gate decision + per-metric pass/fail
    stdout                 # human-readable summary

Exit codes:
    0  — every gate passes; publish_samantha.sh can run.
    1  — at least one gate failed; publish blocked.
    2  — invocation error.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Iterable

log = logging.getLogger("samantha_lora.eval")

HERE = Path(__file__).resolve().parent
TRAINING_ROOT = HERE.parent.parent.parent
KOKORO_EVAL = TRAINING_ROOT / "scripts" / "kokoro" / "eval_kokoro.py"
GATES_DOC = TRAINING_ROOT / "benchmarks" / "voice_gates.md"
GATES_YAML = TRAINING_ROOT / "benchmarks" / "voice_gates.yaml"


def _load_export_manifest(out_dir: Path) -> dict:
    path = out_dir / "manifest.json"
    if not path.is_file():
        raise SystemExit(
            f"[eval_voice] export manifest missing at {path}. Run export_adapter.py first."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def _load_gates() -> dict[str, float]:
    """Load tier-wide gate thresholds from voice_gates.yaml when present;
    fall back to the constants documented in voice_gates.md."""
    if GATES_YAML.is_file():
        try:
            import yaml  # type: ignore[import-not-found]
        except ImportError:
            log.warning("PyYAML not installed; using defaults from voice_gates.md")
        else:
            data = yaml.safe_load(GATES_YAML.read_text(encoding="utf-8"))
            return {
                "speaker_similarity_min": float(data["speaker_similarity_min"]),
                "wer_max": float(data["wer_max"]),
                "utmos_min": float(data["utmos_min"]),
                "rtf_min": float(data["rtf_min"]),
            }
    # Defaults — match export_adapter.publish_gates.
    return {
        "speaker_similarity_min": 0.55,
        "wer_max": 0.10,
        "utmos_min": 3.5,
        "rtf_min": 5.0,
    }


def _run_kokoro_eval(
    *,
    voice_bin: Path,
    val_clips_dir: Path,
    out_path: Path,
    baseline_voice_id: str,
) -> int:
    if not KOKORO_EVAL.is_file():
        raise SystemExit(
            f"[eval_voice] eval_kokoro.py missing at {KOKORO_EVAL}; layout changed."
        )
    cmd = [
        sys.executable,
        str(KOKORO_EVAL),
        "--voice-bin",
        str(voice_bin),
        "--reference-clips",
        str(val_clips_dir),
        "--out",
        str(out_path),
        "--baseline-voice-id",
        baseline_voice_id,
    ]
    log.info("running eval_kokoro.py: %s", " ".join(cmd))
    return subprocess.call(cmd)


def _decide_gates(metrics: dict, thresholds: dict[str, float]) -> dict:
    per_metric: dict[str, dict[str, object]] = {}
    failures: list[str] = []
    for key, gate, op in (
        ("speaker_similarity", thresholds["speaker_similarity_min"], "min"),
        ("wer", thresholds["wer_max"], "max"),
        ("utmos", thresholds["utmos_min"], "min"),
        ("rtf", thresholds["rtf_min"], "min"),
    ):
        value = metrics.get(key)
        if value is None:
            per_metric[key] = {"value": None, "gate": gate, "op": op, "passed": False}
            failures.append(f"{key}: missing from eval output")
            continue
        passed = value >= gate if op == "min" else value <= gate
        per_metric[key] = {"value": value, "gate": gate, "op": op, "passed": passed}
        if not passed:
            failures.append(f"{key}={value} {'<' if op == 'min' else '>'} {gate}")
    return {
        "passed": not failures,
        "failures": failures,
        "thresholds": thresholds,
        "per_metric": per_metric,
    }


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="Export dir from export_adapter.py.")
    parser.add_argument(
        "--val-clips-dir",
        type=Path,
        required=True,
        help="Directory of held-out reference clips (e.g. <run-dir>/processed/wavs_norm/val).",
    )
    parser.add_argument(
        "--baseline-voice-id",
        type=str,
        default="af_bella",
        help="Stock Kokoro voice the candidate is compared against.",
    )
    parser.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "INFO"))
    args = parser.parse_args(list(argv) if argv is not None else None)

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    out_dir = args.out.resolve()
    manifest = _load_export_manifest(out_dir)

    voice_bin: Path | None = None
    for art in manifest.get("artifacts", []):
        if art.get("format") == "kokoro_voice_bin":
            voice_bin = out_dir / art["filename"]
            break
    if not voice_bin or not voice_bin.is_file():
        raise SystemExit(
            "[eval_voice] export manifest has no kokoro_voice_bin artifact. "
            "Re-run export_adapter.py with --mode merged (or both)."
        )

    eval_path = out_dir / "eval.json"
    rc = _run_kokoro_eval(
        voice_bin=voice_bin,
        val_clips_dir=args.val_clips_dir.resolve(),
        out_path=eval_path,
        baseline_voice_id=args.baseline_voice_id,
    )
    if rc != 0:
        raise SystemExit(f"[eval_voice] eval_kokoro.py returned {rc}")

    eval_data = json.loads(eval_path.read_text(encoding="utf-8"))
    metrics = eval_data.get("metrics") or {}

    thresholds = _load_gates()
    decision = _decide_gates(metrics, thresholds)

    gate_path = out_dir / "gate_report.json"
    gate_path.write_text(json.dumps(decision, indent=2), encoding="utf-8")

    sys.stdout.write("Samantha LoRA eval — gate report:\n")
    for key, info in decision["per_metric"].items():
        marker = "PASS" if info["passed"] else "FAIL"
        sys.stdout.write(
            f"  [{marker}] {key:20s} value={info['value']!r:>12s} gate={info['op']} {info['gate']}\n"
        )
    if decision["passed"]:
        sys.stdout.write("\nALL GATES PASS — publish_samantha.sh is unblocked.\n")
        return 0
    sys.stdout.write("\nGATES FAILED:\n")
    for f in decision["failures"]:
        sys.stdout.write(f"  - {f}\n")
    return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
