"""eval_checkpoint.py — score one local checkpoint against a small val set.

Wraps `scripts/benchmark/native_tool_call_bench.py` via subprocess so we get
bucketed native function-calling structure/content numbers without duplicating
its scoring or model-loading logic. Reads the bench `summary.json` and emits a
small per-checkpoint result JSON the eval-loop appends to `_progress.jsonl`.

Used together with:
  - checkpoint_sync_loop.sh (pulls checkpoints from Vast)
  - eval_loop.sh (runs us against each unevaluated checkpoint)
  - progress_report.py (renders an HTML chart from _progress.jsonl)

Args:
  --checkpoint <dir>      Path to a local checkpoint directory (the one
                          containing config.json + safetensors / sharded
                          state). Step is parsed from the dir name:
                          `checkpoint-<N>` -> N; `final` -> max known step + 1.
  --registry-key <k>      Model registry key (qwen3.5-2b / qwen3.5-9b /
                          qwen3.6-27b). Recorded in the result JSON so the
                          UI can pick the right axis labels.
  --val-jsonl <path>      Validation JSONL. Default: data/smoke/val.jsonl.
  --max-examples <n>      Per-bucket cap for the native benchmark. Default 50 — the
                          smoke val set is tiny on purpose so each scoring
                          pass takes ~10s on a 0.8B and ~30s on a 2B (per
                          AGENTS spec for this script).
  --out <path>            Where to write the per-checkpoint result JSON.
                          The eval loop also writes a sibling `_eval.json`
                          inside the checkpoint dir as a "done" marker.

Output schema (JSON, one file per checkpoint):

    {
      "step": <int>,
      "checkpoint_dir": "<absolute path>",
      "structure_ok": <float, 0..1>,
      "content_ok": <float, 0..1>,
      "tokens_per_sec": <float>,
      "peak_vram_mb": <int>,
      "evaluated_at": "<ISO-8601 UTC>",
      "registry_key": "<key>"
    }

The structure_ok / content_ok numbers are macro-averaged across whatever
buckets the val set produced (the native benchmark reports per-bucket counts; we
sum them to get an overall rate so the progress chart has a single line
per metric). Bucket-level detail still lives in the bench summary.json
sitting next to the result.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BENCH_SCRIPT = ROOT / "scripts" / "benchmark" / "native_tool_call_bench.py"


def parse_step(checkpoint_dir: Path, sibling_max_step: int | None) -> int:
    """Parse the trailing step number from `checkpoint-<N>`.

    `final` is promoted to `max(known steps) + 1` so it sits at the end of
    the X axis when plotted alongside intermediate checkpoints. If we have
    no known steps yet, `final` -> 1.
    """
    name = checkpoint_dir.name
    m = re.search(r"checkpoint-(\d+)$", name)
    if m:
        return int(m.group(1))
    if name == "final":
        return (sibling_max_step or 0) + 1
    raise SystemExit(
        f"could not parse step from checkpoint dir name {name!r} — "
        f"expected `checkpoint-<N>` or `final`."
    )


def discover_max_sibling_step(checkpoint_dir: Path) -> int:
    """Highest `checkpoint-<N>` step present in the parent dir.

    Used only when the input dir is `final` so we can place it on the
    progress curve at max+1. Returns 0 if no siblings.
    """
    parent = checkpoint_dir.parent
    if not parent.is_dir():
        return 0
    best = 0
    for sib in parent.iterdir():
        m = re.search(r"checkpoint-(\d+)$", sib.name)
        if m:
            best = max(best, int(m.group(1)))
    return best


def aggregate_bucket_summary(summary: dict) -> tuple[float, float]:
    """Macro-average structure_ok and content_ok across buckets.

    Native benchmark reports per-bucket integer counts (`structure_ok`, `content_ok`,
    `n`). We sum across buckets to get an overall rate in [0, 1] for the
    progress curve. The full per-bucket breakdown is still preserved in the
    bench `summary.json` we leave on disk next to the result.
    """
    total_n = 0
    total_structure = 0
    total_content = 0
    for bucket in (summary.get("buckets") or {}).values():
        n = int(bucket.get("n") or 0)
        if n <= 0:
            continue
        total_n += n
        total_structure += int(bucket.get("structure_ok") or 0)
        total_content += int(bucket.get("content_ok") or 0)
    if total_n == 0:
        return 0.0, 0.0
    return (
        round(total_structure / total_n, 4),
        round(total_content / total_n, 4),
    )


def read_peak_vram_mb() -> int:
    """Best-effort current peak GPU memory across visible devices, in MB.

    Returns 0 when CUDA isn't available or nvidia-smi isn't on PATH. We
    read this from the parent process post-bench rather than from inside
    the bench (which we don't modify) — good enough as a coarse signal
    for the progress curve.
    """
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return 0
    peak = 0
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            peak = max(peak, int(line))
        except ValueError:
            continue
    return peak


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--checkpoint", required=True, help="Path to local checkpoint directory.")
    ap.add_argument("--registry-key", required=True, help="Model registry key, e.g. qwen3.5-2b.")
    ap.add_argument("--val-jsonl", default=str(ROOT / "data" / "smoke" / "val.jsonl"),
                    help="Validation JSONL. Default data/smoke/val.jsonl.")
    ap.add_argument("--max-examples", type=int, default=50,
                    help="Per-bucket cap passed to native_tool_call_bench. Default 50.")
    ap.add_argument("--out", required=True, help="Where to write the result JSON.")
    args = ap.parse_args()

    checkpoint_dir = Path(args.checkpoint).resolve()
    if not checkpoint_dir.is_dir():
        raise SystemExit(f"checkpoint dir not found: {checkpoint_dir}")

    val_path = Path(args.val_jsonl).resolve()
    if not val_path.is_file():
        raise SystemExit(f"val jsonl not found: {val_path}")

    sibling_max = discover_max_sibling_step(checkpoint_dir)
    step = parse_step(checkpoint_dir, sibling_max)

    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Run the native benchmark into a temp out-dir; we read its summary.json and
    # then move it next to the result JSON for forensic inspection.
    with tempfile.TemporaryDirectory(prefix="eval_ckpt_") as tmp:
        bench_out = Path(tmp) / "bench"
        cmd = [
            sys.executable, str(BENCH_SCRIPT),
            "--model", str(checkpoint_dir),
            "--out-dir", str(bench_out),
            "--test-file", str(val_path),
            "--max-per-bucket", str(args.max_examples),
        ]
        # native_tool_call_bench imports from scripts.format_for_training etc. via
        # sys.path manipulation rooted at training/. Run it from there.
        env = os.environ.copy()
        # Don't let an inherited HF_HOME redirect put weights on a tiny disk.
        env.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

        proc = subprocess.run(cmd, cwd=str(ROOT), env=env)
        if proc.returncode != 0:
            raise SystemExit(
                f"native_tool_call_bench exited with code {proc.returncode} for "
                f"{checkpoint_dir} — see stderr above."
            )

        summary_path = bench_out / "summary.json"
        if not summary_path.is_file():
            raise SystemExit(
                f"native_tool_call_bench did not produce summary.json at {summary_path} "
                f"— scoring failed."
            )
        summary = json.loads(summary_path.read_text())

        # Persist the bench summary next to the result so operators can
        # drill into per-bucket breakdowns from the same place.
        sibling_summary = out_path.with_suffix(".bench-summary.json")
        sibling_summary.write_text(json.dumps(summary, indent=2))

    structure_ok, content_ok = aggregate_bucket_summary(summary)
    tokens_per_sec = float(summary.get("tokens_per_sec_gen") or 0.0)
    peak_vram_mb = read_peak_vram_mb()

    result = {
        "step": step,
        "checkpoint_dir": str(checkpoint_dir),
        "structure_ok": structure_ok,
        "content_ok": content_ok,
        "tokens_per_sec": tokens_per_sec,
        "peak_vram_mb": peak_vram_mb,
        "evaluated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "registry_key": args.registry_key,
    }
    out_path.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
