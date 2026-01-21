#!/usr/bin/env python3
"""
Rebuild the match matrix from existing persona files.
This preserves manually edited persona data while updating the match matrix.
"""
from __future__ import annotations

import _bootstrap  # noqa: F401
import json
import os
from typing import Dict, List, Tuple

from matcher.matrix import build_matrix
from matcher.signals import DatingSignals, dating_from_persona, dating_ineligibility_reason
from matcher.scoring import score_dating


def load_personas(filepath: str) -> List[Dict[str, object]]:
    """Load personas from JSON file."""
    with open(filepath, 'r', encoding='utf-8') as f:
        return json.load(f)


def build_dating_matrix(personas: List[Dict[str, object]]) -> Dict[str, object]:
    """
    Build the match matrix for dating personas.
    
    - Filters out ineligible pairs (gender/age/attractiveness mismatches)
    - Scores eligible pairs
    - Returns matrix with top/worst matches
    """
    # Extract signals from personas
    signals: Dict[str, DatingSignals] = {}
    for p in personas:
        persona_id = p["id"]
        signals[persona_id] = dating_from_persona(p)
    
    persona_ids = [p["id"] for p in personas]

    # Track filtering stats
    filtered_count = 0
    scored_count = 0

    def _score(a_id: str, b_id: str) -> int:
        nonlocal filtered_count, scored_count
        a_sig = signals[a_id]
        b_sig = signals[b_id]
        reason = dating_ineligibility_reason(a_sig, b_sig)
        if reason:
            filtered_count += 1
            raise ValueError(reason)
        score, _ = score_dating(a_sig, b_sig)
        scored_count += 1
        return score

    matrix = build_matrix("dating", persona_ids, _score)

    print(f"  Scored pairs: {scored_count}")
    print(f"  Filtered pairs: {filtered_count}")

    return matrix


def generate_benchmarks(personas: List[Dict[str, object]], matrix: Dict[str, object]) -> Dict[str, object]:
    """Generate benchmark pairs from the matrix."""
    scores = matrix["scores"]
    
    good_pairs: List[Dict[str, object]] = []
    bad_pairs: List[Dict[str, object]] = []
    
    # Collect all scored pairs
    all_pairs: List[Tuple[str, str, int]] = []
    seen = set()
    for a_id, row in scores.items():
        for b_id, score in row.items():
            pair_key = tuple(sorted([a_id, b_id]))
            if pair_key not in seen:
                seen.add(pair_key)
                all_pairs.append((a_id, b_id, score))
    
    # Sort by score
    all_pairs.sort(key=lambda x: x[2], reverse=True)
    
    # Top 10% are good, bottom 10% are bad
    n = len(all_pairs)
    top_n = max(5, n // 10)
    bottom_n = max(5, n // 10)
    
    for a_id, b_id, score in all_pairs[:top_n]:
        good_pairs.append({
            "a": a_id,
            "b": b_id,
            "expectedScoreRange": [score - 10, 100],  # Should score at least close to actual
            "reason": f"High compatibility score: {score}"
        })
    
    for a_id, b_id, score in all_pairs[-bottom_n:]:
        bad_pairs.append({
            "a": a_id,
            "b": b_id,
            "expectedScoreRange": [-100, score + 10],  # Should score at most close to actual
            "reason": f"Low compatibility score: {score}"
        })
    
    return {
        "domain": "dating",
        "description": "Benchmark pairs for dating matching evaluation. Good pairs have high compatibility, bad pairs have low compatibility.",
        "goodPairs": good_pairs,
        "badPairs": bad_pairs,
    }


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    
    # Load existing personas
    print("Loading personas...")
    sf_personas = load_personas(os.path.join(root, "data/dating/personas_sf.json"))
    ny_personas = load_personas(os.path.join(root, "data/dating/personas_ny.json"))
    all_personas = sf_personas + ny_personas
    print(f"  Loaded {len(all_personas)} personas")
    
    # Build match matrix
    print("\nBuilding match matrix...")
    matrix = build_dating_matrix(all_personas)
    
    # Generate benchmarks
    print("\nGenerating benchmarks...")
    benchmarks = generate_benchmarks(all_personas, matrix)
    print(f"  Good pairs: {len(benchmarks['goodPairs'])}")
    print(f"  Bad pairs: {len(benchmarks['badPairs'])}")
    
    # Write outputs
    print("\nWriting outputs...")
    matrix_path = os.path.join(root, "data/dating/match_matrix.json")
    benchmarks_path = os.path.join(root, "data/dating/benchmarks.json")
    
    with open(matrix_path, 'w', encoding='utf-8') as f:
        json.dump(matrix, f, indent=2)
    print(f"  Wrote: {matrix_path}")
    
    with open(benchmarks_path, 'w', encoding='utf-8') as f:
        json.dump(benchmarks, f, indent=2)
    print(f"  Wrote: {benchmarks_path}")
    
    # Print some stats
    print("\n" + "="*60)
    print("MATCH MATRIX STATS")
    print("="*60)
    
    # Score distribution
    all_scores: List[int] = []
    for row in matrix["scores"].values():
        all_scores.extend(row.values())
    
    if all_scores:
        print(f"\nScore distribution:")
        print(f"  Min: {min(all_scores)}")
        print(f"  Max: {max(all_scores)}")
        print(f"  Mean: {sum(all_scores) / len(all_scores):.1f}")
        
        # Histogram buckets
        buckets = [0] * 11  # -100 to 100 in 20-point buckets
        for s in all_scores:
            bucket = min(10, max(0, (s + 100) // 20))
            buckets[bucket] += 1
        
        print(f"\n  Score histogram:")
        for i, count in enumerate(buckets):
            low = -100 + i * 20
            high = low + 19
            bar = '█' * (count // 5)
            print(f"    [{low:>4} to {high:>4}]: {count:>4} {bar}")
    
    print("\nDone!")


if __name__ == "__main__":
    main()
