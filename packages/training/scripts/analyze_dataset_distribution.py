#!/usr/bin/env python3
"""Analyze distribution statistics across one or more JSONL training datasets.

Computes per-dataset record counts, token estimates, stage/task-type breakdown,
and cross-dataset share. Flags trope patterns, unbalanced sources, and high
trope rates.

Usage:
    python analyze_dataset_distribution.py [--data-dir data/] [--output report.json]
    python analyze_dataset_distribution.py --files a.jsonl b.jsonl
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ──────────────────────────────────────────────────────────────
# Trope patterns
# ──────────────────────────────────────────────────────────────

TROPE_CHECKS: list[tuple[str, re.Pattern]] = [
    ("you_are_expert",    re.compile(r"\byou\s+are\s+an?\s+expert\b", re.IGNORECASE)),
    ("certainly",         re.compile(r"^(Certainly!|Of course!|Sure!|Absolutely!)", re.IGNORECASE)),
    ("as_an_ai",          re.compile(r"\b(As an AI|I'm an AI assistant|I am an AI assistant)\b", re.IGNORECASE)),
    ("ill_help_you_with", re.compile(r"\bI'?ll help you with\b", re.IGNORECASE)),
    ("great_question",    re.compile(r"\bGreat question!\b", re.IGNORECASE)),
]

RESPONSE_TOO_SHORT = 10
RESPONSE_TOO_LONG_CHARS = 4096  # ~1024 tokens estimated


# ──────────────────────────────────────────────────────────────
# Record parsing helpers
# ──────────────────────────────────────────────────────────────

def slug_of(rec: dict) -> str:
    md = rec.get("metadata") or {}
    return str(md.get("source_dataset") or "_unknown_")


def stage_of(rec: dict) -> str:
    """Coarse stage bucket: planner / message_handler / trajectory / other."""
    md = rec.get("metadata") or {}
    task_type = str(md.get("task_type") or "").lower()
    if task_type in ("tool_call", "shell_command", "agent_trace", "planner"):
        return "planner"
    if task_type in ("reply", "should_respond", "should_respond_with_context", "context_routing"):
        return "message_handler"
    if task_type in ("trajectory", "claude_distill"):
        return "trajectory"
    return "other"


def task_type_of(rec: dict) -> str:
    md = rec.get("metadata") or {}
    return str(md.get("task_type") or "_unknown_")


def token_estimate(rec: dict) -> int:
    """Rough token estimate: total chars across messages / 4."""
    total_chars = 0
    for entry in (rec.get("memoryEntries") or []):
        content = entry.get("content") if isinstance(entry, dict) else None
        if isinstance(content, str):
            total_chars += len(content)
    msg = rec.get("currentMessage") or {}
    if isinstance(msg.get("content"), str):
        total_chars += len(msg["content"])
    er = rec.get("expectedResponse")
    if isinstance(er, str):
        total_chars += len(er)
    sys_p = (rec.get("metadata") or {}).get("system_prompt")
    if isinstance(sys_p, str):
        total_chars += len(sys_p)
    return max(1, total_chars // 4)


def extract_system_text(rec: dict) -> str:
    md = rec.get("metadata") or {}
    return str(md.get("system_prompt") or "")


def extract_assistant_text(rec: dict) -> str:
    parts: list[str] = []
    for entry in (rec.get("memoryEntries") or []):
        if not isinstance(entry, dict):
            continue
        role = str(entry.get("role") or "").lower()
        if role in ("assistant", "agent", "eliza"):
            c = entry.get("content")
            if isinstance(c, str):
                parts.append(c)
    er = rec.get("expectedResponse")
    if isinstance(er, str):
        parts.append(er)
    return " ".join(parts)


def check_tropes(rec: dict) -> list[str]:
    fired: list[str] = []
    system_text = extract_system_text(rec)
    assistant_text = extract_assistant_text(rec)

    for name, pattern in TROPE_CHECKS:
        target = system_text if name == "you_are_expert" else assistant_text
        if pattern.search(target):
            fired.append(name)

    # Length checks on assistant text
    plain_len = len(assistant_text.strip())
    if 0 < plain_len < RESPONSE_TOO_SHORT:
        fired.append("response_too_short")
    if plain_len > RESPONSE_TOO_LONG_CHARS:
        fired.append("response_too_long")

    return fired


# ──────────────────────────────────────────────────────────────
# Per-file scanning
# ──────────────────────────────────────────────────────────────

def scan_file(path: Path) -> dict:
    counts: Counter = Counter()
    stages: Counter = Counter()
    task_types: Counter = Counter()
    trope_hits: Counter = Counter()
    trope_record_count = 0
    token_total = 0
    decode_errors = 0

    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                decode_errors += 1
                continue
            counts["records"] += 1
            token_total += token_estimate(rec)
            stages[stage_of(rec)] += 1
            task_types[task_type_of(rec)] += 1
            tropes = check_tropes(rec)
            if tropes:
                trope_record_count += 1
                for t in tropes:
                    trope_hits[t] += 1

    total = counts["records"]
    trope_rate = trope_record_count / total if total else 0.0
    return {
        "file": str(path),
        "slug": path.stem,
        "records": total,
        "token_estimate": token_total,
        "decode_errors": decode_errors,
        "stage_distribution": dict(stages),
        "task_type_distribution": dict(task_types),
        "trope_record_count": trope_record_count,
        "trope_rate": trope_rate,
        "trope_hits": dict(trope_hits),
    }


# ──────────────────────────────────────────────────────────────
# Reporting
# ──────────────────────────────────────────────────────────────

def _bar(pct: float, width: int = 20) -> str:
    filled = round(pct * width)
    return "[" + "#" * filled + "-" * (width - filled) + "]"


def build_report(stats: list[dict]) -> dict:
    total_records = sum(s["records"] for s in stats)
    for s in stats:
        s["pct_of_total"] = s["records"] / total_records if total_records else 0.0

    flags: list[str] = []
    max_pct = max((s["pct_of_total"] for s in stats), default=0.0)
    if max_pct > 0.5:
        top = max(stats, key=lambda x: x["pct_of_total"])
        flags.append(f"UNBALANCED: {top['slug']} contributes {top['pct_of_total']:.1%} of total records (>50%)")

    for s in stats:
        if s["trope_rate"] > 0.10:
            flags.append(
                f"HIGH_TROPE_RATE: {s['slug']} trope_rate={s['trope_rate']:.1%} "
                f"({s['trope_record_count']}/{s['records']} records)"
            )

    return {
        "total_records": total_records,
        "total_token_estimate": sum(s["token_estimate"] for s in stats),
        "dataset_count": len(stats),
        "flags": flags,
        "datasets": stats,
    }


def print_ascii_table(report: dict) -> None:
    stats = report["datasets"]
    col_w = [
        max(len("Dataset"), max(len(s["slug"]) for s in stats) if stats else 0),
        8, 8, 8, 8, 10,
    ]
    header = (
        f"{'Dataset':<{col_w[0]}}  "
        f"{'Records':>{col_w[1]}}  "
        f"{'Tokens~':>{col_w[2]}}  "
        f"{'Share%':>{col_w[3]}}  "
        f"{'Trope%':>{col_w[4]}}  "
        f"{'Top Stage':<{col_w[5]}}"
    )
    sep = "-" * len(header)
    print()
    print("=== Dataset Distribution Report ===")
    print(f"Total records:  {report['total_records']:,}")
    print(f"Total tokens~:  {report['total_token_estimate']:,}")
    print(f"Datasets:       {report['dataset_count']}")
    print()
    print(header)
    print(sep)
    for s in sorted(stats, key=lambda x: -x["records"]):
        top_stage = max(s["stage_distribution"], key=lambda k: s["stage_distribution"][k], default="-")
        print(
            f"{s['slug']:<{col_w[0]}}  "
            f"{s['records']:>{col_w[1]},}  "
            f"{s['token_estimate']:>{col_w[2]},}  "
            f"{s['pct_of_total'] * 100:>{col_w[3]}.1f}  "
            f"{s['trope_rate'] * 100:>{col_w[4]}.1f}  "
            f"{top_stage:<{col_w[5]}}"
        )
    print(sep)

    if report["flags"]:
        print()
        print("=== FLAGS ===")
        for flag in report["flags"]:
            print(f"  ! {flag}")

    print()
    print("=== Trope Totals Across All Datasets ===")
    all_tropes: Counter = Counter()
    for s in stats:
        for k, v in s["trope_hits"].items():
            all_tropes[k] += v
    if all_tropes:
        for trope, count in all_tropes.most_common():
            print(f"  {trope:<30} {count:>6,}")
    else:
        print("  (none detected)")
    print()


# ──────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data-dir", type=Path, default=ROOT / "data",
                    help="directory to scan for *.jsonl files (default: data/)")
    ap.add_argument("--files", type=Path, nargs="*",
                    help="explicit JSONL files to analyze (overrides --data-dir)")
    ap.add_argument("--output", type=Path, default=None,
                    help="write JSON report to this file (default: stdout only)")
    args = ap.parse_args()

    if args.files:
        files = [f for f in args.files if f.exists()]
        missing = [f for f in args.files if not f.exists()]
        if missing:
            for m in missing:
                print(f"warning: file not found: {m}", file=sys.stderr)
    else:
        data_dir = args.data_dir
        if not data_dir.exists():
            print(f"error: data directory not found: {data_dir}", file=sys.stderr)
            return 2
        files = sorted(data_dir.rglob("*.jsonl"))

    if not files:
        print("error: no JSONL files found", file=sys.stderr)
        return 2

    stats: list[dict] = []
    for path in files:
        print(f"scanning {path} ...", file=sys.stderr)
        stats.append(scan_file(path))

    report = build_report(stats)
    print_ascii_table(report)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"report written to {args.output}", file=sys.stderr)
    else:
        print(json.dumps(report, indent=2, ensure_ascii=False))

    return 0


if __name__ == "__main__":
    sys.exit(main())
