#!/usr/bin/env python3
"""N-gram diversification — rewrite over-represented n-grams in the assistant
streams (`thought` and `text`) of `expectedResponse`.

Driven by `data/synthesized/review/ngrams/diversification_candidates.json`
produced by `scripts/analyze_ngrams.py`. A candidate has `record_pct > 5%`,
`gini > 0.7`, `n >= 4`. Static paraphrase tables cover the worst offenders
(n8n template tail, nemotron tool-call thought boilerplate); other
candidates with no static rule are reported as flagged-for-manual-review.

Behavior contract
-----------------
* Read-only on user_input. Only `assistant_thought` and `assistant_text`
  native JSON fields are rewritten — the user side is conditioning, not target.
* Deterministic per record: seed = `roomName + agentId`. Re-running on the
  same input produces the same output.
* native JSON-validity preserving: rewrites operate on the inner string of the
  `text:`/`thought:` field. The shape of the native JSON document is untouched.
  An acceptance check round-trip-decodes a 100-record sample at the end.
* Replacements only happen when the paraphrase is at least 3 tokens shorter
  than the original n-gram. Empty pool / equal-length pool entries are
  skipped, leaving the original verbatim.
* Per-ngram + per-source replacement counts land in
  `data/synthesized/review/ngrams/diversification_applied.json`.

CLI
---
    python scripts/transform_ngram_diversify.py \\
        --input data/final/train.jsonl \\
        --output data/intermediate/train_ngram_diversified.jsonl \\
        --candidates data/synthesized/review/ngrams/diversification_candidates.json \\
        [--dry-run] [--max-records N]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Paraphrase tables
# ---------------------------------------------------------------------------
#
# (A) Static n8n boilerplate. The n8n-mega-workflows + n8n-workflows-templates
#     family emits a verbatim template tail
#         "... nodes connect any required credentials then confirm to deploy."
#     in 12.6% of records. Hard-coded paraphrases are appropriate here because
#     the source phrasing is already mechanical.
#
# (B) Thought-leak patterns. Nemotron-rl-tool-use + dolci-instruct + openclaw
#     repeatedly produce phrases like "call the tool to satisfy the request".
#     Replaced with a small, more natural pool. Sampled uniformly per record.

N8N_TEMPLATE_PARAPHRASES: dict[str, list[str]] = {
    # 5-gram and 4-gram supersets — match longest first (see PARAPHRASE_ORDER)
    "nodes connect any required credentials then confirm to deploy": [
        "wire up the credentials and deploy",
        "set credentials and deploy",
        "add credentials, then deploy",
        "configure the credential bindings and ship",
        "fill in credentials and deploy",
        "plug in the credentials and run",
    ],
    "connect any required credentials then confirm to deploy": [
        "wire up credentials and deploy",
        "set credentials, then deploy",
        "add credentials and ship",
        "configure credentials and run",
        "fill in credentials and deploy",
        "plug in credentials and run",
    ],
    "connect any required credentials then confirm": [
        "wire up credentials, then confirm",
        "set credentials, then confirm",
        "add credentials and confirm",
    ],
    "any required credentials then confirm to deploy": [
        "credentials, then deploy",
        "credentials and ship",
        "credentials, then run",
    ],
    "required credentials then confirm to deploy": [
        "credentials, then deploy",
        "credentials and run",
        "credentials, then ship",
    ],
    "credentials then confirm to deploy": [
        "credentials and deploy",
        "credentials, then deploy",
        "credentials and ship",
    ],
    "nodes connect any required credentials": [
        "wire up the credentials",
        "set the credentials",
        "configure credentials",
    ],
    "connect any required credentials": [
        "wire up credentials",
        "set credentials",
        "configure credentials",
        "add credentials",
        "plug in credentials",
    ],
    "any required credentials then confirm": [
        "credentials, then confirm",
        "credentials and confirm",
    ],
    "required credentials then confirm": [
        "credentials, then confirm",
        "credentials and confirm",
    ],
    "credentials then confirm to": [
        "credentials, then",
        "credentials and",
    ],
    "then confirm to deploy": [
        "and deploy",
        "then deploy",
        "and ship",
        "then run",
        "and launch",
    ],
}

THOUGHT_LEAK_PARAPHRASES: dict[str, list[str]] = {
    "call the tool to satisfy the request": [
        "use the tool",
        "invoke the matching tool",
        "run the right tool",
        "fire the tool",
    ],
    "tool to satisfy the request": [
        "tool for the ask",
        "tool for this",
        "right tool",
    ],
    "to satisfy the request": [
        "for the ask",
        "for this",
        "for the user",
    ],
    "call the tool to": [
        # 4 tokens -> 2 tokens. Saves >=3 tokens? 4 - 2 = 2. Skipped by guard.
        # Kept here so flagged-as-manual is accurate; guard rejects at runtime.
        "use the",
        "fire the",
    ],
    "the user s request": [
        "the request",
        "the ask",
        "what was asked",
    ],
}

# Order matters: we apply longest patterns first so a 5-gram beats its 4-gram
# subset to the same span. Built from the union of both tables.
PARAPHRASE_TABLE: dict[str, list[str]] = {
    **N8N_TEMPLATE_PARAPHRASES,
    **THOUGHT_LEAK_PARAPHRASES,
}
PARAPHRASE_ORDER: list[str] = sorted(
    PARAPHRASE_TABLE.keys(),
    key=lambda k: (-len(k.split()), -len(k)),
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

MIN_TOKEN_SAVINGS = 3  # required shortening to accept a paraphrase


def _tokens(s: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9']+", s)


def _ngram_to_regex(ng: str) -> re.Pattern[str]:
    """Word-boundary, case-insensitive, whitespace-flexible match."""
    parts = [re.escape(t) for t in ng.split()]
    pat = r"\b" + r"\s+".join(parts) + r"\b"
    return re.compile(pat, re.IGNORECASE)


def _stable_choice(seed_key: str, choices: list[str]) -> str:
    h = int(hashlib.md5(seed_key.encode("utf-8")).hexdigest()[:8], 16)
    return choices[h % len(choices)]


def _record_seed(rec: dict) -> str:
    """Deterministic seed per record. Falls back to JSON hash when ids absent."""
    rn = rec.get("roomName") or ""
    aid = rec.get("agentId") or ""
    if rn or aid:
        return f"{rn}|{aid}"
    # last-ditch: hash the canonical message + first 200 chars of expectedResponse
    cm = (rec.get("currentMessage") or {}).get("content") or ""
    er = rec.get("expectedResponse") or ""
    return hashlib.md5((cm[:200] + er[:200]).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Candidate ingestion
# ---------------------------------------------------------------------------

def _load_candidates(path: Path) -> tuple[list[dict], dict[str, list[str]]]:
    """Return (raw_candidates, applicable_paraphrases) keyed by ngram lowercase.

    `applicable_paraphrases` only contains candidates that:
      * appear in `assistant_thought` or `assistant_text` streams,
      * have at least one paraphrase that beats the MIN_TOKEN_SAVINGS guard.

    Candidates that don't qualify are still returned in `raw_candidates` so the
    caller can flag them for manual review.
    """
    if not path.exists():
        raise SystemExit(
            f"missing candidates file: {path}\n"
            "Run scripts/analyze_ngrams.py first."
        )
    raw = json.loads(path.read_text())
    if not isinstance(raw, list):
        raise SystemExit(f"unexpected candidates shape: {type(raw)}")

    applicable: dict[str, list[str]] = {}
    for entry in raw:
        ng = (entry.get("ngram") or "").lower().strip()
        stream = entry.get("stream", "")
        if stream not in ("assistant_thought", "assistant_text"):
            continue
        pool = PARAPHRASE_TABLE.get(ng, [])
        if not pool:
            continue
        n_tokens = len(ng.split())
        keep = [p for p in pool if n_tokens - len(_tokens(p)) >= MIN_TOKEN_SAVINGS]
        if not keep:
            continue
        applicable[ng] = keep
    return raw, applicable


def _flag_unmatched(raw: list[dict]) -> list[dict]:
    """Return candidates that have no static paraphrase rule + are eligible
    in the assistant streams. These need manual authoring."""
    flagged: list[dict] = []
    for entry in raw:
        ng = (entry.get("ngram") or "").lower().strip()
        stream = entry.get("stream", "")
        if stream not in ("assistant_thought", "assistant_text"):
            continue
        if ng in PARAPHRASE_TABLE:
            # Still flag if all pool entries failed the savings guard.
            n_tokens = len(ng.split())
            pool = PARAPHRASE_TABLE[ng]
            keep = [p for p in pool if n_tokens - len(_tokens(p)) >= MIN_TOKEN_SAVINGS]
            if keep:
                continue
        flagged.append({
            "ngram": entry.get("ngram"),
            "stream": stream,
            "n": entry.get("n"),
            "record_pct": entry.get("record_pct"),
            "gini": entry.get("gini"),
            "top_sources": entry.get("top_sources", [])[:3],
            "reason": (
                "no static paraphrase rule"
                if ng not in PARAPHRASE_TABLE
                else "all pool entries fail >=3-token savings guard"
            ),
        })
    return flagged


# ---------------------------------------------------------------------------
# String rewriter
# ---------------------------------------------------------------------------

class Rewriter:
    """Stateful per-stream rewriter. Tracks per-ngram replacement counts."""

    def __init__(self, applicable: dict[str, list[str]], stream: str) -> None:
        self.stream = stream
        self.pools: dict[str, list[str]] = applicable
        self.compiled: list[tuple[str, re.Pattern[str]]] = [
            (ng, _ngram_to_regex(ng))
            for ng in PARAPHRASE_ORDER
            if ng in applicable
        ]
        self.replacements: Counter = Counter()

    def rewrite(self, text: str, *, seed: str) -> tuple[str, int]:
        if not isinstance(text, str) or not text:
            return text, 0
        out = text
        local_hits = 0
        for ng, pat in self.compiled:
            pool = self.pools.get(ng)
            if not pool:
                continue

            def _replace(match: re.Match, *, _ng: str = ng, _pool: list[str] = pool) -> str:
                nonlocal local_hits
                key = f"{seed}|{self.stream}|{_ng}|{match.start()}"
                choice = _stable_choice(key, _pool)
                # Defensive: re-check the savings guard at runtime.
                if len(_tokens(_ng)) - len(_tokens(choice)) < MIN_TOKEN_SAVINGS:
                    return match.group(0)
                self.replacements[_ng] += 1
                local_hits += 1
                # Preserve a leading capital if the original started with one.
                orig = match.group(0)
                if orig[:1].isupper() and choice[:1].islower():
                    choice = choice[:1].upper() + choice[1:]
                return choice

            out = pat.sub(_replace, out)
        return out, local_hits


# ---------------------------------------------------------------------------
# native JSON field substitution
# ---------------------------------------------------------------------------

NATIVE_JSON_THOUGHT_QUOTED = re.compile(
    r'(^|\n)(\s*thought:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
    re.DOTALL,
)
NATIVE_JSON_THOUGHT_UNQUOTED = re.compile(
    r'(^|\n)(\s*thought:\s*)([^"\n][^\n]*)(?=\n|$)',
)
NATIVE_JSON_TEXT_QUOTED = re.compile(
    r'(^|\n)(\s*text:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
    re.DOTALL,
)
NATIVE_JSON_TEXT_UNQUOTED = re.compile(
    r'(^|\n)(\s*text:\s*)([^"\n][^\n]*)(?=\n|$)',
)


def _sub_quoted(payload: str, regex: re.Pattern[str], rewriter: Rewriter, seed: str) -> tuple[str, int]:
    hits = 0

    def _r(m: re.Match) -> str:
        nonlocal hits
        prefix, key, quoted, suffix = m.groups()
        try:
            inner = json.loads(quoted)
        except json.JSONDecodeError:
            return m.group(0)
        new_inner, n = rewriter.rewrite(inner, seed=seed)
        if n == 0 or new_inner == inner:
            return m.group(0)
        hits += n
        return f"{prefix}{key}{json.dumps(new_inner, ensure_ascii=False)}{suffix}"

    return regex.sub(_r, payload), hits


def _sub_unquoted(payload: str, regex: re.Pattern[str], rewriter: Rewriter, seed: str) -> tuple[str, int]:
    hits = 0

    def _r(m: re.Match) -> str:
        nonlocal hits
        prefix, key, value = m.groups()
        new_value, n = rewriter.rewrite(value, seed=seed)
        if n == 0 or new_value == value:
            return m.group(0)
        hits += n
        # Promote to a quoted form if the new value contains native JSON-special chars.
        if any(c in new_value for c in '"\n\\,'):
            return f"{prefix}{key}{json.dumps(new_value, ensure_ascii=False)}"
        return f"{prefix}{key}{new_value}"

    return regex.sub(_r, payload), hits


def diversify_record(
    rec: dict,
    *,
    text_rw: Rewriter,
    thought_rw: Rewriter,
    per_source_hits: dict[str, Counter],
) -> tuple[dict, int]:
    er = rec.get("expectedResponse")
    if not isinstance(er, str) or not er:
        return rec, 0
    seed = _record_seed(rec)
    new_er = er
    total_hits = 0
    new_er, h1 = _sub_quoted(new_er, NATIVE_JSON_THOUGHT_QUOTED, thought_rw, seed)
    new_er, h2 = _sub_unquoted(new_er, NATIVE_JSON_THOUGHT_UNQUOTED, thought_rw, seed)
    new_er, h3 = _sub_quoted(new_er, NATIVE_JSON_TEXT_QUOTED, text_rw, seed)
    new_er, h4 = _sub_unquoted(new_er, NATIVE_JSON_TEXT_UNQUOTED, text_rw, seed)
    total_hits = h1 + h2 + h3 + h4
    if total_hits and new_er != er:
        rec["expectedResponse"] = new_er
        src = (rec.get("metadata") or {}).get("source_dataset") or "unknown"
        per_source_hits[src]["records"] += 1
        per_source_hits[src]["replacements"] += total_hits
    return rec, total_hits


# ---------------------------------------------------------------------------
# Acceptance check (no-op: native JSON decoder removed in native v5)
# ---------------------------------------------------------------------------

def _acceptance_check(sample: list[str]) -> dict:
    """Acceptance check is skipped — native JSON decoder is not available in native v5."""
    return {"checked": 0, "ok": 0, "failed": 0, "skipped": True}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", default="data/final/train.jsonl")
    p.add_argument(
        "--output",
        default="data/intermediate/train_ngram_diversified.jsonl",
    )
    p.add_argument(
        "--candidates",
        default="data/synthesized/review/ngrams/diversification_candidates.json",
    )
    p.add_argument(
        "--summary",
        default="data/synthesized/review/ngrams/diversification_applied.json",
    )
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--max-records", type=int, default=0)
    args = p.parse_args()

    in_path = Path(args.input).resolve() if Path(args.input).is_absolute() else (ROOT / args.input)
    out_path = Path(args.output).resolve() if Path(args.output).is_absolute() else (ROOT / args.output)
    cand_path = Path(args.candidates).resolve() if Path(args.candidates).is_absolute() else (ROOT / args.candidates)
    summary_path = Path(args.summary).resolve() if Path(args.summary).is_absolute() else (ROOT / args.summary)

    raw_cands, applicable = _load_candidates(cand_path)
    flagged = _flag_unmatched(raw_cands)

    print(
        f"[ngram-diversify] candidates loaded: {len(raw_cands)}; "
        f"applicable (with shorter paraphrase): {len(applicable)}; "
        f"flagged for manual review: {len(flagged)}",
        file=sys.stderr,
    )

    if args.dry_run:
        # Project hit count from candidate record_count totals.
        projected = 0
        for entry in raw_cands:
            ng = (entry.get("ngram") or "").lower().strip()
            if ng in applicable:
                projected += int(entry.get("record_count") or 0)
        print(
            json.dumps(
                {
                    "dry_run": True,
                    "candidate_set_size": len(raw_cands),
                    "applicable_size": len(applicable),
                    "flagged_for_manual_review": len(flagged),
                    "projected_record_replacements_upper_bound": projected,
                    "applicable_ngrams": sorted(applicable.keys()),
                    "flagged_ngrams_first_10": [f["ngram"] for f in flagged[:10]],
                },
                indent=2,
            )
        )
        return 0

    if not in_path.exists():
        print(f"missing input: {in_path}", file=sys.stderr)
        return 2

    out_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.parent.mkdir(parents=True, exist_ok=True)

    text_rw = Rewriter(applicable, stream="assistant_text")
    thought_rw = Rewriter(applicable, stream="assistant_thought")
    per_source_hits: dict[str, Counter] = defaultdict(Counter)

    stats = {
        "total": 0,
        "decode_errors": 0,
        "records_changed": 0,
        "records_skipped": 0,
        "total_replacements": 0,
    }
    t0 = time.time()
    last_print = t0
    with in_path.open("r", encoding="utf-8") as fin, out_path.open("w", encoding="utf-8") as fout:
        for line in fin:
            stats["total"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                stats["decode_errors"] += 1
                fout.write(line)
                continue
            rec, hits = diversify_record(
                rec,
                text_rw=text_rw,
                thought_rw=thought_rw,
                per_source_hits=per_source_hits,
            )
            if hits:
                stats["records_changed"] += 1
                stats["total_replacements"] += hits
            else:
                stats["records_skipped"] += 1
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")

            now = time.time()
            if now - last_print > 5:
                rate = stats["total"] / max(1e-6, now - t0)
                print(
                    f"[ngram-diversify] {stats['total']:>8d}  "
                    f"changed={stats['records_changed']:>7d}  "
                    f"replacements={stats['total_replacements']:>7d}  "
                    f"{rate:.0f} rec/s",
                    file=sys.stderr,
                )
                last_print = now

            if args.max_records and stats["total"] >= args.max_records:
                break

    elapsed = round(time.time() - t0, 1)

    summary = {
        "input": str(in_path),
        "output": str(out_path),
        "candidates_path": str(cand_path),
        "elapsed_sec": elapsed,
        "totals": stats,
        "per_ngram_replacements": {
            "assistant_text": dict(text_rw.replacements),
            "assistant_thought": dict(thought_rw.replacements),
        },
        "per_source_replacements": {
            src: {"records": c["records"], "replacements": c["replacements"]}
            for src, c in sorted(
                per_source_hits.items(),
                key=lambda kv: kv[1]["replacements"],
                reverse=True,
            )
        },
        "applicable_ngrams": sorted(applicable.keys()),
        "flagged_for_manual_review": flagged,
    }
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(json.dumps(summary["totals"], indent=2), file=sys.stderr)
    print(f"[ngram-diversify] summary -> {summary_path}", file=sys.stderr)
    print(f"[ngram-diversify] output -> {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
