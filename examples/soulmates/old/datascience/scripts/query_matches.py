#!/usr/bin/env python3
from __future__ import annotations

import _bootstrap  # noqa: F401
import argparse
from pathlib import Path
from typing import List

from matcher.query import basic_card, persona_summary, query_matches
from matcher.types import Domain


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Query top/worst matches for a persona with lightweight explanations.")
    p.add_argument("--domain", required=True, choices=["dating", "business", "friendship"])
    p.add_argument("--persona", required=True, help="Persona id, e.g. D-SF-001")
    p.add_argument("--top", type=int, default=3, help="Show top N matches (default: 3)")
    p.add_argument("--worst", type=int, default=3, help="Show worst N matches (default: 3)")
    p.add_argument(
        "--same-city",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Filter matches to the same city as the queried persona (default: true). Use --no-same-city to disable.",
    )
    p.add_argument("--city", choices=["San Francisco", "New York"], default=None, help="Force filter to a specific city.")
    p.add_argument("--explain", action="store_true", help="Include a deterministic score breakdown based on optional.scoringSignals")
    return p.parse_args()


def main() -> None:
    args = _parse_args()
    domain: Domain = args.domain
    persona_id = str(args.persona)
    top_n = int(args.top)
    worst_n = int(args.worst)
    if top_n < 0 or worst_n < 0:
        raise SystemExit("--top/--worst must be >= 0")

    root = Path(__file__).resolve().parents[1]
    result = query_matches(
        root=root,
        domain=domain,
        persona_id=persona_id,
        top_n=top_n,
        worst_n=worst_n,
        same_city=args.same_city,
        city=args.city,
        explain=args.explain,
    )

    persona = result["persona"]
    personas = result["personas"]
    print(f"{persona_id}: {basic_card(persona)}")
    for line in persona_summary(persona):
        print(f"- {line}")
    city_filter = result.get("city_filter")
    if isinstance(city_filter, str) and city_filter:
        print(f"- City filter: {city_filter}")
    else:
        print("- City filter: none")
    if domain == "dating":
        print(f"- Eligible candidates scored: {result['candidate_count']} (filtered out by hard constraints: {result['filtered_count']})")
    else:
        print(f"- Candidates scored: {result['candidate_count']}")

    details = result["details"]
    top_items = result["top"]
    worst_items = result["worst"]

    def show(label: str, ms: List[object]) -> None:
        print(f"\n{label}")
        for m in ms:
            if not hasattr(m, "other_id"):
                continue
            other_id = m.other_id
            score = m.score
            other = personas.get(other_id, {})
            if isinstance(other, dict):
                card = basic_card(other)
            else:
                card = "unknown"
            print(f"- {other_id}: {score} | {card}")
            if args.explain:
                expl = details.get(other_id, [])
                for line in expl[:6]:
                    print(f"  - {line}")

    if top_n > 0:
        show(f"Top {top_n}", top_items)
    if worst_n > 0:
        show(f"Worst {worst_n}", worst_items)


if __name__ == "__main__":
    main()

