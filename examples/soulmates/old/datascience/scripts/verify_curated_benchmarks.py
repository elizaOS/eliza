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


def _score(matrix: Dict[str, object], a: str, b: str) -> int:
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


def _check(domain: Domain, data_dir: Path) -> List[PairResult]:
    matrix = _load_json(data_dir / "match_matrix.json")
    curated = _load_json(data_dir / "benchmarks_curated.json")
    if not isinstance(matrix, dict) or not isinstance(curated, dict):
        raise ValueError("matrix/curated must be objects")
    if matrix.get("domain") != domain:
        raise ValueError(f"matrix domain mismatch for {domain}")
    if curated.get("domain") != domain:
        raise ValueError(f"curated domain mismatch for {domain}")

    results: List[PairResult] = []
    for bucket in ("goodPairs", "badPairs"):
        pairs = curated.get(bucket)
        if not isinstance(pairs, list):
            raise ValueError(f"{domain}: {bucket} must be list")
        for p in pairs:
            if not isinstance(p, dict):
                raise ValueError(f"{domain}: pair must be object")
            a = p["a"]
            b = p["b"]
            exp = p["expectedScoreRange"]
            reason = str(p.get("reason", ""))
            if (
                not isinstance(a, str)
                or not isinstance(b, str)
                or not isinstance(exp, list)
                or len(exp) != 2
                or not isinstance(exp[0], int)
                or not isinstance(exp[1], int)
            ):
                raise ValueError(f"{domain}: invalid pair shape")
            lo, hi = exp[0], exp[1]
            try:
                s = _score(matrix, a, b)
            except ValueError as e:
                results.append(PairResult(ok=False, domain=domain, a=a, b=b, score=0, expected=(lo, hi), reason=f"{reason} | {e}"))
                continue
            results.append(PairResult(ok=(lo <= s <= hi), domain=domain, a=a, b=b, score=s, expected=(lo, hi), reason=reason))
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
        all_results.extend(_check(domain, d))

    bad = [r for r in all_results if not r.ok]
    if not bad:
        print("OK: curated benchmark pairs within expected ranges")
        return

    print("FAILED: curated benchmark pairs outside expected ranges:")
    for r in bad:
        print(f"- [{r.domain}] {r.a} vs {r.b}: score={r.score}, expected={r.expected} | {r.reason}")
    raise SystemExit(1)


if __name__ == "__main__":
    main()

