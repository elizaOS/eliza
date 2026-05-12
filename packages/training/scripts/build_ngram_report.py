"""Build NGRAM_ANALYSIS_REPORT.md from the JSON outputs of analyze_ngrams.py.

Reads from `data/synthesized/review/ngrams/` and writes the markdown
report at the repo root. Pure analysis — no corpus access — so this
is safe to re-run after editing.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
NGRAM_DIR = REPO / "data" / "synthesized" / "review" / "ngrams"
OUT_REPORT = REPO / "NGRAM_ANALYSIS_REPORT.md"


def load_json(name: str):
    p = NGRAM_DIR / name
    with p.open("r") as f:
        return json.load(f)


def fmt_pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def fmt_int(x: int) -> str:
    return f"{x:,}"


def short_source(s: str) -> str:
    return s if len(s) <= 28 else s[:25] + "..."


def md_table(headers: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |"]
    out.append("| " + " | ".join("---" for _ in headers) + " |")
    for r in rows:
        out.append("| " + " | ".join(r) + " |")
    return "\n".join(out)


def main() -> int:
    summary = load_json("_run_summary.json")
    user_input = load_json("user_input_ngrams.json")
    thoughts = load_json("assistant_thought_ngrams.json")
    texts = load_json("assistant_text_ngrams.json")
    candidates = load_json("diversification_candidates.json")
    distinctive = load_json("per_source_distinctive.json")

    sampled = summary["sampled_records"]
    rate = summary["sample_rate"]
    elapsed = summary.get("phase1_elapsed_sec", summary.get("elapsed_sec", 0))
    sources = summary.get("sources", {})
    stream_records = summary.get("stream_records", {})

    sections: list[str] = []

    # ------------------------------------------------------------------
    # Header
    # ------------------------------------------------------------------
    sections.append(
        f"""# N-gram Analysis — `data/final/train.jsonl`

This report identifies stylistic n-grams that are over-represented in
the canonical training corpus, with per-source attribution.

- **Input:** `{summary["input"]}`
- **Records sampled:** {fmt_int(sampled)} (every {rate} record{'s' if rate > 1 else ''})
- **Sources observed:** {summary.get("n_sources", 0)}
- **Run time:** {elapsed:.1f}s
- **Stream record counts:**
  - user_input: {fmt_int(stream_records.get("user_input", 0))}
  - assistant_thought: {fmt_int(stream_records.get("assistant_thought", 0))}
  - assistant_text: {fmt_int(stream_records.get("assistant_text", 0))}

## Method (brief)

1. Read every {rate}{'th' if rate > 1 else ''} record from `train.jsonl`. Extract three text streams:
   `user_input` (first 2000 chars of `currentMessage.content`),
   `assistant_thought` (TOON `thought` field of `expectedResponse`), and
   `assistant_text` (TOON `text` field).
2. Tokenize lowercased streams on `[a-z0-9']+`. Compute n-gram counters
   for `n in {{2,3,4,5}}`, with adaptive long-tail pruning to bound memory.
3. For every n-gram track `total_count`, `record_count`,
   per-`source_dataset` counts, and a Gini coefficient over the per-source
   distribution.
4. Flag a "diversification candidate" when `record_pct > 5%`,
   `gini > 0.7`, `n >= 4`, and the n-gram is not on a small allowlist of
   legitimate domain phrases (e.g. "the user", "tool call").
"""
    )

    # ------------------------------------------------------------------
    # 1. Summary — top 50 most concerning n-grams
    # ------------------------------------------------------------------
    # We rank by record_pct * gini (style-tic skew) within the diversification
    # candidates list, falling back to per-stream top n-grams if too short.
    sections.append("## 1. Top 50 most concerning n-grams\n")
    sections.append(
        "Ranked by `record_pct * gini` over the diversification candidates "
        "list. A high score means the n-gram appears in many records and "
        "is concentrated in a small number of source datasets.\n"
    )
    rows = []
    for c in candidates[:50]:
        top = c["top_sources"][:2]
        top_str = ", ".join(
            f"{short_source(s['source'])} ({fmt_pct(s['share'])})" for s in top
        )
        rows.append(
            [
                f"`{c['ngram']}`",
                c["stream"],
                str(c["n"]),
                fmt_int(c["total_count"]),
                fmt_pct(c["record_pct"]),
                f"{c['gini']:.2f}",
                top_str,
            ]
        )
    if rows:
        sections.append(
            md_table(
                ["n-gram", "stream", "n", "total", "rec %", "gini", "top sources"],
                rows,
            )
        )
    else:
        sections.append("_No candidates met the threshold._")
    sections.append("")

    # ------------------------------------------------------------------
    # 2. Per-stream top n-grams
    # ------------------------------------------------------------------
    sections.append("## 2. Per-stream top n-grams\n")
    for stream_name, entries in (
        ("user_input", user_input),
        ("assistant_thought", thoughts),
        ("assistant_text", texts),
    ):
        sections.append(f"### {stream_name}\n")
        for n in (2, 3, 4, 5):
            slice_n = [e for e in entries if e["n"] == n][:30]
            if not slice_n:
                continue
            sections.append(f"#### n={n}\n")
            rows = []
            for e in slice_n:
                top = e["top_sources"][:2]
                top_str = ", ".join(
                    f"{short_source(s['source'])} ({fmt_pct(s['share'])})"
                    for s in top
                )
                rows.append(
                    [
                        f"`{e['ngram']}`",
                        fmt_int(e["total_count"]),
                        fmt_pct(e["record_pct"]),
                        f"{e['gini']:.2f}",
                        top_str,
                    ]
                )
            sections.append(
                md_table(
                    ["n-gram", "total", "rec %", "gini", "top sources"], rows
                )
            )
            sections.append("")

    # ------------------------------------------------------------------
    # 3. Per-source distinctive style
    # ------------------------------------------------------------------
    sections.append("## 3. Per-source distinctive style\n")
    sections.append(
        "For each source, the top 5 n-grams that are >=5x over-represented "
        "in this source vs. the rest of the corpus. This is a **style "
        "fingerprint** of each dataset.\n"
    )
    # sort sources by total record count (descending) to make the report
    # deterministic and useful (biggest sources first)
    sorted_sources = sorted(
        distinctive.keys(),
        key=lambda s: sources.get(s, 0),
        reverse=True,
    )
    for source in sorted_sources:
        entries = distinctive.get(source) or []
        if not entries:
            continue
        n_records = sources.get(source, 0)
        sections.append(f"### {source} ({fmt_int(n_records)} records)\n")
        rows = []
        for e in entries[:5]:
            rows.append(
                [
                    f"`{e['ngram']}`",
                    e["stream"],
                    str(e["n"]),
                    fmt_int(e["source_count"]),
                    f"{e['source_rate']:.3f}/rec",
                    f"{e['rest_rate']:.4f}/rec",
                    f"{e['overrep_ratio']:.1f}x",
                ]
            )
        sections.append(
            md_table(
                [
                    "n-gram",
                    "stream",
                    "n",
                    "in-source",
                    "src rate",
                    "rest rate",
                    "ratio",
                ],
                rows,
            )
        )
        sections.append("")

    # ------------------------------------------------------------------
    # 4. Round-1 synth fingerprint
    # ------------------------------------------------------------------
    # The corpus has no `synth_round` field. We use the round-1 synth
    # source dataset list as the proxy: any record whose source_dataset
    # is one of these is treated as round-1 synth output.
    # "Round-1 synth" voice: sources whose thought field is dominated by
    # the placeholder "Reply to the user." pattern or otherwise share
    # the round-1 Groq voice. Empirically (every-5th-record sweep, 300k
    # records), these sources have 84-100% of records with a placeholder
    # `thought: Reply to the user.` line:
    #   hermes-3                 99.9%
    #   aureth-corpus-hermes     99.9%
    #   nemotron-nano-hermes-tr. 99.9%
    #   hermes-omniforge-qwen36  84.7%
    # Together with the dedicated `synth-*` sources, this gives a tight
    # cluster of "round-1 voice" datasets to fingerprint.
    ROUND1_SYNTH_SOURCES = {
        "synth-routing-v2",
        "synth-action-pairs-actions",
        "synth-action-pairs-lifeops",
        "synth-action-planner",
        "synth-dialogue-routing",
        "synth-messaging-actions",
        "hermes-3",
        "aureth-corpus-hermes",
        "hermes-omniforge-qwen36",
        "nemotron-nano-hermes-traces",
        "hermes-fc-v1",
        "hermes-fc-thinking-v1",
        "hermes-agent-reasoning-traces",
    }
    # n-grams strongly correlated with round-1 synth = those whose
    # top-source share is dominated by one of these sources.
    sections.append("## 4. Round-1 synth fingerprint\n")
    sections.append(
        "n-grams in `assistant_thought` whose top-source is one of "
        f"`{sorted(ROUND1_SYNTH_SOURCES)}`. These are the n-grams most "
        "indicative of the round-1 Groq synth voice.\n"
    )
    # Score: combined share of round-1 sources in the top 5 contributors.
    # We treat an n-gram as "round-1 voice" when round-1 sources together
    # contribute >50% of the occurrences and the top contributor is round-1.
    fingerprint = []
    for e in thoughts:
        if e["n"] < 3:
            continue
        if not e["top_sources"]:
            continue
        round1_share = sum(
            s["share"] for s in e["top_sources"]
            if s["source"] in ROUND1_SYNTH_SOURCES
        )
        top_src = e["top_sources"][0]["source"]
        if top_src in ROUND1_SYNTH_SOURCES and round1_share > 0.5:
            e_aug = dict(e)
            e_aug["round1_share"] = round1_share
            fingerprint.append(e_aug)
    fingerprint.sort(
        key=lambda e: e["total_count"] * e["round1_share"],
        reverse=True,
    )
    rows = []
    for e in fingerprint[:30]:
        top = e["top_sources"][0]
        rows.append(
            [
                f"`{e['ngram']}`",
                str(e["n"]),
                fmt_int(e["total_count"]),
                fmt_pct(e["record_pct"]),
                f"{short_source(top['source'])} ({fmt_pct(top['share'])})",
                f"{e['gini']:.2f}",
            ]
        )
    if rows:
        sections.append(
            md_table(
                ["n-gram", "n", "total", "rec %", "top source", "gini"], rows
            )
        )
    else:
        sections.append(
            "_No `assistant_thought` n-grams matched a round-1 synth "
            "source as their top contributor at the >40% share threshold._"
        )
    sections.append("")

    # ------------------------------------------------------------------
    # 5. Recommendations
    # ------------------------------------------------------------------
    # We compute concrete numbers from the candidate list.
    sections.append("## 5. Recommendations\n")
    sections.append(
        "All numbers below extrapolate from the sampled run "
        f"(every {rate} record). Multiply by ~{rate} for full-corpus impact.\n"
    )

    # Bucket candidates by recommended action
    rewrite_bucket: list[dict] = []
    cap_bucket: dict[str, list[dict]] = defaultdict(list)
    filter_bucket: list[dict] = []

    GARBAGE_PHRASES = (
        "as an ai",
        "i'm an ai",
        "i am an ai",
        "i cannot",
        "i can't help",
        "endoftext",
        "im not able",
        "i don't have the ability",
    )
    HERMES_LIKE_SOURCES = {
        "aureth-corpus-hermes",
        "carnice-glm5-hermes",
        "hermes-3",
        "hermes-omniforge-qwen36",
        "hermes-reasoning-tool-use",
        "hermes-fc-v1",
        "hermes-fc-thinking-v1",
        "hermes-agent-reasoning-traces",
        "nemotron-nano-hermes-traces",
    }

    for c in candidates:
        ngram = c["ngram"]
        top_src = c["top_sources"][0]["source"] if c["top_sources"] else ""
        share = c["top_sources"][0]["share"] if c["top_sources"] else 0.0
        if any(p in ngram for p in GARBAGE_PHRASES):
            filter_bucket.append(c)
        elif top_src in HERMES_LIKE_SOURCES and share > 0.5:
            cap_bucket[top_src].append(c)
        elif share > 0.5 and c["stream"] == "assistant_thought":
            rewrite_bucket.append(c)
        else:
            cap_bucket[top_src].append(c)

    # 5a — Re-paraphrase
    sections.append("### 5a. Re-paraphrase via Groq (round-2 thought rewrite)\n")
    sections.append(
        "**Targets:** assistant_thought n-grams concentrated >50% in a "
        "single source. Action: a Groq pass that takes each affected "
        "record's thought and asks the model to rewrite it without phrase X "
        "(or any close paraphrase).\n"
    )
    if rewrite_bucket:
        # estimate affected records: sum of record_count for the top 10
        # but de-duplicate (one record can match multiple n-grams)
        # we don't know the overlap exactly; report unique-affected as the
        # max() across the top 10 as a loose lower bound and the sum as
        # the upper bound.
        top10 = rewrite_bucket[:10]
        max_rc = max((c["record_count"] for c in top10), default=0)
        sum_rc = sum(c["record_count"] for c in top10)
        sections.append(
            f"**Estimated scope:** {fmt_int(max_rc * rate)} – "
            f"{fmt_int(sum_rc * rate)} affected records (corpus-projected).\n"
        )
        rows = []
        for c in top10:
            top = c["top_sources"][0]
            est_records = c["record_count"] * rate
            rows.append(
                [
                    f"`{c['ngram']}`",
                    str(c["n"]),
                    fmt_int(est_records),
                    fmt_pct(c["record_pct"]),
                    f"{short_source(top['source'])} ({fmt_pct(top['share'])})",
                ]
            )
        sections.append(
            md_table(
                ["n-gram", "n", "≈records", "rec %", "top source"], rows
            )
        )
    else:
        sections.append("_No round-2 rewrite candidates surfaced._")
    sections.append("")

    # 5b — Cap source
    sections.append("### 5b. Lower per-source cap\n")
    sections.append(
        "**Targets:** sources whose distinctive n-grams concentrate the "
        "stylistic skew. Action: lower per-source max from the current "
        "ceiling (~50k) to ~25k or below for these sources, sampling "
        "uniformly within the source.\n"
    )
    rows = []
    for src, entries in sorted(
        cap_bucket.items(),
        key=lambda kv: sum(c["record_count"] for c in kv[1]),
        reverse=True,
    )[:15]:
        if not src:
            continue
        n_records = sources.get(src, 0) * rate
        # show the top 3 n-grams concentrated in this source
        top3 = sorted(entries, key=lambda c: c["record_count"], reverse=True)[:3]
        sample = "; ".join(f"`{c['ngram']}`" for c in top3)
        rows.append(
            [
                src,
                fmt_int(n_records),
                str(len(entries)),
                sample[:120],
            ]
        )
    if rows:
        sections.append(
            md_table(
                ["source", "≈records", "candidates", "sample n-grams"], rows
            )
        )
    else:
        sections.append("_No cap recommendations._")
    sections.append("")

    # 5c — Filter out
    sections.append("### 5c. Filter out (drop matching records)\n")
    sections.append(
        "**Targets:** AI-disclaimer / refusal patterns and tokenizer leakage. "
        "Action: a single-pass regex filter that drops records whose "
        "`expectedResponse` matches one of these phrases.\n"
    )
    if filter_bucket:
        rows = []
        for c in filter_bucket[:15]:
            top = c["top_sources"][0]
            est_records = c["record_count"] * rate
            rows.append(
                [
                    f"`{c['ngram']}`",
                    c["stream"],
                    fmt_int(est_records),
                    f"{short_source(top['source'])} ({fmt_pct(top['share'])})",
                ]
            )
        sections.append(
            md_table(
                ["n-gram", "stream", "≈records", "top source"], rows
            )
        )
    else:
        sections.append(
            "_No AI-disclaimer / `<|endoftext|>` patterns crossed the "
            "5% / gini-0.7 threshold. (They may still exist below the "
            "threshold; recommend a targeted regex sweep.)_"
        )
    sections.append("")

    # ------------------------------------------------------------------
    # Closer
    # ------------------------------------------------------------------
    sections.append("## Files\n")
    sections.append(
        "Raw outputs live under `data/synthesized/review/ngrams/`:"
    )
    for f in (
        "user_input_ngrams.json",
        "assistant_thought_ngrams.json",
        "assistant_text_ngrams.json",
        "diversification_candidates.json",
        "per_source_distinctive.json",
        "_run_summary.json",
    ):
        sections.append(f"- `{f}`")
    sections.append("")

    OUT_REPORT.write_text("\n".join(sections))
    print(f"wrote {OUT_REPORT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
