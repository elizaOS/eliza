from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Set, Tuple

from matcher.embeddings import get_embedding, load_embedding_cache, save_embedding_cache
from matcher.llm_rerank import facts_summary, persona_card


def _embedding_text(persona: Dict[str, object]) -> str:
    profile = persona_card(persona)
    facts = facts_summary(persona)
    return json.dumps({"profile": profile, "facts": facts}, ensure_ascii=False)


def _cosine_similarity(a: List[float], b: List[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / ((na ** 0.5) * (nb ** 0.5))


def _heuristic_neighbors(scores: Dict[str, Dict[str, int]], persona_id: str, k: int) -> List[str]:
    row = scores.get(persona_id, {})
    if not isinstance(row, dict):
        return []
    pairs = [(other_id, v) for other_id, v in row.items() if isinstance(other_id, str) and isinstance(v, int)]
    pairs.sort(key=lambda x: x[1], reverse=True)
    return [pid for pid, _ in pairs[: max(0, int(k))]]


def _embedding_neighbors(
    persona_id: str,
    embeddings: Dict[str, List[float]],
    candidates: List[str],
    k: int,
) -> List[str]:
    if persona_id not in embeddings or k <= 0:
        return []
    base = embeddings[persona_id]
    scored: List[Tuple[str, float]] = []
    for other_id in candidates:
        if other_id == persona_id:
            continue
        vec = embeddings.get(other_id)
        if not isinstance(vec, list):
            continue
        scored.append((other_id, _cosine_similarity(base, vec)))
    scored.sort(key=lambda x: x[1], reverse=True)
    return [pid for pid, _ in scored[:k]]


def build_hybrid_candidate_ids(
    persona_id: str,
    by_id: Dict[str, Dict[str, object]],
    scores: Dict[str, Dict[str, int]],
    heuristic_k: int,
    embed_k: int,
    expand_hops: int,
    max_candidates: int,
    embedding_model: str,
    embedding_cache_path: Path,
    use_embeddings: bool,
) -> List[str]:
    row = scores.get(persona_id, {})
    if not isinstance(row, dict):
        return []
    eligible_ids = [pid for pid in row.keys() if isinstance(pid, str)]

    seed: Set[str] = set(_heuristic_neighbors(scores, persona_id, heuristic_k))

    embeddings: Dict[str, List[float]] = {}
    if use_embeddings and embed_k > 0:
        embeddings = load_embedding_cache(embedding_cache_path)
        missing = [pid for pid in eligible_ids + [persona_id] if pid not in embeddings and pid in by_id]
        if missing:
            for pid in missing:
                text = _embedding_text(by_id[pid])
                embeddings[pid] = get_embedding(text, embedding_model)
            save_embedding_cache(embedding_cache_path, embeddings)
        seed.update(_embedding_neighbors(persona_id, embeddings, eligible_ids, embed_k))

    frontier = set(seed)
    candidates = set(seed)
    for _ in range(max(0, int(expand_hops))):
        next_frontier: Set[str] = set()
        for node in frontier:
            for neighbor in _heuristic_neighbors(scores, node, heuristic_k):
                if neighbor not in candidates:
                    next_frontier.add(neighbor)
                    candidates.add(neighbor)
        frontier = next_frontier

    # Keep only eligible ids (matrix already filtered).
    candidates = {pid for pid in candidates if pid in row}

    # Sort by heuristic score from the target persona row.
    ordered = sorted(candidates, key=lambda pid: row.get(pid, -9999), reverse=True)
    limit = max(1, int(max_candidates))
    return ordered[:limit]
