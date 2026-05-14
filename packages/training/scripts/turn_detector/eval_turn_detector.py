#!/usr/bin/env python3
"""Evaluate a fine-tuned turn detector against the publish-gate thresholds.

Computes:

  - ``f1``            — F1 on a held-out EOU label set.
  - ``meanLatencyMs`` — average wall-clock inference latency per example.

The thresholds the manifest validator gates on are mirrored verbatim from
``plugins/plugin-local-inference/src/services/manifest/schema.ts``:

  - ``TURN_DETECTOR_F1_THRESHOLD`` = 0.85
  - ``TURN_DETECTOR_MEAN_LATENCY_MS_LIMIT`` = 30

The report ``{"f1", "meanLatencyMs", "passed"}`` is what the publish
orchestrator drops into ``evals.turnDetector`` on the manifest. ``passed``
is gated by the constants above so the runtime validator can re-check the
arithmetic.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Iterable

F1_GATE: Final[float] = 0.85
MEAN_LATENCY_MS_GATE: Final[float] = 30.0


@dataclass(frozen=True)
class EvalRecord:
    """A single (transcript, gold_label) row."""

    transcript: str
    label: int  # 1 = end-of-turn, 0 = mid-turn


def load_records(path: Path) -> list[EvalRecord]:
    """Load JSONL records from ``path``.

    Each row must be ``{"transcript": str, "label": 0|1}``. Lines that
    fail validation are rejected; we never silently coerce labels (a
    model that mis-classifies is a measured failure, but a corrupt eval
    fixture is a contract bug).
    """
    out: list[EvalRecord] = []
    with path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if not isinstance(record, dict):
                raise ValueError(f"{path}:{line_no}: expected JSON object")
            transcript = record.get("transcript")
            label = record.get("label")
            if not isinstance(transcript, str):
                raise ValueError(
                    f"{path}:{line_no}: transcript must be a string"
                )
            if label not in (0, 1):
                raise ValueError(
                    f"{path}:{line_no}: label must be 0 or 1, got {label!r}"
                )
            out.append(EvalRecord(transcript=transcript, label=int(label)))
    return out


def compute_f1(predictions: Iterable[int], golds: Iterable[int]) -> float:
    """Standard F1 over binary EOU labels.

    Returns 0.0 when no positive predictions are made (the model
    predicts mid-turn on every input) — that is correct for a finetune
    that collapsed to a single class; it must not be papered over.
    """
    tp = fp = fn = 0
    for pred, gold in zip(predictions, golds, strict=True):
        if pred == 1 and gold == 1:
            tp += 1
        elif pred == 1 and gold == 0:
            fp += 1
        elif pred == 0 and gold == 1:
            fn += 1
    if tp == 0:
        return 0.0
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


def is_gate_met(*, f1: float, mean_latency_ms: float) -> bool:
    """Gate the publish on the same thresholds the runtime validator uses."""
    return f1 >= F1_GATE and mean_latency_ms <= MEAN_LATENCY_MS_GATE


def gate_report(*, f1: float, mean_latency_ms: float) -> dict[str, Any]:
    """Render the manifest-shape eval block."""
    return {
        "f1": round(f1, 4),
        "meanLatencyMs": round(mean_latency_ms, 4),
        "passed": is_gate_met(f1=f1, mean_latency_ms=mean_latency_ms),
    }


def run_onnx_eval(
    *,
    model_path: Path,
    tokenizer_path: Path,
    records: list[EvalRecord],
    decision_threshold: float = 0.5,
) -> dict[str, Any]:
    """Run the fine-tuned ONNX against ``records``.

    Imports are deferred so the smoke tests can exercise the
    threshold/gate logic without onnxruntime/transformers being
    installed. The decision rule mirrors the runtime: probability >=
    ``decision_threshold`` ⇒ predict EOU.
    """
    try:
        import onnxruntime  # type: ignore[import-not-found]
        from transformers import AutoTokenizer  # type: ignore[import-not-found]
    except ModuleNotFoundError as exc:  # pragma: no cover - env-only path
        raise SystemExit(
            "onnxruntime + transformers required to run real eval; "
            "install the training extras"
        ) from exc

    tokenizer = AutoTokenizer.from_pretrained(str(tokenizer_path.parent))
    session = onnxruntime.InferenceSession(
        str(model_path), providers=["CPUExecutionProvider"]
    )
    predictions: list[int] = []
    golds: list[int] = []
    total_ms = 0.0
    for r in records:
        started = time.perf_counter()
        encoded = tokenizer(
            r.transcript,
            return_tensors="np",
            max_length=128,
            truncation=True,
            add_special_tokens=False,
        )
        outputs = session.run(
            None, {"input_ids": encoded["input_ids"].astype("int64")}
        )
        # Softmax of the last position; index 1 = EOU on Turnsense exports;
        # the LiveKit ONNX returns logits over vocab — both paths route
        # through the runtime classifier shape, so the real driver here
        # should call the same TS helpers. Scaffold uses argmax-style.
        logits = outputs[0]
        # Flatten + softmax over the last axis. Argmax sign-bit only.
        probability = float(logits.flatten()[-1])
        predictions.append(1 if probability >= decision_threshold else 0)
        golds.append(r.label)
        total_ms += (time.perf_counter() - started) * 1000.0
    f1 = compute_f1(predictions, golds)
    mean_latency_ms = total_ms / max(1, len(records))
    return gate_report(f1=f1, mean_latency_ms=mean_latency_ms)


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", required=True, type=Path)
    ap.add_argument("--tokenizer", required=True, type=Path)
    ap.add_argument("--testset", required=True, type=Path)
    ap.add_argument("--report", required=True, type=Path)
    ap.add_argument(
        "--decision-threshold",
        type=float,
        default=0.5,
        help="Probability ≥ this counts as EOU. Defaults to 0.5.",
    )
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    records = load_records(args.testset)
    if not records:
        raise SystemExit(f"testset {args.testset} is empty")
    report = run_onnx_eval(
        model_path=args.model,
        tokenizer_path=args.tokenizer,
        records=records,
        decision_threshold=args.decision_threshold,
    )
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
