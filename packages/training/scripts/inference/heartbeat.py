"""Periodic vLLM /metrics scraper that emits one JSONL line per interval.

Used by both ad-hoc local serves (via `serve_vllm.py --with-heartbeat`) and
Vast deployments (via `eliza/cloud/services/vast-pyworker/onstart-vllm.sh`).
The output JSONL is the contract the Eliza Cloud UI reads to render
tokens/s, KV pressure, drafter accept rate, and APC hit rate over time.

JSONL schema (one object per line):

    {"ts": "<iso8601>", "label": "<free text>",
     "tokens_per_sec": float,           # generation tokens / wall seconds since prev scrape
     "p50_tpot_ms": float,              # rolling p50 from time_per_output_token histogram
     "p95_tpot_ms": float,
     "kv_cache_usage_pct": float,       # 0-100, mean of GPU cache usage across reported scopes
     "num_requests_running": int,
     "spec_decode_accept_rate": float|null,   # accepted / proposed since prev scrape, null if unsupported
     "apc_hit_rate": float|null,              # cache hits / queries since prev scrape, null if unsupported
     "peak_vram_mb": int|null}                # max(memory.used) across visible GPUs

On scrape error the line is `{"ts": ..., "label": ..., "error": "..."}` and
the loop continues.

Run from `training/`:

    python -m scripts.inference.heartbeat \\
        --vllm-metrics-url http://127.0.0.1:8000/metrics \\
        --out ~/.eliza/inference-stats.jsonl \\
        --interval-seconds 60 \\
        --label adhoc-h200-eliza-1-9b
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("heartbeat")


# Regex parser for Prometheus text-format lines. Format is:
#   metric_name{label="value",label2="value2"} 12345.6
# We deliberately avoid the prometheus_client lib so the script runs on a
# bare Python install (Vast template containers strip site-packages).
_LINE = re.compile(
    r"""
    ^(?P<name>[a-zA-Z_:][a-zA-Z0-9_:]*)
    (?:\{(?P<labels>[^}]*)\})?
    \s+
    (?P<value>[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|NaN|[+-]?Inf)
    """,
    re.VERBOSE,
)
_LABEL = re.compile(r'(?P<k>[a-zA-Z_][a-zA-Z0-9_]*)="(?P<v>(?:\\.|[^"\\])*)"')


def _parse_metrics(text: str) -> list[tuple[str, dict[str, str], float]]:
    out: list[tuple[str, dict[str, str], float]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _LINE.match(line)
        if not m:
            continue
        name = m.group("name")
        raw_labels = m.group("labels") or ""
        labels = {lm.group("k"): lm.group("v") for lm in _LABEL.finditer(raw_labels)}
        try:
            value = float(m.group("value"))
        except ValueError:
            continue
        out.append((name, labels, value))
    return out


def _fetch_metrics(url: str, timeout: float = 5.0) -> str:
    req = urllib.request.Request(url, headers={"Accept": "text/plain"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    return body.decode("utf-8", errors="replace")


def _peak_vram_mb() -> int | None:
    """Return max(memory.used) across visible GPUs, in MiB. None if no nvidia-smi."""
    if shutil.which("nvidia-smi") is None:
        return None
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used",
             "--format=csv,noheader,nounits"],
            stderr=subprocess.DEVNULL,
            timeout=5.0,
        ).decode("utf-8", errors="replace")
    except (subprocess.SubprocessError, OSError):
        return None
    vals: list[int] = []
    for chunk in out.splitlines():
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            vals.append(int(chunk))
        except ValueError:
            continue
    return max(vals) if vals else None


def _sum_counter(samples: list[tuple[str, dict[str, str], float]], name: str) -> float | None:
    """Sum every series matching `name` (across label permutations)."""
    total = 0.0
    found = False
    for n, _, v in samples:
        if n == name:
            total += v
            found = True
    return total if found else None


def _mean_gauge(samples: list[tuple[str, dict[str, str], float]], name: str) -> float | None:
    vals = [v for n, _, v in samples if n == name]
    if not vals:
        return None
    return sum(vals) / len(vals)


def _histogram_quantile(
    samples: list[tuple[str, dict[str, str], float]],
    name: str,
    q: float,
) -> float | None:
    """Standard Prometheus histogram quantile over `<name>_bucket` series.

    Aggregates buckets across all label permutations (so a multi-LoRA serve
    still gives a sensible global p50/p95). Returns the upper bound of the
    bucket where the cumulative count crosses q*total. Returns None if no
    buckets are present.
    """
    bucket_name = f"{name}_bucket"
    # bucket le -> cumulative count (summed across non-le labels)
    buckets: dict[float, float] = {}
    for n, labels, v in samples:
        if n != bucket_name:
            continue
        le_str = labels.get("le")
        if le_str is None:
            continue
        if le_str in ("+Inf", "Inf"):
            le = float("inf")
        else:
            try:
                le = float(le_str)
            except ValueError:
                continue
        buckets[le] = buckets.get(le, 0.0) + v
    if not buckets:
        return None
    ordered = sorted(buckets.items())
    total = ordered[-1][1]
    if total <= 0:
        return None
    target = q * total
    prev_le = 0.0
    prev_count = 0.0
    for le, count in ordered:
        if count >= target:
            if le == float("inf"):
                return prev_le if prev_le > 0 else None
            # Linear interpolation within the bucket for a slightly better estimate.
            span = count - prev_count
            if span <= 0:
                return le
            frac = (target - prev_count) / span
            return prev_le + (le - prev_le) * frac
        prev_le = le if le != float("inf") else prev_le
        prev_count = count
    return ordered[-1][0]


# vLLM metric names. These are stable across v0.18..v0.20+. If a future
# vLLM rename breaks one of these, the corresponding output field flips to
# null rather than crashing the loop.
_M_GEN_TOKENS = "vllm:generation_tokens_total"
_M_TPOT = "vllm:time_per_output_token_seconds"        # histogram base name
_M_TPOT_ALT = "vllm:time_per_output_token_seconds_histogram"  # some builds suffix
_M_KV_USAGE = "vllm:gpu_cache_usage_perc"
_M_REQS_RUNNING = "vllm:num_requests_running"
_M_SPEC_ACCEPT = "vllm:spec_decode_num_accepted_tokens_total"
_M_SPEC_DRAFT = "vllm:spec_decode_num_draft_tokens_total"
_M_APC_HIT = "vllm:gpu_prefix_cache_hits_total"
_M_APC_QUERY = "vllm:gpu_prefix_cache_queries_total"


def _scrape_once(url: str) -> dict:
    text = _fetch_metrics(url)
    samples = _parse_metrics(text)

    # Histogram quantiles — try canonical name then suffix variant.
    p50 = _histogram_quantile(samples, _M_TPOT, 0.50)
    if p50 is None:
        p50 = _histogram_quantile(samples, _M_TPOT_ALT, 0.50)
    p95 = _histogram_quantile(samples, _M_TPOT, 0.95)
    if p95 is None:
        p95 = _histogram_quantile(samples, _M_TPOT_ALT, 0.95)

    return {
        "gen_tokens_total": _sum_counter(samples, _M_GEN_TOKENS),
        "p50_tpot_s": p50,
        "p95_tpot_s": p95,
        "kv_cache_usage_pct": _mean_gauge(samples, _M_KV_USAGE),
        "num_requests_running": _mean_gauge(samples, _M_REQS_RUNNING),
        "spec_accept_total": _sum_counter(samples, _M_SPEC_ACCEPT),
        "spec_draft_total": _sum_counter(samples, _M_SPEC_DRAFT),
        "apc_hit_total": _sum_counter(samples, _M_APC_HIT),
        "apc_query_total": _sum_counter(samples, _M_APC_QUERY),
    }


def _delta_rate(curr: float | None, prev: float | None, dt_s: float) -> float | None:
    if curr is None or prev is None or dt_s <= 0:
        return None
    delta = curr - prev
    if delta < 0:
        # Counter reset (vllm restart) — treat as no signal this interval.
        return None
    return delta / dt_s


def _delta_ratio(
    num_curr: float | None, num_prev: float | None,
    den_curr: float | None, den_prev: float | None,
) -> float | None:
    if num_curr is None or num_prev is None or den_curr is None or den_prev is None:
        return None
    num_d = num_curr - num_prev
    den_d = den_curr - den_prev
    if den_d <= 0:
        return None
    if num_d < 0:
        return None
    return num_d / den_d


def _emit(out_path: Path, payload: dict) -> None:
    line = json.dumps(payload, separators=(",", ":"))
    with out_path.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__.split("\n\n", 1)[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--vllm-metrics-url",
                    default="http://127.0.0.1:8000/metrics",
                    help="vLLM Prometheus endpoint to scrape.")
    ap.add_argument("--out", default="~/.eliza/inference-stats.jsonl",
                    help="JSONL append target. Created if missing.")
    ap.add_argument("--interval-seconds", type=float, default=60.0,
                    help="Scrape cadence. Deltas are computed against the previous scrape.")
    ap.add_argument("--label", default="",
                    help="Free-text label written into every emitted record.")
    ap.add_argument("--max-iterations", type=int, default=0,
                    help="Stop after N intervals (0 = run forever). Used by tests.")
    args = ap.parse_args()

    out_path = Path(os.path.expanduser(args.out)).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    prev: dict | None = None
    prev_t: float | None = None
    iteration = 0

    log.info("heartbeat starting: url=%s out=%s interval=%.1fs label=%s",
             args.vllm_metrics_url, out_path, args.interval_seconds, args.label or "(none)")

    while True:
        loop_start = time.monotonic()
        ts = _now_iso()
        try:
            curr = _scrape_once(args.vllm_metrics_url)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            _emit(out_path, {"ts": ts, "label": args.label,
                             "error": f"{type(exc).__name__}: {exc}"})
            prev = None
            prev_t = None
        except Exception as exc:  # noqa: BLE001 - never let a parse bug stop the loop
            _emit(out_path, {"ts": ts, "label": args.label,
                             "error": f"{type(exc).__name__}: {exc}"})
            prev = None
            prev_t = None
        else:
            now_t = time.monotonic()
            if prev is not None and prev_t is not None:
                dt_s = now_t - prev_t
                tps = _delta_rate(curr["gen_tokens_total"], prev["gen_tokens_total"], dt_s)
                spec = _delta_ratio(
                    curr["spec_accept_total"], prev["spec_accept_total"],
                    curr["spec_draft_total"], prev["spec_draft_total"],
                )
                apc = _delta_ratio(
                    curr["apc_hit_total"], prev["apc_hit_total"],
                    curr["apc_query_total"], prev["apc_query_total"],
                )
                kv = curr["kv_cache_usage_pct"]
                if kv is not None:
                    # vLLM reports 0..1 for gpu_cache_usage_perc despite the suffix;
                    # normalise to a real percentage for downstream UIs.
                    kv = kv * 100.0 if kv <= 1.0 else kv
                payload = {
                    "ts": ts,
                    "label": args.label,
                    "tokens_per_sec": tps,
                    "p50_tpot_ms": (curr["p50_tpot_s"] * 1000.0) if curr["p50_tpot_s"] is not None else None,
                    "p95_tpot_ms": (curr["p95_tpot_s"] * 1000.0) if curr["p95_tpot_s"] is not None else None,
                    "kv_cache_usage_pct": kv,
                    "num_requests_running": int(curr["num_requests_running"])
                        if curr["num_requests_running"] is not None else None,
                    "spec_decode_accept_rate": spec,
                    "apc_hit_rate": apc,
                    "peak_vram_mb": _peak_vram_mb(),
                }
                _emit(out_path, payload)
            prev = curr
            prev_t = now_t

        iteration += 1
        if args.max_iterations and iteration >= args.max_iterations:
            return 0
        elapsed = time.monotonic() - loop_start
        sleep_s = max(0.0, args.interval_seconds - elapsed)
        time.sleep(sleep_s)


if __name__ == "__main__":
    sys.exit(main())
