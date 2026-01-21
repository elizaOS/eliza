#!/usr/bin/env python3
"""
Evaluate dating recommendations against curated benchmarks.

Reports:
  - Good pair recall: % of curated good pairs that appear in the recommender's top 10
  - Bad pair avoidance: % of curated bad pairs that were kept OUT of top 10
  - Breakdown of all recommendations into verified-good / verified-bad / unverified
"""
from __future__ import annotations

import _bootstrap  # noqa: F401
import argparse
from pathlib import Path
from typing import Dict, FrozenSet, List, Set, Tuple

from matcher.io import load_json


def _baseline_top10(matrix: Dict[str, object], pid: str) -> List[str]:
    top = matrix.get("topMatches")
    if not isinstance(top, dict):
        return []
    items = top.get(pid)
    if not isinstance(items, list):
        return []
    out: List[str] = []
    for it in items[:10]:
        if isinstance(it, dict) and isinstance(it.get("otherId"), str):
            out.append(it["otherId"])
    return out


def _llm_top10(llm: Dict[str, object], pid: str) -> List[str]:
    rankings = llm.get("rankings")
    if not isinstance(rankings, dict):
        return []
    r = rankings.get(pid)
    if not isinstance(r, dict):
        return []
    for key in ("topMatches", "ranked", "top10"):
        v = r.get(key)
        if isinstance(v, list):
            out: List[str] = []
            for it in v:
                if isinstance(it, dict) and isinstance(it.get("id"), str):
                    out.append(it["id"])
                elif isinstance(it, str):
                    out.append(it)
            return out[:10]
    return []


def _pair_set(pairs: List[Tuple[str, str]]) -> FrozenSet[FrozenSet[str]]:
    """Convert list of (a,b) pairs to a set of frozensets for bidirectional lookup."""
    return frozenset(frozenset({a, b}) for a, b in pairs)


def _count_pair_hits(top10: Dict[str, List[str]], pair_set: FrozenSet[FrozenSet[str]]) -> int:
    """Count how many pairs from pair_set appear in any persona's top 10."""
    found: Set[FrozenSet[str]] = set()
    for pid, matches in top10.items():
        for mid in matches:
            pair = frozenset({pid, mid})
            if pair in pair_set:
                found.add(pair)
    return len(found)


def _recommendation_breakdown(
    top10: Dict[str, List[str]],
    good_set: FrozenSet[FrozenSet[str]],
    bad_set: FrozenSet[FrozenSet[str]],
) -> Tuple[int, int, int, int]:
    """
    Return (total_recs, verified_good, verified_bad, unverified).
    Each (pid, match) pair is counted once even if reciprocal exists.
    """
    all_recs: Set[FrozenSet[str]] = set()
    for pid, matches in top10.items():
        for mid in matches:
            all_recs.add(frozenset({pid, mid}))

    verified_good = len(all_recs & good_set)
    verified_bad = len(all_recs & bad_set)
    unverified = len(all_recs) - verified_good - verified_bad
    return len(all_recs), verified_good, verified_bad, unverified


def evaluate(root: Path, llm_path: Path) -> None:
    d = root / "data" / "dating"
    matrix = load_json(d / "match_matrix.json")
    curated = load_json(d / "benchmarks_curated.json")
    llm = load_json(llm_path)

    good_pairs: List[Tuple[str, str]] = [(p["a"], p["b"]) for p in curated["goodPairs"]]
    bad_pairs: List[Tuple[str, str]] = [(p["a"], p["b"]) for p in curated["badPairs"]]
    good_set = _pair_set(good_pairs)
    bad_set = _pair_set(bad_pairs)

    ids: List[str] = list(matrix["personaIds"])
    baseline_top = {pid: _baseline_top10(matrix, pid) for pid in ids}
    llm_top = {pid: _llm_top10(llm, pid) for pid in ids}

    print("=" * 60)
    print("EVALUATION vs CURATED BENCHMARKS (dating)")
    print("=" * 60)
    print()

    # --- Curated pair coverage ---
    print(f"Curated good pairs: {len(good_pairs)}")
    print(f"Curated bad pairs:  {len(bad_pairs)}")
    print()

    # --- Baseline ---
    base_good_hits = _count_pair_hits(baseline_top, good_set)
    base_bad_hits = _count_pair_hits(baseline_top, bad_set)
    base_good_recall = base_good_hits / len(good_pairs) * 100 if good_pairs else 0
    base_bad_avoidance = (len(bad_pairs) - base_bad_hits) / len(bad_pairs) * 100 if bad_pairs else 100

    print("BASELINE (heuristic score)")
    print(f"  Good pair recall:    {base_good_recall:5.1f}% ({base_good_hits}/{len(good_pairs)} curated good pairs in top 10)")
    print(f"  Bad pair avoidance:  {base_bad_avoidance:5.1f}% ({len(bad_pairs) - base_bad_hits}/{len(bad_pairs)} curated bad pairs kept out of top 10)")

    base_total, base_vg, base_vb, base_un = _recommendation_breakdown(baseline_top, good_set, bad_set)
    print(f"  Recommendations:     {base_total} unique pairs")
    print(f"    - Verified good:   {base_vg:3d} ({base_vg / base_total * 100:5.1f}%)")
    print(f"    - Verified bad:    {base_vb:3d} ({base_vb / base_total * 100:5.1f}%)")
    print(f"    - Unverified:      {base_un:3d} ({base_un / base_total * 100:5.1f}%)")
    print()

    # --- LLM ---
    llm_good_hits = _count_pair_hits(llm_top, good_set)
    llm_bad_hits = _count_pair_hits(llm_top, bad_set)
    llm_good_recall = llm_good_hits / len(good_pairs) * 100 if good_pairs else 0
    llm_bad_avoidance = (len(bad_pairs) - llm_bad_hits) / len(bad_pairs) * 100 if bad_pairs else 100

    print("LLM RERANKED (openai/gpt-oss-120b)")
    print(f"  Good pair recall:    {llm_good_recall:5.1f}% ({llm_good_hits}/{len(good_pairs)} curated good pairs in top 10)")
    print(f"  Bad pair avoidance:  {llm_bad_avoidance:5.1f}% ({len(bad_pairs) - llm_bad_hits}/{len(bad_pairs)} curated bad pairs kept out of top 10)")

    llm_total, llm_vg, llm_vb, llm_un = _recommendation_breakdown(llm_top, good_set, bad_set)
    print(f"  Recommendations:     {llm_total} unique pairs")
    print(f"    - Verified good:   {llm_vg:3d} ({llm_vg / llm_total * 100:5.1f}%)")
    print(f"    - Verified bad:    {llm_vb:3d} ({llm_vb / llm_total * 100:5.1f}%)")
    print(f"    - Unverified:      {llm_un:3d} ({llm_un / llm_total * 100:5.1f}%)")
    print()

    # --- Detail: which curated pairs were hit/missed ---
    print("-" * 60)
    print("DETAIL: Curated good pairs")
    for a, b in good_pairs:
        in_base = b in baseline_top.get(a, []) or a in baseline_top.get(b, [])
        in_llm = b in llm_top.get(a, []) or a in llm_top.get(b, [])
        base_mark = "✓" if in_base else "✗"
        llm_mark = "✓" if in_llm else "✗"
        print(f"  {a} ↔ {b}: baseline={base_mark}  llm={llm_mark}")

    print()
    print("DETAIL: Curated bad pairs")
    for a, b in bad_pairs:
        in_base = b in baseline_top.get(a, []) or a in baseline_top.get(b, [])
        in_llm = b in llm_top.get(a, []) or a in llm_top.get(b, [])
        base_mark = "✗ (bad)" if in_base else "✓ (avoided)"
        llm_mark = "✗ (bad)" if in_llm else "✓ (avoided)"
        print(f"  {a} ↔ {b}: baseline={base_mark}  llm={llm_mark}")

    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Baseline: {base_good_recall:.0f}% good recall, {base_bad_avoidance:.0f}% bad avoidance")
    print(f"LLM:      {llm_good_recall:.0f}% good recall, {llm_bad_avoidance:.0f}% bad avoidance")


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Evaluate baseline vs LLM reranking against curated dating benchmarks.")
    p.add_argument("--llm", required=True, help="Path to llm_rankings.json produced by llm_rerank_dating.py")
    return p.parse_args()


def main() -> None:
    args = _parse_args()
    root = Path(__file__).resolve().parents[1]
    evaluate(root, root / args.llm)


if __name__ == "__main__":
    main()
