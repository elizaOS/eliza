"""Classify every record in a JSONL corpus by elizaOS runtime phase.

The runtime makes exactly four LLM calls per turn (see
``docs/dataset/RUNTIME_PHASES.md``). Every training record must map to one
of those four phases or it's teaching the model a behavior the runtime
never invokes.

This script walks a JSONL corpus, tags each record with one of:

    1  should_respond  (the gate)
    2  response        (planner / messageHandler)
    3  action          (per-action handler LLM call)
    4  evaluation      (post-turn evaluator)
    OOB  out-of-band — does not match any runtime phase

It writes:

- ``previews/PHASE_COVERAGE.md``        per-task_type and per-source phase distribution
- ``previews/phase_coverage.json``      raw counts
- ``previews/OUT_OF_BAND_SAMPLES.jsonl``  first N OOB records grouped by source

Usage:

    uv run python scripts/classify_records_by_phase.py \
        --input data/final/train.jsonl \
        --out previews/

A streaming HF parquet input is also supported via ``--hf-stream`` for
auditing the published dataset without re-downloading:

    uv run python scripts/classify_records_by_phase.py \
        --hf-stream eliza-labs/eliza-1-training --split train \
        --sample 100000 --out previews/
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import sys
from pathlib import Path
from typing import Any, Iterable, Iterator

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.runtime_phases import classify_phase as classify  # noqa: E402

log = logging.getLogger("classify")


# ───────────────────────────── input readers ─────────────────────────────────


def iter_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as e:
                log.warning("malformed JSON at %s:%d (%s) — skipped", path, line_no, e)


def iter_hf_stream(repo_id: str, split: str, limit: int | None) -> Iterator[dict[str, Any]]:
    try:
        from datasets import load_dataset
    except ImportError:
        sys.exit("--hf-stream requires `datasets`. Install with `uv pip install datasets`.")
    ds = load_dataset(repo_id, split=split, streaming=True)
    for i, row in enumerate(ds):
        if limit is not None and i >= limit:
            break
        yield row


def iter_hf_raw(repo_id: str, filename: str, limit: int | None) -> Iterator[dict[str, Any]]:
    """Stream a single JSONL file from an HF dataset repo line-by-line via the raw
    `huggingface_hub.hf_hub_download` resolver — bypasses the `datasets` library's
    schema enforcement. Use this when shards have inconsistent metadata schemas."""
    try:
        from huggingface_hub import hf_hub_url
    except ImportError:
        sys.exit("--hf-raw requires `huggingface_hub`. Install with `uv pip install huggingface_hub`.")
    import urllib.request

    url = hf_hub_url(repo_id, filename, repo_type="dataset")
    log.info("streaming %s from %s", filename, url)
    req = urllib.request.Request(url, headers={"User-Agent": "eliza-classifier"})
    with urllib.request.urlopen(req) as resp:
        for i, raw in enumerate(resp):
            if limit is not None and i >= limit:
                break
            try:
                yield json.loads(raw.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                log.warning("malformed line at offset %d: %s — skipped", i, e)
                continue


# ───────────────────────────── classification ────────────────────────────────


def classify_corpus(
    rows: Iterable[dict[str, Any]],
    *,
    sample: int | None = None,
    oob_sample_per_source: int = 50,
) -> dict[str, Any]:
    phase_counts: dict[str, int] = collections.Counter()
    by_task_type: dict[str, dict[str, int]] = collections.defaultdict(collections.Counter)
    by_source: dict[str, dict[str, int]] = collections.defaultdict(collections.Counter)
    oob_samples: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    total = 0

    for row in rows:
        if sample is not None and total >= sample:
            break
        total += 1

        meta = row.get("metadata") or {}
        task_type = meta.get("task_type")
        source = meta.get("source_dataset", "<unknown>")
        phase = classify(task_type)

        phase_counts[phase] += 1
        by_task_type[task_type or "<missing>"][phase] += 1
        by_source[source][phase] += 1

        if phase == "OOB":
            bucket = oob_samples[source]
            if len(bucket) < oob_sample_per_source:
                bucket.append({
                    "task_type": task_type,
                    "source_dataset": source,
                    "currentMessage_excerpt": (row.get("currentMessage") or {}).get("content", "")[:200],
                    "expectedResponse_excerpt": (row.get("expectedResponse") or "")[:200],
                })

    return {
        "total": total,
        "phase_counts": dict(phase_counts),
        "by_task_type": {tt: dict(c) for tt, c in by_task_type.items()},
        "by_source": {s: dict(c) for s, c in by_source.items()},
        "oob_samples": dict(oob_samples),
    }


# ───────────────────────────── reporting ─────────────────────────────────────


def render_markdown(report: dict[str, Any]) -> str:
    total = report["total"]
    pc = report["phase_counts"]

    def pct(n: int) -> str:
        return f"{(100 * n / total):5.2f}%" if total else "  0.00%"

    out: list[str] = []
    out.append("# Phase coverage report")
    out.append("")
    out.append(f"Total records classified: **{total:,}**")
    out.append("")
    out.append("## Per-phase totals")
    out.append("")
    out.append("| Phase | Records | % |")
    out.append("|-------|--------:|--:|")
    for phase in ("1", "2", "3", "4", "OOB"):
        n = pc.get(phase, 0)
        out.append(f"| {phase} | {n:,} | {pct(n)} |")
    out.append("")

    out.append("## Per-task_type breakdown")
    out.append("")
    out.append("| task_type | Phase | Records |")
    out.append("|-----------|:-----:|--------:|")
    by_tt = report["by_task_type"]
    rows = []
    for tt, counts in by_tt.items():
        for phase, n in counts.items():
            rows.append((tt, phase, n))
    rows.sort(key=lambda r: (r[1], -r[2]))
    for tt, phase, n in rows:
        out.append(f"| `{tt}` | {phase} | {n:,} |")
    out.append("")

    out.append("## Per-source breakdown")
    out.append("")
    out.append("| Source | P1 | P2 | P3 | P4 | OOB | Total |")
    out.append("|--------|---:|---:|---:|---:|----:|------:|")
    by_src = report["by_source"]
    src_rows = []
    for src, counts in by_src.items():
        t = sum(counts.values())
        src_rows.append((
            src,
            counts.get("1", 0),
            counts.get("2", 0),
            counts.get("3", 0),
            counts.get("4", 0),
            counts.get("OOB", 0),
            t,
        ))
    src_rows.sort(key=lambda r: -r[6])
    for r in src_rows:
        out.append(f"| `{r[0]}` | {r[1]:,} | {r[2]:,} | {r[3]:,} | {r[4]:,} | {r[5]:,} | {r[6]:,} |")
    out.append("")

    if pc.get("OOB", 0):
        out.append("## Out-of-band action plan")
        out.append("")
        out.append("Every record above must be transformed or dropped per")
        out.append("`docs/dataset/COVERAGE_AUDIT.md`. The packing acceptance")
        out.append("gate REJECTS a corpus that contains any OOB records.")
        out.append("")

    return "\n".join(out)


# ───────────────────────────── CLI ───────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(description="Classify corpus records by runtime phase.")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--input", type=Path, help="path to local JSONL corpus")
    src.add_argument("--hf-stream", type=str, help="HF repo id to stream via `datasets` library (schema-strict)")
    src.add_argument("--hf-raw", type=str, help="HF repo id to stream a single file raw via huggingface_hub (schema-permissive)")
    p.add_argument("--hf-file", default="train.jsonl", help="filename to fetch when using --hf-raw (default: train.jsonl)")
    p.add_argument("--split", default="train", help="split name when streaming HF (default: train)")
    p.add_argument("--sample", type=int, default=None, help="cap rows examined (default: all)")
    p.add_argument("--out", type=Path, default=ROOT / "previews", help="output directory")
    p.add_argument("--oob-sample", type=int, default=50, help="OOB samples to keep per source")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    args.out.mkdir(parents=True, exist_ok=True)

    if args.input:
        if not args.input.exists():
            log.error("input not found: %s", args.input)
            return 2
        rows = iter_jsonl(args.input)
    elif args.hf_stream:
        rows = iter_hf_stream(args.hf_stream, args.split, args.sample)
    else:
        rows = iter_hf_raw(args.hf_raw, args.hf_file, args.sample)

    report = classify_corpus(rows, sample=args.sample, oob_sample_per_source=args.oob_sample)

    md_path = args.out / "PHASE_COVERAGE.md"
    json_path = args.out / "phase_coverage.json"
    oob_path = args.out / "OUT_OF_BAND_SAMPLES.jsonl"

    md_path.write_text(render_markdown(report), encoding="utf-8")
    json_path.write_text(json.dumps({k: v for k, v in report.items() if k != "oob_samples"}, indent=2), encoding="utf-8")

    with oob_path.open("w", encoding="utf-8") as f:
        for source, samples in report["oob_samples"].items():
            for s in samples:
                f.write(json.dumps(s) + "\n")

    log.info("classified %d records → %s", report["total"], md_path)
    log.info("phase counts: %s", report["phase_counts"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
