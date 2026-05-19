"""Parse TFLite benchmark_model stdout. Includes NNAPI/NPU fallback metrics."""

from __future__ import annotations

import json
import re
import sys
from typing import Any

from . import ParseError

_INFERENCE_LINE_RE = re.compile(
    r"Inference timings in us:\s*"
    r"Init:\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*"
    r"First inference:\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*"
    r"Warmup\s*\(avg\):\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*"
    r"Inference\s*\(avg\):\s*([0-9]+(?:\.[0-9]+)?)"
)
_STDDEV_RE = re.compile(r"std deviation\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)", re.IGNORECASE)
_NODES_TOTAL_RE = re.compile(r"Number of nodes executed:\s*([0-9]+)")
_NNAPI_DELEGATE_RE = re.compile(
    r"NNAPI delegated\s*([0-9]+)\s*nodes;\s*([0-9]+)\s*fallback to CPU",
    re.IGNORECASE,
)
_UNSUPPORTED_RE = re.compile(r"Number of unsupported ops:\s*([0-9]+)", re.IGNORECASE)


def parse(text: str) -> dict[str, Any]:
    m = _INFERENCE_LINE_RE.search(text)
    if not m:
        raise ParseError("tflite: missing 'Inference timings in us' average latency line")
    metrics: dict[str, Any] = {
        "init_us": float(m.group(1)),
        "first_inference_us": float(m.group(2)),
        "warmup_avg_us": float(m.group(3)),
        "avg_latency_us": float(m.group(4)),
    }
    sd = _STDDEV_RE.search(text)
    if sd:
        metrics["std_dev_us"] = float(sd.group(1))

    total_m = _NODES_TOTAL_RE.search(text)
    delegate_m = _NNAPI_DELEGATE_RE.search(text)
    unsupported_m = _UNSUPPORTED_RE.search(text)

    if delegate_m:
        delegated = int(delegate_m.group(1))
        fallback = int(delegate_m.group(2))
        total = int(total_m.group(1)) if total_m else (delegated + fallback)
        metrics["nnapi_delegated_nodes"] = delegated
        metrics["cpu_fallback_nodes"] = fallback
        metrics["unsupported_op_count"] = int(unsupported_m.group(1)) if unsupported_m else fallback
        metrics["cpu_fallback_percent"] = (fallback / total) * 100.0 if total > 0 else 0.0
    elif unsupported_m:
        metrics["unsupported_op_count"] = int(unsupported_m.group(1))
    return metrics


def main(argv: list[str]) -> int:
    if not argv or argv[0] == "-":
        data = sys.stdin.read()
    else:
        with open(argv[0], encoding="utf-8") as handle:
            data = handle.read()
    try:
        out = parse(data)
    except ParseError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1
    json.dump(out, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
