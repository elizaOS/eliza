"""Streaming n-gram analyzer for the canonical training corpus.

Two-phase, memory-bounded:

  Phase 1 (lean): scan once, count *only* total occurrences per n-gram.
    Adaptive long-tail pruning keeps the master Counter bounded.
    Output: top-K n-gram candidate set per (stream, n).

  Phase 2 (focused): scan again, count per-source + per-record only for
    n-grams in the candidate set. This avoids the explosion of per-source
    dicts on the long tail.

Streams per record:
  - user_input:        currentMessage.content (truncated to 2000 chars)
  - assistant_thought: native JSON `thought` field of expectedResponse
  - assistant_text:    native JSON `text` field of expectedResponse

Outputs (data/synthesized/review/ngrams/):
  - user_input_ngrams.json
  - assistant_thought_ngrams.json
  - assistant_text_ngrams.json
  - diversification_candidates.json
  - per_source_distinctive.json
  - _run_summary.json

Notes
-----
* Read-only on data/final/*. Pure analysis.
* No Bun / native JSON-decoder. Thought/text are extracted via regex from the
  `"thought": "..."` and `"text": "..."` native JSON fields. Robust on the
  canonical corpus and ~50x faster than the Bun decoder for 1.5M lines.
"""

from __future__ import annotations

import argparse
import gc
import json
import math
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable

# ---------------------------------------------------------------------------
# Stream extraction
# ---------------------------------------------------------------------------

THOUGHT_RE = re.compile(
    r'^(?:"thought"|thought)\s*:\s*(?:"((?:[^"\\]|\\.)*)"|([^\n]*))',
    re.MULTILINE,
)
TEXT_RE = re.compile(r'(?:"text"|text)\s*:\s*"((?:[^"\\]|\\.)*)"')


def _decode_escapes(raw: str) -> str:
    if "\\" not in raw:
        return raw
    try:
        return raw.encode("utf-8", "replace").decode("unicode_escape")
    except UnicodeDecodeError:
        return raw


def extract_streams(rec: dict) -> tuple[str, str, str]:
    """Return (user_input, assistant_thought, assistant_text)."""
    cm = rec.get("currentMessage") or {}
    user_input = (cm.get("content") or "")[:2000]

    er = rec.get("expectedResponse") or ""
    thought = ""
    m = THOUGHT_RE.search(er)
    if m:
        raw = m.group(1) if m.group(1) is not None else (m.group(2) or "")
        thought = _decode_escapes(raw)

    text = ""
    m2 = TEXT_RE.search(er)
    if m2:
        text = _decode_escapes(m2.group(1))

    return user_input, thought, text


# ---------------------------------------------------------------------------
# Tokenization
# ---------------------------------------------------------------------------

TOKEN_RE = re.compile(r"[a-z0-9']+")


def tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def iter_ngrams(tokens: list[str], n: int) -> Iterable[str]:
    if len(tokens) < n:
        return
    for i in range(len(tokens) - n + 1):
        yield " ".join(tokens[i : i + n])


# ---------------------------------------------------------------------------
# Phase 1 — total counts only
# ---------------------------------------------------------------------------

STREAMS = ("user_input", "assistant_thought", "assistant_text")
N_VALUES = (2, 3, 4, 5)

# Adaptive prune floors. Phase 1 is lean — we only keep popular n-grams.
PHASE1_FLOOR_BASE = {2: 12, 3: 8, 4: 5, 5: 4}
PHASE1_PRUNE_EVERY = 25_000  # records


def _phase1_floor(n: int, records_seen: int) -> int:
    base = PHASE1_FLOOR_BASE[n]
    if records_seen <= PHASE1_PRUNE_EVERY:
        return base
    scale = max(1.0, (records_seen / PHASE1_PRUNE_EVERY) ** 0.5)
    return int(base * scale)


def phase1_scan(in_path: Path, sample_rate: int, max_records: int) -> dict:
    """Return {(stream, n): Counter[ngram] -> total} plus run stats.

    Memory bound: pruning at PHASE1_PRUNE_EVERY and adaptive floor.
    """
    counters: dict[tuple[str, int], Counter] = {
        (s, n): Counter() for s in STREAMS for n in N_VALUES
    }
    source_record_count: Counter = Counter()
    stream_record_total: dict[str, int] = {s: 0 for s in STREAMS}
    source_stream_record: dict[tuple[str, str], int] = defaultdict(int)
    sampled = 0

    t0 = time.time()
    last_print = t0
    with in_path.open("r", encoding="utf-8") as f:
        for raw_idx, line in enumerate(f):
            if (raw_idx % sample_rate) != 0:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            sampled += 1
            meta = rec.get("metadata") or {}
            source = meta.get("source_dataset") or "unknown"
            source_record_count[source] += 1

            ui, th, tx = extract_streams(rec)
            ui_t = tokenize(ui)
            th_t = tokenize(th)
            tx_t = tokenize(tx)
            stream_tokens = {
                "user_input": ui_t,
                "assistant_thought": th_t,
                "assistant_text": tx_t,
            }
            for s, toks in stream_tokens.items():
                if not toks:
                    continue
                stream_record_total[s] += 1
                source_stream_record[(source, s)] += 1
                for n in N_VALUES:
                    if len(toks) < n:
                        continue
                    c = counters[(s, n)]
                    for ng in iter_ngrams(toks, n):
                        c[ng] += 1

            if sampled % PHASE1_PRUNE_EVERY == 0:
                for (s, n), c in counters.items():
                    floor = _phase1_floor(n, sampled)
                    kill = [k for k, v in c.items() if v < floor]
                    for k in kill:
                        del c[k]
                gc.collect()

            now = time.time()
            if now - last_print > 5:
                rate = sampled / max(1e-6, now - t0)
                print(
                    f"  [phase1] {sampled:,} sampled "
                    f"({raw_idx + 1:,} read) | "
                    f"{rate:.0f} rec/s | "
                    f"elapsed {now - t0:.1f}s",
                    flush=True,
                )
                last_print = now

            if max_records and sampled >= max_records:
                break

    # final prune
    for (s, n), c in counters.items():
        floor = _phase1_floor(n, sampled)
        kill = [k for k, v in c.items() if v < floor]
        for k in kill:
            del c[k]

    elapsed = time.time() - t0
    print(
        f"\n[phase1] sampled {sampled:,} records in {elapsed:.1f}s "
        f"({sampled / max(1e-6, elapsed):.0f} rec/s)",
        flush=True,
    )

    return {
        "counters": counters,
        "source_record_count": source_record_count,
        "stream_record_total": stream_record_total,
        "source_stream_record": source_stream_record,
        "sampled": sampled,
        "elapsed": elapsed,
    }


# ---------------------------------------------------------------------------
# Phase 2 — per-source + per-record counts for the candidate set
# ---------------------------------------------------------------------------

def phase2_scan(
    in_path: Path,
    sample_rate: int,
    max_records: int,
    candidate_sets: dict[tuple[str, int], set[str]],
) -> tuple[dict, dict]:
    """Return (per_source, per_record) where:
      - per_source[(stream, n)][ngram] -> Counter[source] -> count
      - per_record[(stream, n)][ngram] -> int (records-it-appears-in)

    Only tracks the n-grams in `candidate_sets`. This bounds memory.
    """
    per_source: dict[tuple[str, int], dict[str, Counter]] = {
        key: {ng: Counter() for ng in cands}
        for key, cands in candidate_sets.items()
    }
    per_record: dict[tuple[str, int], dict[str, int]] = {
        key: {ng: 0 for ng in cands}
        for key, cands in candidate_sets.items()
    }

    sampled = 0
    t0 = time.time()
    last_print = t0
    with in_path.open("r", encoding="utf-8") as f:
        for raw_idx, line in enumerate(f):
            if (raw_idx % sample_rate) != 0:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            sampled += 1
            meta = rec.get("metadata") or {}
            source = meta.get("source_dataset") or "unknown"

            ui, th, tx = extract_streams(rec)
            stream_tokens = {
                "user_input": tokenize(ui),
                "assistant_thought": tokenize(th),
                "assistant_text": tokenize(tx),
            }

            for s, toks in stream_tokens.items():
                if not toks:
                    continue
                for n in N_VALUES:
                    if len(toks) < n:
                        continue
                    cands = candidate_sets.get((s, n))
                    if not cands:
                        continue
                    src_counter_map = per_source[(s, n)]
                    rec_counter_map = per_record[(s, n)]
                    seen = set()
                    for ng in iter_ngrams(toks, n):
                        if ng in cands:
                            src_counter_map[ng][source] += 1
                            if ng not in seen:
                                rec_counter_map[ng] += 1
                                seen.add(ng)

            now = time.time()
            if now - last_print > 5:
                rate = sampled / max(1e-6, now - t0)
                print(
                    f"  [phase2] {sampled:,} sampled "
                    f"({raw_idx + 1:,} read) | "
                    f"{rate:.0f} rec/s | "
                    f"elapsed {now - t0:.1f}s",
                    flush=True,
                )
                last_print = now

            if max_records and sampled >= max_records:
                break

    elapsed = time.time() - t0
    print(
        f"\n[phase2] sampled {sampled:,} records in {elapsed:.1f}s "
        f"({sampled / max(1e-6, elapsed):.0f} rec/s)",
        flush=True,
    )
    return per_source, per_record


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

def gini(values: list[int]) -> float:
    if not values:
        return 0.0
    s = sum(values)
    if s == 0:
        return 0.0
    n = len(values)
    sorted_v = sorted(values)
    weighted = 0.0
    for i, v in enumerate(sorted_v, start=1):
        weighted += i * v
    return (2 * weighted) / (n * s) - (n + 1) / n


# Allowlist: legitimate domain phrases that should NOT be flagged as
# diversification candidates even if they cluster in a few sources.
ALLOW_PREFIXES = {
    "the user",
    "tool call",
    "tool calls",
    "function call",
    "function calls",
    "the assistant",
    "the agent",
    "the system",
    "the api",
    "the response",
    "the request",
    "the message",
    "the conversation",
    "the channel",
    "the room",
}
ALLOW_TOKENS = {
    "api", "url", "json", "http", "https", "args", "params",
}


def _is_allowed(ngram: str) -> bool:
    if ngram in ALLOW_PREFIXES:
        return True
    parts = ngram.split()
    if all(p in ALLOW_TOKENS for p in parts):
        return True
    return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", default="data/final/train.jsonl")
    p.add_argument("--output", default="data/synthesized/review/ngrams")
    p.add_argument("--sample-rate", type=int, default=3)
    p.add_argument("--max-records", type=int, default=0)
    p.add_argument("--top-n", type=int, default=500)
    p.add_argument(
        "--phase2-pool",
        type=int,
        default=2000,
        help="Number of top n-grams per (stream, n) to track in phase 2.",
    )
    args = p.parse_args()

    in_path = Path(args.input)
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not in_path.exists():
        print(f"missing input: {in_path}", file=sys.stderr)
        return 2

    sample_rate = max(1, args.sample_rate)

    # Phase 1 -------------------------------------------------------------
    print("=== PHASE 1: total counts ===", flush=True)
    p1 = phase1_scan(in_path, sample_rate, args.max_records)

    # Build candidate set: top phase2-pool per (stream, n).
    candidate_sets: dict[tuple[str, int], set[str]] = {}
    for key, c in p1["counters"].items():
        top_ngrams = [k for k, _ in c.most_common(args.phase2_pool)]
        candidate_sets[key] = set(top_ngrams)

    total_candidates = sum(len(s) for s in candidate_sets.values())
    print(
        f"\n[phase1] {total_candidates:,} candidate n-grams "
        f"selected for phase 2 ({args.phase2_pool} per (stream,n))",
        flush=True,
    )

    # Free phase 1 long-tail; we still need totals for the candidate set
    phase1_totals: dict[tuple[str, int], dict[str, int]] = {}
    for key, c in p1["counters"].items():
        cands = candidate_sets[key]
        phase1_totals[key] = {ng: c[ng] for ng in cands}
    del p1["counters"]
    gc.collect()

    # Phase 2 -------------------------------------------------------------
    print("\n=== PHASE 2: per-source + per-record ===", flush=True)
    per_source, per_record = phase2_scan(
        in_path,
        sample_rate,
        args.max_records,
        candidate_sets,
    )

    # ------------------------------------------------------------------
    # Build final entries
    # ------------------------------------------------------------------
    source_record_count = p1["source_record_count"]
    stream_record_total = p1["stream_record_total"]
    source_stream_record = p1["source_stream_record"]

    def build_entry(stream: str, n: int, ng: str) -> dict:
        total = phase1_totals[(stream, n)].get(ng, 0)
        rcount = per_record[(stream, n)].get(ng, 0)
        per_src = per_source[(stream, n)].get(ng, Counter())
        denom = stream_record_total[stream] or 1
        sources = sorted(per_src.items(), key=lambda kv: kv[1], reverse=True)
        top_sources = [
            {
                "source": s,
                "count": c,
                "share": (c / total) if total else 0.0,
            }
            for s, c in sources[:5]
        ]
        return {
            "ngram": ng,
            "stream": stream,
            "n": n,
            "total_count": total,
            "record_count": rcount,
            "record_pct": rcount / denom,
            "stream_records": denom,
            "top_sources": top_sources,
            "n_sources": len(per_src),
            "gini": round(gini(list(per_src.values())), 4),
        }

    # Per-stream JSONs: top-N across all n-values, sorted by total_count.
    for stream in STREAMS:
        all_entries: list[dict] = []
        for n in N_VALUES:
            top_keys = [
                k
                for k, _ in sorted(
                    phase1_totals[(stream, n)].items(),
                    key=lambda kv: kv[1],
                    reverse=True,
                )[: args.top_n]
            ]
            for key in top_keys:
                all_entries.append(build_entry(stream, n, key))
        all_entries.sort(key=lambda e: e["total_count"], reverse=True)
        all_entries = all_entries[: args.top_n]
        out_file = out_dir / f"{stream}_ngrams.json"
        out_file.write_text(json.dumps(all_entries, indent=2))
        print(f"wrote {out_file} ({len(all_entries)} entries)")

    # Diversification candidates
    candidates: list[dict] = []
    for stream in STREAMS:
        for n in N_VALUES:
            if n < 4:
                continue
            denom = stream_record_total[stream] or 1
            for ng in candidate_sets[(stream, n)]:
                rcount = per_record[(stream, n)].get(ng, 0)
                pct = rcount / denom
                if pct < 0.05:
                    continue
                per_src = per_source[(stream, n)].get(ng, Counter())
                g = gini(list(per_src.values()))
                if g < 0.7:
                    continue
                if _is_allowed(ng):
                    continue
                candidates.append(build_entry(stream, n, ng))
    candidates.sort(
        key=lambda e: (e["record_pct"] * e["gini"], e["total_count"]),
        reverse=True,
    )
    cand_file = out_dir / "diversification_candidates.json"
    cand_file.write_text(json.dumps(candidates, indent=2))
    print(f"wrote {cand_file} ({len(candidates)} candidates)")

    # Per-source distinctive — for each source, top 20 n-grams >5x over
    distinctive: dict[str, list[dict]] = {}
    OVERREP_THRESHOLD = 5.0
    MIN_SOURCE_COUNT = 50
    for source in source_record_count:
        per_source_entries: list[dict] = []
        for stream in STREAMS:
            stream_records_in_source = source_stream_record.get(
                (source, stream), 0
            )
            stream_records_total = stream_record_total[stream] or 1
            if stream_records_in_source < 100:
                continue
            for n in (4, 5):
                for ng in candidate_sets[(stream, n)]:
                    src_count = per_source[(stream, n)][ng].get(source, 0)
                    if src_count < MIN_SOURCE_COUNT:
                        continue
                    total = phase1_totals[(stream, n)][ng]
                    rest = total - src_count
                    rest_records = (
                        stream_records_total - stream_records_in_source
                    )
                    if rest_records <= 0:
                        continue
                    rest_rate = rest / rest_records
                    src_rate = src_count / stream_records_in_source
                    if rest_rate <= 0:
                        ratio = float("inf") if src_rate > 0 else 0.0
                    else:
                        ratio = src_rate / rest_rate
                    if ratio < OVERREP_THRESHOLD:
                        continue
                    per_source_entries.append(
                        {
                            "ngram": ng,
                            "stream": stream,
                            "n": n,
                            "source_count": src_count,
                            "source_rate": src_rate,
                            "rest_rate": rest_rate,
                            "overrep_ratio": (
                                ratio if math.isfinite(ratio) else 9999.0
                            ),
                            "source_records": stream_records_in_source,
                        }
                    )
        per_source_entries.sort(
            key=lambda e: e["overrep_ratio"], reverse=True
        )
        distinctive[source] = per_source_entries[:20]

    distinctive_file = out_dir / "per_source_distinctive.json"
    distinctive_file.write_text(json.dumps(distinctive, indent=2))
    print(
        f"wrote {distinctive_file} ({len(distinctive)} sources)",
    )

    summary = {
        "input": str(in_path),
        "sampled_records": p1["sampled"],
        "sample_rate": sample_rate,
        "phase1_elapsed_sec": round(p1["elapsed"], 1),
        "stream_records": stream_record_total,
        "n_sources": len(source_record_count),
        "sources": dict(source_record_count.most_common()),
    }
    (out_dir / "_run_summary.json").write_text(json.dumps(summary, indent=2))
    print(f"wrote {out_dir / '_run_summary.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
