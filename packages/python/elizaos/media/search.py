"""
Hybrid search utilities for combining vector and keyword search results.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class HybridVectorResult:
    """Result from vector similarity search."""

    id: str
    path: str
    start_line: int
    end_line: int
    source: str
    snippet: str
    vector_score: float


@dataclass
class HybridKeywordResult:
    """Result from keyword (BM25) search."""

    id: str
    path: str
    start_line: int
    end_line: int
    source: str
    snippet: str
    text_score: float


@dataclass
class HybridMergedResult:
    """Merged result from hybrid search."""

    path: str
    start_line: int
    end_line: int
    score: float
    snippet: str
    source: str


def build_fts_query(raw: str) -> str | None:
    """
    Build an FTS (Full-Text Search) query from a raw search string.
    Extracts alphanumeric tokens and joins them with AND for strict matching.

    Args:
        raw: The raw search query string

    Returns:
        The FTS query string, or None if no valid tokens found
    """
    tokens = re.findall(r"[A-Za-z0-9_]+", raw)
    tokens = [t.strip() for t in tokens if t.strip()]

    if not tokens:
        return None

    quoted = [f'"{t.replace(chr(34), "")}"' for t in tokens]
    return " AND ".join(quoted)


def bm25_rank_to_score(rank: float) -> float:
    """
    Convert BM25 rank to a normalized score between 0 and 1.
    Lower rank = higher score.

    Args:
        rank: The BM25 rank value

    Returns:
        A normalized score where 1 is best and 0 is worst
    """
    import math

    normalized = max(0.0, rank) if math.isfinite(rank) else 999.0
    return 1.0 / (1.0 + normalized)


def merge_hybrid_results(
    vector: list[HybridVectorResult],
    keyword: list[HybridKeywordResult],
    vector_weight: float = 0.7,
    text_weight: float = 0.3,
) -> list[HybridMergedResult]:
    """
    Merge vector similarity and keyword search results using weighted scoring.

    This implements a hybrid search approach where results from both vector
    similarity search and keyword (BM25) search are combined. Results that
    appear in both searches get boosted scores.

    Args:
        vector: Results from vector similarity search
        keyword: Results from keyword (BM25) search
        vector_weight: Weight for vector similarity scores (default: 0.7)
        text_weight: Weight for keyword/text scores (default: 0.3)

    Returns:
        Merged and sorted results with combined scores
    """
    by_id: dict[str, dict] = {}

    # Add vector search results
    for r in vector:
        by_id[r.id] = {
            "id": r.id,
            "path": r.path,
            "start_line": r.start_line,
            "end_line": r.end_line,
            "source": r.source,
            "snippet": r.snippet,
            "vector_score": r.vector_score,
            "text_score": 0.0,
        }

    # Merge keyword search results
    for kw_r in keyword:
        if kw_r.id in by_id:
            existing = by_id[kw_r.id]
            existing["text_score"] = kw_r.text_score
            # Prefer keyword snippet if available (may have highlights)
            if kw_r.snippet:
                existing["snippet"] = kw_r.snippet
        else:
            by_id[kw_r.id] = {
                "id": kw_r.id,
                "path": kw_r.path,
                "start_line": kw_r.start_line,
                "end_line": kw_r.end_line,
                "source": kw_r.source,
                "snippet": kw_r.snippet,
                "vector_score": 0.0,
                "text_score": kw_r.text_score,
            }

    # Calculate weighted scores and create results
    merged = []
    for entry in by_id.values():
        score = vector_weight * entry["vector_score"] + text_weight * entry["text_score"]
        merged.append(
            HybridMergedResult(
                path=entry["path"],
                start_line=entry["start_line"],
                end_line=entry["end_line"],
                score=score,
                snippet=entry["snippet"],
                source=entry["source"],
            )
        )

    # Sort by score descending
    merged.sort(key=lambda x: x.score, reverse=True)
    return merged
