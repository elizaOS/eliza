#!/usr/bin/env python3
from __future__ import annotations

import _bootstrap  # noqa: F401
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

from matcher.types import Domain


@dataclass(frozen=True)
class PairResult:
    ok: bool
    domain: Domain
    a: str
    b: str
    score: int
    expected: Tuple[int, int]
    reason: str


def _load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _score_lookup(matrix: Dict[str, object], a: str, b: str) -> int:
    scores = matrix["scores"]
    if not isinstance(scores, dict):
        raise ValueError("scores must be object")
    row = scores[a]
    if not isinstance(row, dict):
        raise ValueError("scores row must be object")
    if b not in row:
        raise ValueError("pair is filtered out / ineligible (no score)")
    v = row[b]
    if not isinstance(v, int):
        raise ValueError("score must be int")
    return v


def _check_pairs(domain: Domain, data_dir: Path) -> List[PairResult]:
    matrix = _load_json(data_dir / "match_matrix.json")
    bench = _load_json(data_dir / "benchmarks.json")

    if not isinstance(matrix, dict) or not isinstance(bench, dict):
        raise ValueError("matrix/bench must be objects")
    if bench.get("domain") != domain:
        raise ValueError(f"bench domain mismatch for {domain}")
    if matrix.get("domain") != domain:
        raise ValueError(f"matrix domain mismatch for {domain}")

    results: List[PairResult] = []
    for bucket_key in ("goodPairs", "badPairs"):
        pairs = bench.get(bucket_key)
        if not isinstance(pairs, list):
            raise ValueError(f"{domain}: {bucket_key} must be list")
        for p in pairs:
            if not isinstance(p, dict):
                raise ValueError(f"{domain}: pair must be object")
            a = p["a"]
            b = p["b"]
            exp = p["expectedScoreRange"]
            reason = p.get("reason", "")
            if not isinstance(a, str) or not isinstance(b, str):
                raise ValueError(f"{domain}: a/b must be strings")
            if (
                not isinstance(exp, list)
                or len(exp) != 2
                or not isinstance(exp[0], int)
                or not isinstance(exp[1], int)
            ):
                raise ValueError(f"{domain}: expectedScoreRange must be [int,int]")
            lo, hi = exp[0], exp[1]
            score = _score_lookup(matrix, a, b)
            ok = lo <= score <= hi
            results.append(PairResult(ok=ok, domain=domain, a=a, b=b, score=score, expected=(lo, hi), reason=str(reason)))
    return results


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    plan: List[Tuple[Domain, Path]] = [
        ("dating", root / "data" / "dating"),
        ("business", root / "data" / "cofounders"),
        ("friendship", root / "data" / "friendship"),
    ]

    all_results: List[PairResult] = []
    for domain, d in plan:
        all_results.extend(_check_pairs(domain, d))

    bad = [r for r in all_results if not r.ok]
    if not bad:
        print("OK: all benchmark pairs within expected ranges")
        return

    print("FAILED: benchmark pairs outside expected ranges:")
    for r in bad:
        print(f"- [{r.domain}] {r.a} vs {r.b}: score={r.score}, expected={r.expected} | {r.reason}")
    raise SystemExit(1)


if __name__ == "__main__":
    main()

