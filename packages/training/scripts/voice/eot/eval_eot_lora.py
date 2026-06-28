#!/usr/bin/env python3
"""Evaluate an EOT LoRA adapter against the runtime baselines.

Compares three EOT classifiers on a held-out eval split:

  1. LoRA-on-eliza-1 (this script's input adapter)
  2. LiveKit GGUF turn-detector (baseline; canonical runtime path)
  3. HeuristicEotClassifier (always-available baseline)

Metrics:
  - AUROC                  area under ROC for P(eot) score
  - ECE (calibration)      expected calibration error, 10 buckets
  - p50_latency_ms         per-call latency, median
  - p95_latency_ms         per-call latency, 95th percentile

Gate enforcement: reads default thresholds from
`packages/training/benchmarks/eot_gates.md` (parsed from the YAML
front-matter at the top). Exits 0 when all gates pass, 1 when any
fail. Operator-readable JSON report goes to `--out`.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger("eot.eval_eot_lora")


# ---------------------------------------------------------------------------
# Gate spec parsing
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GateThresholds:
    auroc_min: float = 0.85
    ece_max: float = 0.05
    p95_latency_ms_max: float = 50.0


def parse_gate_thresholds(gates_md: Path) -> GateThresholds:
    """Read defaults from the YAML front-matter at the top of eot_gates.md.

    The file uses a `---\\nkey: val\\n---` block at the top. If missing
    or malformed, returns the hardcoded defaults — better to fail loud
    against sensible defaults than silently weaken gates.
    """
    if not gates_md.exists():
        logger.warning("gate spec %s missing; using hardcoded defaults", gates_md)
        return GateThresholds()
    text = gates_md.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return GateThresholds()
    end = text.find("---", 3)
    if end < 0:
        return GateThresholds()
    front = text[3:end]
    spec: dict[str, float] = {}
    for line in front.splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if not key or not value:
            continue
        try:
            spec[key] = float(value)
        except ValueError:
            continue
    return GateThresholds(
        auroc_min=spec.get("auroc_min", 0.85),
        ece_max=spec.get("ece_max", 0.05),
        p95_latency_ms_max=spec.get("p95_latency_ms_max", 50.0),
    )


# ---------------------------------------------------------------------------
# Metrics (pure, testable; no torch import)
# ---------------------------------------------------------------------------


def auroc(scores: list[float], labels: list[int]) -> float:
    """Mann–Whitney U formulation of AUROC.

    Pure Python so it runs in the CPU pytest lane. O(n log n).
    """
    if len(scores) != len(labels):
        raise ValueError("scores and labels must be the same length")
    if not scores:
        raise ValueError("empty input")
    positives = sum(1 for x in labels if x == 1)
    negatives = len(labels) - positives
    if positives == 0 or negatives == 0:
        raise ValueError("AUROC undefined: need both positive and negative examples")
    # Rank scores; ties get the average rank.
    indexed = sorted(enumerate(scores), key=lambda kv: kv[1])
    ranks = [0.0] * len(scores)
    i = 0
    while i < len(indexed):
        j = i
        while j + 1 < len(indexed) and indexed[j + 1][1] == indexed[i][1]:
            j += 1
        avg_rank = (i + j) / 2 + 1  # 1-indexed average
        for k in range(i, j + 1):
            ranks[indexed[k][0]] = avg_rank
        i = j + 1
    sum_ranks_pos = sum(ranks[i] for i, label in enumerate(labels) if label == 1)
    u = sum_ranks_pos - positives * (positives + 1) / 2
    return u / (positives * negatives)


def expected_calibration_error(
    scores: list[float],
    labels: list[int],
    n_buckets: int = 10,
) -> float:
    """ECE with `n_buckets` equal-width bins in [0,1]."""
    if len(scores) != len(labels):
        raise ValueError("scores and labels must be the same length")
    if not scores:
        raise ValueError("empty input")
    if n_buckets < 1:
        raise ValueError("n_buckets must be >=1")
    bucket_acc = [0.0] * n_buckets
    bucket_conf = [0.0] * n_buckets
    bucket_count = [0] * n_buckets
    for s, y in zip(scores, labels):
        idx = min(n_buckets - 1, int(s * n_buckets))
        bucket_acc[idx] += y
        bucket_conf[idx] += s
        bucket_count[idx] += 1
    total = len(scores)
    ece = 0.0
    for acc, conf, count in zip(bucket_acc, bucket_conf, bucket_count):
        if count == 0:
            continue
        avg_acc = acc / count
        avg_conf = conf / count
        ece += (count / total) * abs(avg_acc - avg_conf)
    return ece


def percentile(values: list[float], p: float) -> float:
    """Nearest-rank percentile (no numpy dep)."""
    if not values:
        raise ValueError("empty input")
    if not 0 <= p <= 100:
        raise ValueError("p must be in [0, 100]")
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round(p / 100 * (len(s) - 1)))))
    return s[k]


# ---------------------------------------------------------------------------
# Result shape + gate evaluation
# ---------------------------------------------------------------------------


@dataclass
class ClassifierResult:
    name: str
    auroc: float
    ece: float
    p50_latency_ms: float
    p95_latency_ms: float
    n_examples: int
    extra: dict = field(default_factory=dict)


@dataclass
class GateOutcome:
    passed: bool
    failures: list[str] = field(default_factory=list)


def evaluate_gates(result: ClassifierResult, gates: GateThresholds) -> GateOutcome:
    failures: list[str] = []
    if result.auroc < gates.auroc_min:
        failures.append(
            f"AUROC {result.auroc:.4f} < min {gates.auroc_min:.4f}"
        )
    if result.ece > gates.ece_max:
        failures.append(f"ECE {result.ece:.4f} > max {gates.ece_max:.4f}")
    if result.p95_latency_ms > gates.p95_latency_ms_max:
        failures.append(
            f"p95 latency {result.p95_latency_ms:.2f}ms > "
            f"max {gates.p95_latency_ms_max:.2f}ms"
        )
    return GateOutcome(passed=not failures, failures=failures)


# ---------------------------------------------------------------------------
# Classifier adapters — pluggable runtime backends
# ---------------------------------------------------------------------------


def score_with_heuristic(texts: list[str]) -> tuple[list[float], list[float]]:
    """Heuristic baseline: P(eot) from terminal punctuation + length cues.

    Returns (scores, latencies_ms). Pure CPU, no model load.
    """
    scores: list[float] = []
    latencies: list[float] = []
    for text in texts:
        start = time.perf_counter()
        stripped = text.rstrip()
        ends_terminal = stripped.endswith((".", "?", "!", "。", "?", "!"))
        word_count = len(stripped.split())
        # Long, terminal-punctuated text → likely complete turn.
        # Short, no-punctuation text → likely mid-turn.
        score = 0.5
        if ends_terminal:
            score += 0.3
        if word_count >= 4:
            score += 0.1
        if word_count >= 10:
            score += 0.1
        scores.append(min(1.0, max(0.0, score)))
        latencies.append((time.perf_counter() - start) * 1000)
    return scores, latencies


def score_with_livekit_gguf(
    texts: list[str],
    gguf_path: Path,
) -> tuple[list[float], list[float]]:
    """Baseline: LiveKit turn-detector via the GGUF binding.

    Spawns one llama-cpp process per call (simple; the runtime path
    uses a persistent binding via node-llama-cpp, but for evaluation
    we just need scores, not throughput).
    """
    try:
        from llama_cpp import Llama  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            "llama_cpp_python required for LiveKit GGUF baseline. "
            "`pip install llama-cpp-python`."
        ) from exc

    model = Llama(model_path=str(gguf_path), n_ctx=2048, verbose=False, logits_all=False)
    # Find the Gemma <end_of_turn> token id.
    eot_tokens = model.tokenize("<end_of_turn>".encode("utf-8"), add_bos=False)
    if len(eot_tokens) != 1:
        raise RuntimeError(
            f"expected <end_of_turn> to be 1 token in this GGUF, got {len(eot_tokens)}"
        )
    eot_id = eot_tokens[0]

    scores: list[float] = []
    latencies: list[float] = []
    for text in texts:
        start = time.perf_counter()
        tokens = model.tokenize(text.encode("utf-8"), add_bos=True)
        model.reset()
        model.eval(tokens)
        logits = model.scores[len(tokens) - 1]  # last-position logits
        # Softmax just over the relevant slice to get P(end_of_turn).
        import math

        max_logit = max(logits)
        exp_logits = [math.exp(x - max_logit) for x in logits]
        denom = sum(exp_logits)
        scores.append(exp_logits[eot_id] / denom)
        latencies.append((time.perf_counter() - start) * 1000)
    return scores, latencies


def score_with_lora(
    texts: list[str],
    base_id: str,
    adapter_path: Path,
) -> tuple[list[float], list[float]]:
    """LoRA-on-eliza-1 path: load base + attach adapter, read P(EOT)."""
    import torch  # type: ignore
    from peft import PeftModel  # type: ignore
    from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore

    tokenizer = AutoTokenizer.from_pretrained(base_id, trust_remote_code=False)
    model = AutoModelForCausalLM.from_pretrained(
        base_id,
        torch_dtype=torch.bfloat16,
        device_map="auto",
        trust_remote_code=False,
    )
    model = PeftModel.from_pretrained(model, str(adapter_path))
    model.eval()

    eot_id = _resolve_eot_token_id(tokenizer)

    scores: list[float] = []
    latencies: list[float] = []
    with torch.inference_mode():
        for text in texts:
            start = time.perf_counter()
            encoded = tokenizer(text, return_tensors="pt").to(model.device)
            out = model(**encoded)
            logits = out.logits[0, -1]  # last-position
            probs = torch.softmax(logits, dim=-1)
            scores.append(float(probs[eot_id].item()))
            latencies.append((time.perf_counter() - start) * 1000)
    return scores, latencies


def _resolve_eot_token_id(tokenizer) -> int:
    """Find the Gemma `<end_of_turn>` token id in the loaded tokenizer."""
    for candidate in ("<end_of_turn>", "&lt;end_of_turn&gt;"):
        ids = tokenizer.convert_tokens_to_ids(candidate)
        if isinstance(ids, int) and ids >= 0:
            return ids
    encoded = tokenizer.encode("<end_of_turn>", add_special_tokens=False)
    if encoded and len(encoded) == 1:
        return encoded[0]
    raise RuntimeError(
        "could not resolve <end_of_turn> in tokenizer; ensure the base "
        "model uses the Gemma chat template."
    )


# ---------------------------------------------------------------------------
# Eval driver
# ---------------------------------------------------------------------------


def load_eval_split(path: Path) -> tuple[list[str], list[int]]:
    """Load (text, label) pairs from Parquet or JSONL."""
    if path.suffix.lower() == ".parquet":
        try:
            import pyarrow.parquet as pq  # type: ignore
        except ImportError as exc:
            raise SystemExit("pyarrow required to read Parquet eval splits") from exc
        table = pq.read_table(path)
        rows = table.to_pylist()
    else:
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    texts = [r["text"] for r in rows]
    labels = [int(r["label"]) for r in rows]
    return texts, labels


def evaluate_one(
    name: str,
    scores: list[float],
    labels: list[int],
    latencies: list[float],
) -> ClassifierResult:
    return ClassifierResult(
        name=name,
        auroc=auroc(scores, labels),
        ece=expected_calibration_error(scores, labels),
        p50_latency_ms=percentile(latencies, 50),
        p95_latency_ms=percentile(latencies, 95),
        n_examples=len(scores),
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate an EOT LoRA adapter.")
    parser.add_argument(
        "--eval-corpus", required=True, type=Path, help="Held-out eval split."
    )
    parser.add_argument(
        "--lora-adapter",
        type=Path,
        help="Path to the trained LoRA adapter. Omit to skip LoRA eval.",
    )
    parser.add_argument(
        "--lora-base",
        help="HF id of the base model the LoRA was trained on (e.g. google/gemma-4-E2B).",
    )
    parser.add_argument(
        "--livekit-gguf",
        type=Path,
        help="Path to the LiveKit turn-detector GGUF. Omit to skip baseline.",
    )
    parser.add_argument(
        "--gates",
        type=Path,
        default=Path("packages/training/benchmarks/eot_gates.md"),
    )
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    texts, labels = load_eval_split(args.eval_corpus)
    logger.info("loaded %d eval examples (%d positive)", len(texts), sum(labels))

    gates = parse_gate_thresholds(args.gates)
    logger.info(
        "gates: auroc>=%.3f ece<=%.3f p95<=%dms",
        gates.auroc_min,
        gates.ece_max,
        gates.p95_latency_ms_max,
    )

    results: list[ClassifierResult] = []

    # Always run the Heuristic baseline.
    h_scores, h_lat = score_with_heuristic(texts)
    results.append(evaluate_one("heuristic", h_scores, labels, h_lat))

    if args.livekit_gguf:
        if not args.livekit_gguf.exists():
            logger.error("--livekit-gguf %s not found", args.livekit_gguf)
            return 1
        lk_scores, lk_lat = score_with_livekit_gguf(texts, args.livekit_gguf)
        results.append(evaluate_one("livekit_gguf", lk_scores, labels, lk_lat))

    if args.lora_adapter:
        if not args.lora_base:
            logger.error("--lora-base is required when --lora-adapter is set")
            return 1
        lo_scores, lo_lat = score_with_lora(texts, args.lora_base, args.lora_adapter)
        results.append(evaluate_one("lora_eliza1", lo_scores, labels, lo_lat))

    # Gate evaluation runs against the LoRA result if present, otherwise
    # against LiveKit, otherwise the heuristic (with a warning).
    gated = next((r for r in results if r.name == "lora_eliza1"), None)
    if gated is None:
        gated = next((r for r in results if r.name == "livekit_gguf"), None)
    if gated is None:
        logger.warning("no LoRA or LiveKit result; gating against heuristic baseline")
        gated = results[0]

    outcome = evaluate_gates(gated, gates)
    report = {
        "gated_classifier": gated.name,
        "gates": asdict(gates),
        "passed": outcome.passed,
        "failures": outcome.failures,
        "results": [asdict(r) for r in results],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    logger.info("wrote report to %s", args.out)

    for r in results:
        logger.info(
            "[%s] auroc=%.4f ece=%.4f p50=%.2fms p95=%.2fms n=%d",
            r.name,
            r.auroc,
            r.ece,
            r.p50_latency_ms,
            r.p95_latency_ms,
            r.n_examples,
        )

    if not outcome.passed:
        logger.error("EOT GATE FAILED:")
        for failure in outcome.failures:
            logger.error("  - %s", failure)
        return 1

    logger.info("EOT gates passed for %s", gated.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
