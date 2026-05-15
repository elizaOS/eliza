#!/usr/bin/env python3
"""Evaluate a Qwen3-ASR checkpoint.

Computes WER + RTF against a corpus of WAV+transcript pairs and writes
``<run-dir>/eval.json``. Matches the eval contract in W3-11:

- **WER**: via jiwer (preferred) or character-level approximation fallback.
- **RTF**: synthesized audio seconds / wall clock seconds. Higher = faster.
- **Baseline comparison**: optional ``--baseline-eval <eval.json>``; emits
  ``comparison.beatsBaseline`` (WER delta ≤ 0.0).
- **Gate enforcement**: exits non-zero when gates fail, unless
  ``--allow-gate-fail "<reason>"`` is given.

Synthetic-smoke mode (``--synthetic-smoke``): writes a stub eval.json so
downstream tooling (publish scripts, manifest steps) can be tested without
a real model.

Usage
-----

::

    # Smoke (CI):
    python3 eval_asr.py \\
        --run-dir /tmp/asr-runs/samantha \\
        --config asr_samantha.yaml \\
        --synthetic-smoke

    # Real eval:
    python3 eval_asr.py \\
        --run-dir /tmp/asr-runs/samantha \\
        --checkpoint /tmp/asr-runs/samantha/checkpoints/best.pt \\
        --data-dir packages/training/data/voice/samantha \\
        --config asr_samantha.yaml \\
        --baseline-eval artifacts/voice-fine-tune/asr-baseline/eval.json
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
REPO_ROOT = ROOT.parents[3]
sys.path.insert(0, str(ROOT))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("asr.eval")


def _load_config(config_arg: str) -> dict[str, Any]:
    """Load YAML config; fallback to defaults."""
    defaults: dict[str, Any] = {
        "base_model": "Qwen/Qwen3-ASR-0.6B",
        "sample_rate": 16000,
        "mel_bins": 80,
        "voice_name": "custom",
        "gates": {"wer_max": 0.15, "rtf_min": 2.0},
    }
    if not config_arg:
        return defaults
    config_path = Path(config_arg)
    if not config_path.is_absolute():
        config_path = ROOT / "configs" / config_arg
    if not config_path.exists():
        log.warning("config not found: %s — using defaults", config_arg)
        return defaults
    try:
        import yaml  # type: ignore  # noqa: PLC0415
    except ImportError:
        return defaults
    with config_path.open(encoding="utf-8") as fh:
        user_cfg = yaml.safe_load(fh) or {}
    if "extends" in user_cfg:
        base_path = ROOT / "configs" / user_cfg.pop("extends")
        if base_path.exists():
            with base_path.open(encoding="utf-8") as fh:
                base_cfg = yaml.safe_load(fh) or {}
            defaults.update(base_cfg)
    defaults.update(user_cfg)
    return defaults


def _apply_gates(metrics: dict[str, float], gates: dict[str, float]) -> dict[str, Any]:
    return {
        "perMetric": {
            "wer": metrics["wer"] <= gates["wer_max"],
            "rtf": metrics["rtf"] >= gates["rtf_min"],
        },
        "passed": (
            metrics["wer"] <= gates["wer_max"]
            and metrics["rtf"] >= gates["rtf_min"]
        ),
    }


def _build_comparison(metrics: dict[str, float], baseline_path: Path) -> dict[str, Any]:
    if not baseline_path.is_file():
        raise FileNotFoundError(f"baseline eval not found: {baseline_path}")
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    base_metrics = baseline.get("metrics")
    if not isinstance(base_metrics, dict) or "wer" not in base_metrics:
        raise ValueError(f"baseline {baseline_path} missing metrics.wer")
    wer_delta = float(metrics["wer"]) - float(base_metrics["wer"])
    return {
        "werDelta": wer_delta,
        "baselineWer": float(base_metrics["wer"]),
        "beatsBaseline": wer_delta <= 0.0,
    }


def _run_synthetic_smoke(args: argparse.Namespace, cfg: dict[str, Any]) -> int:
    """Write a stub eval.json without real model inference."""
    log.info("synthetic-smoke: ASR eval pipeline shape (no model inference)")
    run_dir = Path(args.run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)

    metrics = {"wer": 0.08, "rtf": 3.2}
    gates = cfg["gates"]
    gate_result = _apply_gates(metrics, gates)

    result: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "asr-eval-report",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "voiceName": cfg.get("voice_name", "custom"),
        "nEvalClips": 5,
        "metrics": metrics,
        "gates": gates,
        "gateResult": gate_result,
        "synthetic": True,
    }

    baseline_path = Path(args.baseline_eval) if getattr(args, "baseline_eval", None) else None
    if baseline_path and baseline_path.is_file():
        try:
            result["comparison"] = _build_comparison(metrics, baseline_path)
        except Exception as exc:
            log.warning("baseline comparison failed: %s", exc)

    (run_dir / "eval.json").write_text(json.dumps(result, indent=2) + "\n")
    log.info("synthetic-smoke eval.json written to %s", run_dir / "eval.json")
    return 0


def _real_eval(args: argparse.Namespace, cfg: dict[str, Any]) -> int:
    """Run real WER + RTF eval against a checkpoint."""
    try:
        import torch  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit("torch not installed") from exc

    try:
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor  # type: ignore  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit("transformers not installed") from exc

    try:
        import jiwer  # type: ignore  # noqa: PLC0415
    except ImportError:
        jiwer = None  # type: ignore
        log.warning("jiwer not installed; using character-level WER approximation")

    run_dir = Path(args.run_dir).resolve()
    data_dir = Path(args.data_dir).resolve() if args.data_dir else None
    if data_dir is None:
        raise SystemExit("--data-dir required for real eval")

    device = "cuda" if torch.cuda.is_available() else "cpu"

    # Load model: from checkpoint if provided, else base model.
    if args.checkpoint and Path(args.checkpoint).exists():
        log.info("loading checkpoint from %s", args.checkpoint)
        ckpt = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
        processor = AutoProcessor.from_pretrained(cfg["base_model"])
        model = AutoModelForSpeechSeq2Seq.from_pretrained(cfg["base_model"])
        model.load_state_dict(ckpt["stateDict"], strict=True)
    else:
        log.info("no checkpoint; evaluating base model %s", cfg["base_model"])
        processor = AutoProcessor.from_pretrained(cfg["base_model"])
        model = AutoModelForSpeechSeq2Seq.from_pretrained(cfg["base_model"])
    model = model.to(device)
    model.eval()

    # Load val corpus.
    from finetune_asr import _load_corpus, _extract_features  # noqa: PLC0415

    _, val_records = _load_corpus(data_dir, cfg)
    log.info("evaluating on %d val clips", len(val_records))

    references: list[str] = []
    hypotheses: list[str] = []
    total_audio_s = 0.0
    total_wall_s = 0.0

    import numpy as np  # noqa: PLC0415

    for rec in val_records:
        try:
            import librosa  # noqa: PLC0415

            y, _ = librosa.load(rec["wav"], sr=cfg["sample_rate"], mono=True)
            total_audio_s += len(y) / cfg["sample_rate"]

            log_mel = _extract_features(rec["wav"], target_sr=cfg["sample_rate"], mel_bins=cfg["mel_bins"])
            input_features = torch.from_numpy(log_mel).unsqueeze(0).to(device)

            t0 = time.perf_counter()
            with torch.no_grad():
                generated_ids = model.generate(input_features, max_new_tokens=256)
            total_wall_s += time.perf_counter() - t0

            transcription = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
            references.append(rec["transcript"].lower().strip())
            hypotheses.append(transcription.lower().strip())
        except Exception as exc:
            log.warning("eval failed for %s: %s", rec["id"], exc)

    if not references:
        log.error("no eval clips succeeded; check your corpus + checkpoint")
        return 1

    if jiwer is not None:
        wer = float(jiwer.wer(references, hypotheses))
    else:
        total_chars = sum(len(r) for r in references)
        errors = sum(abs(len(r) - len(h)) for r, h in zip(references, hypotheses))
        wer = errors / max(1, total_chars)

    rtf = total_audio_s / max(1e-6, total_wall_s)
    log.info("WER=%.4f RTF=%.2f n_clips=%d", wer, rtf, len(references))

    gates = cfg["gates"]
    gate_result = _apply_gates({"wer": wer, "rtf": rtf}, gates)
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "asr-eval-report",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "voiceName": cfg.get("voice_name", "custom"),
        "nEvalClips": len(references),
        "metrics": {"wer": wer, "rtf": rtf},
        "gates": gates,
        "gateResult": gate_result,
    }

    baseline_path = Path(args.baseline_eval) if getattr(args, "baseline_eval", None) else None
    if baseline_path:
        try:
            result["comparison"] = _build_comparison({"wer": wer, "rtf": rtf}, baseline_path)
        except Exception as exc:
            log.warning("baseline comparison failed: %s", exc)

    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "eval.json").write_text(json.dumps(result, indent=2) + "\n")
    log.info("eval.json written to %s", run_dir / "eval.json")

    if not gate_result["passed"] and not getattr(args, "allow_gate_fail", None):
        log.error("eval gates FAILED: %s", gate_result["perMetric"])
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate a Qwen3-ASR fine-tune checkpoint.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--config", default="")
    parser.add_argument("--checkpoint", default=None, help="Path to best.pt checkpoint.")
    parser.add_argument("--data-dir", default=None, help="Corpus directory for eval.")
    parser.add_argument("--baseline-eval", default=None, help="Path to baseline eval.json.")
    parser.add_argument("--allow-gate-fail", default=None, metavar="REASON")
    parser.add_argument("--synthetic-smoke", action="store_true", default=False)
    args = parser.parse_args(argv)
    cfg = _load_config(args.config)
    if args.synthetic_smoke:
        return _run_synthetic_smoke(args, cfg)
    return _real_eval(args, cfg)


if __name__ == "__main__":
    sys.exit(main())
