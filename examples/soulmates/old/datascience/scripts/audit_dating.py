#!/usr/bin/env python3
from __future__ import annotations

import _bootstrap  # noqa: F401
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

from matcher.io import load_json

@dataclass(frozen=True)
class AuditSummary:
    personas: int
    eligible_pairs: int
    avg_candidates_per_persona: float
    min_candidates_per_persona: int
    max_candidates_per_persona: int
    score_min: int
    score_max: int
    score_mean: float
    score_median: float


def _flatten_scores(scores: Dict[str, Dict[str, int]]) -> List[int]:
    vals: List[int] = []
    seen: set[Tuple[str, str]] = set()
    for a, row in scores.items():
        for b, v in row.items():
            if a == b:
                continue
            key = (a, b) if a < b else (b, a)
            if key in seen:
                continue
            seen.add(key)
            vals.append(int(v))
    return vals


def audit(root: Path) -> None:
    d = root / "data" / "dating"
    sf = load_json(d / "personas_sf.json")
    ny = load_json(d / "personas_ny.json")
    personas = sf + ny
    by_id: Dict[str, dict] = {p["id"]: p for p in personas if isinstance(p, dict) and isinstance(p.get("id"), str)}

    matrix = load_json(d / "match_matrix.json")
    ids: List[str] = matrix["personaIds"]
    scores: Dict[str, Dict[str, int]] = matrix["scores"]

    # Candidate counts (eligible scored pairs only)
    counts: List[int] = []
    for pid in ids:
        row = scores.get(pid, {})
        if isinstance(row, dict):
            counts.append(len(row))
        else:
            counts.append(0)

    all_scores = _flatten_scores(scores)
    summary = AuditSummary(
        personas=len(ids),
        eligible_pairs=len(all_scores),
        avg_candidates_per_persona=(sum(counts) / len(counts)) if counts else 0.0,
        min_candidates_per_persona=min(counts) if counts else 0,
        max_candidates_per_persona=max(counts) if counts else 0,
        score_min=min(all_scores) if all_scores else 0,
        score_max=max(all_scores) if all_scores else 0,
        score_mean=statistics.mean(all_scores) if all_scores else 0.0,
        score_median=statistics.median(all_scores) if all_scores else 0.0,
    )

    print("=== Dating matrix audit ===")
    print(f"Personas: {summary.personas}")
    print(f"Eligible (scored) unique pairs: {summary.eligible_pairs}")
    print(f"Candidates per persona: avg={summary.avg_candidates_per_persona:.2f}, min={summary.min_candidates_per_persona}, max={summary.max_candidates_per_persona}")
    print(f"Score distribution: min={summary.score_min}, max={summary.score_max}, mean={summary.score_mean:.2f}, median={summary.score_median:.2f}")

    # Benchmark checks (exist + eligible)
    def check_bench(path: Path) -> None:
        bench = load_json(path)
        bad: List[str] = []
        for bucket in ("goodPairs", "badPairs"):
            for p in bench.get(bucket, []):
                a = p["a"]
                b = p["b"]
                if a not in by_id or b not in by_id:
                    bad.append(f"{bucket}: unknown ids {a},{b}")
                    continue
                row = scores.get(a, {})
                if not isinstance(row, dict) or b not in row:
                    bad.append(f"{bucket}: ineligible/missing score for {a} vs {b}")
                    continue
                s = int(row[b])
                lo, hi = p["expectedScoreRange"]
                if not (int(lo) <= s <= int(hi)):
                    bad.append(f"{bucket}: {a} vs {b} score {s} not in [{lo},{hi}]")
        print(f"\nBenchmarks: {path.name}")
        if bad:
            print("FAILED:")
            for x in bad:
                print(f"- {x}")
        else:
            print("OK")

    check_bench(d / "benchmarks.json")
    check_bench(d / "benchmarks_curated.json")


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    audit(root)


if __name__ == "__main__":
    main()

