#!/usr/bin/env python3
"""
Analyze which bad pairs the LLM is recommending and what signals it's missing.
"""
from __future__ import annotations

import _bootstrap  # noqa: F401
from pathlib import Path
from typing import Dict, List, Set, Tuple

from matcher.io import load_json


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    d = root / "data" / "dating"

    # Load data
    sf = load_json(d / "personas_sf.json")
    ny = load_json(d / "personas_ny.json")
    personas = sf + ny
    by_id: Dict[str, Dict[str, object]] = {p["id"]: p for p in personas if isinstance(p, dict)}

    matrix = load_json(d / "match_matrix.json")
    curated = load_json(d / "benchmarks_curated.json")
    llm_rankings = load_json(d / "llm_rankings.json")

    # Get bad pairs as set
    bad_pairs: Set[frozenset[str]] = {frozenset({p["a"], p["b"]}) for p in curated["badPairs"]}
    bad_pair_reasons: Dict[frozenset[str], str] = {frozenset({p["a"], p["b"]}): p["reason"] for p in curated["badPairs"]}

    # Get baseline top 10 for each persona
    baseline_top: Dict[str, List[str]] = {}
    for pid, matches in matrix.get("topMatches", {}).items():
        baseline_top[pid] = [m["otherId"] for m in matches[:10] if isinstance(m, dict)]

    # Get LLM top 10 for each persona
    llm_top: Dict[str, List[str]] = {}
    for pid, data in llm_rankings.get("rankings", {}).items():
        matches = data.get("topMatches", [])
        llm_top[pid] = [m["id"] for m in matches[:10] if isinstance(m, dict)]

    # Find bad pairs in LLM recommendations
    llm_bad_pairs: List[Tuple[str, str, str, int]] = []  # (a, b, reason, llm_rank)
    for pid, matches in llm_top.items():
        for rank, mid in enumerate(matches, 1):
            pair = frozenset({pid, mid})
            if pair in bad_pairs:
                # Check if also in baseline
                in_baseline = mid in baseline_top.get(pid, []) or pid in baseline_top.get(mid, [])
                if not in_baseline:
                    llm_bad_pairs.append((pid, mid, bad_pair_reasons.get(pair, "?"), rank))

    print("=" * 80)
    print("BAD PAIRS IN LLM TOP 10 (but NOT in baseline top 10)")
    print("=" * 80)
    print(f"Total: {len(llm_bad_pairs)}")
    print()

    def get_signals(pid: str) -> Dict[str, object]:
        p = by_id.get(pid, {})
        opt = p.get("optional", {})
        dp = opt.get("datingPreferences", {})
        return {
            "goal": opt.get("relationshipGoal"),
            "communication": opt.get("communicationStyle"),
            "monogamy": dp.get("monogamy"),
            "wantsKids": dp.get("wantsKids"),
            "dealbreakers": opt.get("dealbreakers", []),
            "values": opt.get("values", []),
            "interests": opt.get("interests", []),
            "lifestyle": opt.get("lifestyle", {}),
        }

    # Analyze each bad pair
    signal_misses: Dict[str, int] = {
        "goal_mismatch": 0,
        "communication_mismatch": 0,
        "monogamy_conflict": 0,
        "kids_conflict": 0,
        "dealbreaker_triggered": 0,
        "values_clash": 0,
        "lifestyle_clash": 0,
    }

    for a, b, reason, rank in llm_bad_pairs:
        sa = get_signals(a)
        sb = get_signals(b)
        
        print("-" * 80)
        print(f"{a} ↔ {b} (LLM rank: {rank})")
        print(f"AI labeler reason: {reason}")
        print()
        
        pa = by_id.get(a, {})
        pb = by_id.get(b, {})
        ra = pa.get("required", {})
        rb = pb.get("required", {})
        
        print(f"  {a}: {ra.get('name')}, {ra.get('age')}")
        print(f"    Goal: {sa['goal']}, Comm: {sa['communication']}")
        print(f"    Monogamy: {sa['monogamy']}, Kids: {sa['wantsKids']}")
        print(f"    Dealbreakers: {sa['dealbreakers']}")
        print(f"    Values: {sa['values']}")
        print()
        print(f"  {b}: {rb.get('name')}, {rb.get('age')}")
        print(f"    Goal: {sb['goal']}, Comm: {sb['communication']}")
        print(f"    Monogamy: {sb['monogamy']}, Kids: {sb['wantsKids']}")
        print(f"    Dealbreakers: {sb['dealbreakers']}")
        print(f"    Values: {sb['values']}")
        print()

        # Detect specific mismatches
        issues = []
        
        # Goal mismatch
        if sa["goal"] != sb["goal"]:
            issues.append(f"GOAL: {sa['goal']} vs {sb['goal']}")
            signal_misses["goal_mismatch"] += 1
        
        # Communication mismatch
        comm_clash = {
            ("low_texting", "high_texting"),
            ("high_texting", "low_texting"),
        }
        ca = sa["communication"].replace(" ", "_").lower() if sa["communication"] else ""
        cb = sb["communication"].replace(" ", "_").lower() if sb["communication"] else ""
        if (ca, cb) in comm_clash or (cb, ca) in comm_clash:
            issues.append(f"COMM: {sa['communication']} vs {sb['communication']}")
            signal_misses["communication_mismatch"] += 1
        
        # Monogamy conflict
        mono_conflict = {("yes", "no"), ("no", "yes")}
        if (sa["monogamy"], sb["monogamy"]) in mono_conflict:
            issues.append(f"MONOGAMY: {sa['monogamy']} vs {sb['monogamy']}")
            signal_misses["monogamy_conflict"] += 1
        
        # Kids conflict
        kids_conflict = {("yes", "no"), ("no", "yes")}
        if (sa["wantsKids"], sb["wantsKids"]) in kids_conflict:
            issues.append(f"KIDS: {sa['wantsKids']} vs {sb['wantsKids']}")
            signal_misses["kids_conflict"] += 1
        
        # Dealbreaker triggered
        for db in sa["dealbreakers"]:
            db_low = db.lower()
            # Check if b's profile triggers this dealbreaker
            if db_low == "smoking" and sb.get("lifestyle", {}).get("smoking") == "yes":
                issues.append(f"DEALBREAKER: {a} has '{db}', {b} smokes")
                signal_misses["dealbreaker_triggered"] += 1
        for db in sb["dealbreakers"]:
            db_low = db.lower()
            if db_low == "smoking" and sa.get("lifestyle", {}).get("smoking") == "yes":
                issues.append(f"DEALBREAKER: {b} has '{db}', {a} smokes")
                signal_misses["dealbreaker_triggered"] += 1

        if issues:
            print(f"  DETECTED ISSUES:")
            for issue in issues:
                print(f"    ⚠️  {issue}")
        else:
            print(f"  (No obvious hard signal mismatch detected - may be softer incompatibility)")
        print()

    print("=" * 80)
    print("SIGNAL MISS SUMMARY")
    print("=" * 80)
    for signal, count in sorted(signal_misses.items(), key=lambda x: -x[1]):
        if count > 0:
            print(f"  {signal}: {count}")

    # Also look at the LLM's reasoning for these bad pairs
    print()
    print("=" * 80)
    print("LLM REASONING FOR BAD PAIRS")
    print("=" * 80)
    for a, b, _, rank in llm_bad_pairs[:10]:  # First 10
        # Find the LLM's reason for recommending this pair
        for pid in [a, b]:
            rankings = llm_rankings.get("rankings", {}).get(pid, {}).get("topMatches", [])
            other = b if pid == a else a
            for m in rankings:
                if m.get("id") == other:
                    print(f"{pid} → {other}: \"{m.get('reason', '?')}\"")
                    break


if __name__ == "__main__":
    main()
