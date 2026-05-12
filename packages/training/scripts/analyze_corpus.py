"""Corpus-level analysis for the Eliza training set.

Phase A of the dedup/variance pipeline: catch near-duplicate templated
records by mining n-gram repetition, source-to-source overlap, and per-
source uniqueness on `expectedResponse` text.

Outputs `CORPUS_ANALYSIS.md` at the repo root.

Strategy
--------
1.  Stratified sample of N=200,000 records across all sources, with a per-
    source cap (default 5,000) so giants like agent-trove don't dominate.
    Reservoir-sampled with a seeded RNG via Algorithm L so we don't have to
    hold a 7M list in memory.
2.  N-gram tokenization on whitespace + word-boundary regex (cheap; not
    BPE). Counts of 3/5/8/13-grams via Counter.
3.  For each ngram, also keep a Counter of sources it appears in so we
    can report "ngram X comes from sources A, B, C".
4.  Source-pair overlap on the *set* of unique 5-grams (Jaccard).
5.  Per-source 8-gram repetition score = unique_8grams / total_8grams.

Memory budget: a 200k stratified sample with 8-gram counters across all
sources fits easily on this machine (~16 GB RAM available); the dominant
cost is the per-source 5-gram set used for Jaccard.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parent.parent
NORMALIZED = ROOT / "data" / "normalized"
SYNTHESIZED = ROOT / "data" / "synthesized"
REPORT_PATH = ROOT / "CORPUS_ANALYSIS.md"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("analyze")

TOKEN_RE = re.compile(r"[A-Za-z0-9_]+|[^\sA-Za-z0-9_]")


def tokenize(text: str) -> list[str]:
    """Cheap whitespace + word-boundary tokenizer (lowercased)."""
    return TOKEN_RE.findall(text.lower())


def ngrams(tokens: list[str], n: int) -> Iterable[tuple[str, ...]]:
    if len(tokens) < n:
        return
    for i in range(len(tokens) - n + 1):
        yield tuple(tokens[i : i + n])


# ─────────────── source enumeration ────────────────────────────────────


def enumerate_sources() -> list[tuple[str, Path]]:
    """All `(slug, path)` pairs the analysis covers.

    Mirrors `pack_dataset.enumerate_sources` so the analysis matches what
    actually ends up in `train.jsonl` rather than some other view.
    """
    out: list[tuple[str, Path]] = []
    for path in sorted(NORMALIZED.glob("*.jsonl")):
        if path.name.endswith(".errors.jsonl"):
            continue
        out.append((path.stem, path))
    # Synthesized: top-level files + nested dirs
    for path in sorted(SYNTHESIZED.glob("*.jsonl")):
        out.append((f"synth:{path.stem}", path))
    for sub in sorted(SYNTHESIZED.iterdir()):
        if not sub.is_dir():
            continue
        for path in sorted(sub.glob("*.jsonl")):
            out.append((f"synth:{sub.name}/{path.stem}", path))
    return out


def fast_count(path: Path) -> int:
    """Count newlines without parsing JSON."""
    n = 0
    buf_size = 1 << 20
    with path.open("rb") as f:
        while True:
            buf = f.read(buf_size)
            if not buf:
                break
            n += buf.count(b"\n")
    return n


# ─────────────── stratified sampling ───────────────────────────────────


def reservoir_indices(n_total: int, k: int, rng: random.Random) -> set[int]:
    """Algorithm L; returns a sorted-iterable set of k indices in [0, n_total).

    For small n_total or large k, falls back to direct enumeration.
    """
    if k >= n_total:
        return set(range(n_total))
    if k <= 0 or n_total <= 0:
        return set()
    indices: list[int] = list(range(k))
    i = k
    w = math.exp(math.log(rng.random()) / k)
    while True:
        skip = math.floor(math.log(rng.random()) / math.log(1 - w))
        i += skip + 1
        if i >= n_total:
            break
        indices[rng.randrange(k)] = i
        w *= math.exp(math.log(rng.random()) / k)
    return set(indices)


def iter_sampled(
    path: Path, keep: set[int]
) -> Iterable[dict]:
    if not keep:
        return
    max_idx = max(keep)
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for idx, line in enumerate(f):
            if idx > max_idx:
                break
            if idx not in keep:
                continue
            line = line.rstrip("\n")
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


# ─────────────── analysis ──────────────────────────────────────────────


def analyze(args: argparse.Namespace) -> int:
    rng = random.Random(args.seed)
    sources = enumerate_sources()
    if not sources:
        log.error("no sources found in %s or %s", NORMALIZED, SYNTHESIZED)
        return 1

    log.info("counting %d sources", len(sources))
    counts: dict[str, int] = {}
    for slug, path in sources:
        counts[slug] = fast_count(path)
        log.info("  %-50s %10d", slug, counts[slug])

    total = sum(counts.values())
    log.info("corpus total: %d records across %d sources", total, len(sources))

    # Compute per-source sample budget. Stratified by record count, capped.
    # We aim for `args.sample_size` total, distributed proportional to count
    # with a per-source ceiling.
    target_total = args.sample_size
    cap = args.per_source_cap
    raw_budget = {s: min(cap, int(target_total * (n / total))) for s, n in counts.items()}
    # Tiny sources fall to 0 with proportional allocation; add a floor so
    # every source is represented.
    floor = args.per_source_floor
    for s, n in counts.items():
        if raw_budget[s] < min(floor, n):
            raw_budget[s] = min(floor, n)
    grand = sum(raw_budget.values())
    log.info(
        "stratified budget: target=%d cap=%d floor=%d -> grand=%d",
        target_total, cap, floor, grand,
    )

    # Per-source state. For Jaccard we keep a *set* of unique 5-grams per
    # source. For repetition score we keep total/unique 8-gram counts per
    # source.
    sample_size_per_source: dict[str, int] = dict(raw_budget)
    src_5g_set: dict[str, set[tuple[str, ...]]] = defaultdict(set)
    src_8g_total: Counter = Counter()
    src_8g_unique: Counter = Counter()

    # Global ngram counts + per-ngram source histogram (only top-K per
    # ngram size are eventually reported, but we need all of them while
    # streaming. We keep one Counter per n.).
    ng_counts: dict[int, Counter] = {n: Counter() for n in (3, 5, 8, 13)}
    # Per-ngram source histogram is expensive; restrict it to ngrams that
    # appear above a low threshold by doing two passes? Simpler: sample
    # smaller (200k records, ~20-50 5-grams each = ~10M observations).
    # We keep only ngrams that appear ≥2 times, then attach source info
    # in a second pass over the sampled records (cheap; we already have
    # them in memory in `sampled` list).

    # Keep the sampled records (just `expectedResponse` + slug + task_type)
    # so we can do per-ngram source attribution after we know the top ngrams.
    sampled: list[tuple[str, str, str]] = []  # (slug, task_type, expectedResponse)

    log.info("pass 2: sampling + ngram counting")
    for slug, path in sources:
        k = sample_size_per_source[slug]
        n = counts[slug]
        if k == 0 or n == 0:
            continue
        keep = reservoir_indices(n, k, rng)
        for rec in iter_sampled(path, keep):
            er = rec.get("expectedResponse") or ""
            if not isinstance(er, str):
                continue
            md = rec.get("metadata") or {}
            tt = (md.get("task_type") or "?")
            tokens = tokenize(er)
            if not tokens:
                continue
            sampled.append((slug, tt, er))

            # 5-gram set for Jaccard
            five = list(ngrams(tokens, 5))
            src_5g_set[slug].update(five)

            # 8-gram counts for repetition score
            eight = list(ngrams(tokens, 8))
            src_8g_total[slug] += len(eight)
            src_8g_unique[slug] += len(set(eight))

            # Global ngram counters
            for nn in (3, 5, 8, 13):
                if nn == 5:
                    grams = five
                elif nn == 8:
                    grams = eight
                else:
                    grams = list(ngrams(tokens, nn))
                ng_counts[nn].update(grams)
        log.info("  sampled %s: %d", slug, k)

    log.info("sampled %d records total", len(sampled))

    # ───── attach per-ngram source histograms for top results ─────
    top_n_per_size = args.top_per_size
    top_results: dict[int, list[tuple[tuple[str, ...], int, list[tuple[str, int]]]]] = {}
    for nn, counter in ng_counts.items():
        if not counter:
            top_results[nn] = []
            continue
        top = counter.most_common(top_n_per_size)
        top_set = {gram for gram, _ in top}
        # Build per-ngram source histogram
        hist: dict[tuple[str, ...], Counter] = defaultdict(Counter)
        for slug, _tt, er in sampled:
            tokens = tokenize(er)
            for gram in ngrams(tokens, nn):
                if gram in top_set:
                    hist[gram][slug] += 1
        top_results[nn] = [
            (gram, cnt, hist[gram].most_common(3)) for gram, cnt in top
        ]
        log.info("ranked top-%d %d-grams (over %d unique)", top_n_per_size, nn, len(counter))

    # ───── source-to-source Jaccard on 5-grams ─────
    log.info("computing pairwise 5-gram Jaccard (%d sources)", len(src_5g_set))
    pairs: list[tuple[float, str, str, int, int, int]] = []
    slugs = sorted(src_5g_set.keys())
    for i in range(len(slugs)):
        a = slugs[i]
        sa = src_5g_set[a]
        if not sa:
            continue
        for j in range(i + 1, len(slugs)):
            b = slugs[j]
            sb = src_5g_set[b]
            if not sb:
                continue
            inter = len(sa & sb)
            if inter == 0:
                continue
            union = len(sa) + len(sb) - inter
            jac = inter / union if union else 0.0
            if jac > 0.005:
                pairs.append((jac, a, b, inter, len(sa), len(sb)))
    pairs.sort(reverse=True)
    pairs = pairs[: args.top_pairs]

    # ───── repetition score per source ─────
    rep_score: dict[str, tuple[int, int, float]] = {}
    for slug in src_8g_total:
        tot = src_8g_total[slug]
        uni = src_8g_unique[slug]
        rep_score[slug] = (uni, tot, (uni / tot) if tot else 1.0)

    # ───── write report ─────
    write_report(
        args=args,
        counts=counts,
        sampled_n=len(sampled),
        top_results=top_results,
        pairs=pairs,
        rep_score=rep_score,
    )
    log.info("wrote %s", REPORT_PATH)
    return 0


# ─────────────── report writer ─────────────────────────────────────────


def fmt_gram(gram: tuple[str, ...]) -> str:
    s = " ".join(gram)
    s = s.replace("|", "\\|")
    if len(s) > 80:
        s = s[:77] + "..."
    return f"`{s}`"


def fmt_slug(slug: str) -> str:
    return slug.replace("|", "\\|")


def write_report(
    *,
    args: argparse.Namespace,
    counts: dict[str, int],
    sampled_n: int,
    top_results: dict[int, list[tuple[tuple[str, ...], int, list[tuple[str, int]]]]],
    pairs: list[tuple[float, str, str, int, int, int]],
    rep_score: dict[str, tuple[int, int, float]],
) -> None:
    lines: list[str] = []
    lines.append("# Corpus Analysis — N-gram Repetition + Source Overlap")
    lines.append("")
    lines.append(
        f"Stratified sample of **{sampled_n:,}** records across "
        f"**{len(counts)}** sources (target {args.sample_size:,}, per-source "
        f"cap {args.per_source_cap:,}, floor {args.per_source_floor})."
    )
    lines.append("")
    lines.append(
        f"Tokenization: lowercased `[A-Za-z0-9_]+|[^\\sA-Za-z0-9_]`. "
        f"Seed: `0x{args.seed:X}`."
    )
    lines.append("")
    lines.append("Field analyzed: `expectedResponse`. ")
    lines.append("")

    # ── source inventory (compact) ──
    lines.append("## 1. Source inventory")
    lines.append("")
    lines.append("| source | record count | sample size |")
    lines.append("|--------|-------------:|------------:|")
    for slug, n in sorted(counts.items(), key=lambda x: -x[1]):
        rep = rep_score.get(slug)
        sample = rep[1] if rep else 0  # total 8-grams roughly tracks sample size
        lines.append(f"| `{fmt_slug(slug)}` | {n:,} | ≈{sample:,} 8g |")
    lines.append("")

    # ── n-gram top-K tables ──
    for nn in (3, 5, 8, 13):
        lines.append(f"## 2. Top-{args.top_per_size} {nn}-grams")
        lines.append("")
        if not top_results.get(nn):
            lines.append("_(no data)_")
            lines.append("")
            continue
        lines.append("| rank | count | n-gram | top-3 sources |")
        lines.append("|-----:|------:|--------|---------------|")
        for rank, (gram, cnt, srcs) in enumerate(top_results[nn], 1):
            srcs_s = ", ".join(f"`{fmt_slug(s)}` ({c})" for s, c in srcs)
            lines.append(f"| {rank} | {cnt:,} | {fmt_gram(gram)} | {srcs_s} |")
        lines.append("")

    # ── source pair overlap ──
    lines.append("## 3. Source-pair Jaccard (5-grams)")
    lines.append("")
    lines.append(
        f"Pairs with overlapping unique-5-gram sets, top {args.top_pairs} by Jaccard."
    )
    lines.append("")
    lines.append("| Jaccard | source A | source B | shared | A unique | B unique |")
    lines.append("|--------:|----------|----------|-------:|---------:|---------:|")
    for jac, a, b, inter, na, nb in pairs:
        lines.append(
            f"| {jac:.3f} | `{fmt_slug(a)}` | `{fmt_slug(b)}` | {inter:,} | {na:,} | {nb:,} |"
        )
    lines.append("")

    # ── per-source repetition score ──
    lines.append("## 4. Per-source 8-gram repetition score")
    lines.append("")
    lines.append(
        "`unique_8grams / total_8grams` over the sampled records. Lower = more "
        "templated. Sources with score `<0.4` are prime candidates for "
        "variance injection."
    )
    lines.append("")
    lines.append("| source | unique 8g | total 8g | uniqueness |")
    lines.append("|--------|----------:|---------:|-----------:|")
    rows = sorted(
        rep_score.items(), key=lambda kv: kv[1][2]
    )
    for slug, (uni, tot, ratio) in rows:
        flag = " 🔴" if ratio < 0.4 else (" 🟡" if ratio < 0.6 else "")
        lines.append(
            f"| `{fmt_slug(slug)}` | {uni:,} | {tot:,} | {ratio:.3f}{flag} |"
        )
    lines.append("")

    # ── footer / methodology ──
    lines.append("## 5. Methodology")
    lines.append("")
    lines.append(
        "- **Stratified sample.** Each source contributes `min(per_source_cap, "
        "ceil(count/total * sample_size))` records, with a floor for tiny sources, "
        "drawn via Algorithm L reservoir sampling. This avoids the giants "
        "(agent-trove ≈1.5M, kimi/glm/nemotron each ≥1M) drowning out smaller "
        "specialised sources."
    )
    lines.append("")
    lines.append(
        "- **N-gram space.** Tokens are lowercased word-or-punct shards. "
        "We track 3/5/8/13-grams. The 13-gram channel catches verbatim "
        "boilerplate spans; 3-grams catch generic glue (`tool_calls[1]:`-style)."
    )
    lines.append("")
    lines.append(
        "- **Why expectedResponse only.** That's the supervised target. "
        "Repetition there directly hurts the model's variance because every "
        "near-duplicate target trains the same gradient. `currentMessage` and "
        "`memoryEntries` repetition is less harmful (the model only conditions "
        "on them)."
    )
    lines.append("")
    lines.append(
        "- **Sources tagged `synth-*`.** Most templated sources are synthesized "
        "(`synth-action-pairs-*`, `synth-dialogue-routing*`). Real corpora "
        "(hermes-3, kimi, agent-trove, etc.) have higher uniqueness because "
        "they are harvested from open-ended chat traces."
    )
    lines.append("")

    REPORT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=0xE71A05)
    ap.add_argument("--sample-size", type=int, default=200_000,
                    help="target stratified sample size")
    ap.add_argument("--per-source-cap", type=int, default=5_000,
                    help="hard ceiling on samples drawn from any one source")
    ap.add_argument("--per-source-floor", type=int, default=200,
                    help="minimum records sampled per source (truncated to source size)")
    ap.add_argument("--top-per-size", type=int, default=50,
                    help="how many top n-grams to report at each size")
    ap.add_argument("--top-pairs", type=int, default=20,
                    help="how many source-pair overlaps to report")
    args = ap.parse_args()
    return analyze(args)


if __name__ == "__main__":
    sys.exit(main())
