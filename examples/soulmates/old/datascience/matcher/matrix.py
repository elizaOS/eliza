from __future__ import annotations

from typing import Callable, Dict, List

from matcher.types import Domain, MatchEntry, MatchMatrix


def top_k_matches(scores: Dict[str, Dict[str, int]], persona_id: str, k: int, reverse: bool) -> List[MatchEntry]:
    row = scores.get(persona_id)
    if not isinstance(row, dict):
        return []
    items = [{"otherId": other_id, "score": int(v)} for (other_id, v) in row.items() if other_id != persona_id and isinstance(v, int)]
    items.sort(key=lambda x: x["score"], reverse=reverse)
    return items[:k]


def build_matrix(domain: Domain, persona_ids: List[str], score_fn: Callable[[str, str], int]) -> MatchMatrix:
    # Build a symmetric matrix. Pairs may be omitted when filtered out by hard constraints.
    scores: Dict[str, Dict[str, int]] = {pid: {} for pid in persona_ids}
    for i in range(len(persona_ids)):
        a = persona_ids[i]
        for j in range(i + 1, len(persona_ids)):
            b = persona_ids[j]
            try:
                v = int(score_fn(a, b))
            except ValueError:
                continue
            scores[a][b] = v
            scores[b][a] = v

    top_matches: Dict[str, List[MatchEntry]] = {pid: top_k_matches(scores, pid, 5, True) for pid in persona_ids}
    worst_matches: Dict[str, List[MatchEntry]] = {pid: top_k_matches(scores, pid, 5, False) for pid in persona_ids}

    return {
        "domain": domain,
        "personaIds": persona_ids,
        "scores": scores,
        "topMatches": top_matches,
        "worstMatches": worst_matches,
    }
