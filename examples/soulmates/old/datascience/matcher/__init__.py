from __future__ import annotations

from matcher.io import load_json, write_json
from matcher.candidate_graph import build_hybrid_candidate_ids
from matcher.llm_rerank import build_llm_payload, persona_card, facts_summary
from matcher.matrix import build_matrix, top_k_matches
from matcher.query import query_matches
from matcher.scoring import ScoreComponent, score_cofounder, score_dating, score_friendship
from matcher.signals import (
    CofounderSignals,
    DatingSignals,
    FriendshipSignals,
    clamp_int,
    cofounder_from_persona,
    dating_from_persona,
    dating_ineligibility_reason,
    friendship_from_persona,
)
from matcher.types import (
    Benchmarks,
    BenchmarkPair,
    Build,
    City,
    Domain,
    Fact,
    MatchEntry,
    MatchMatrix,
    Persona,
)

__all__ = [
    "Benchmarks",
    "BenchmarkPair",
    "Build",
    "City",
    "Domain",
    "Fact",
    "MatchEntry",
    "MatchMatrix",
    "Persona",
    "CofounderSignals",
    "DatingSignals",
    "FriendshipSignals",
    "ScoreComponent",
    "build_llm_payload",
    "build_hybrid_candidate_ids",
    "build_matrix",
    "clamp_int",
    "cofounder_from_persona",
    "dating_from_persona",
    "dating_ineligibility_reason",
    "facts_summary",
    "friendship_from_persona",
    "load_json",
    "persona_card",
    "query_matches",
    "score_cofounder",
    "score_dating",
    "score_friendship",
    "top_k_matches",
    "write_json",
]
