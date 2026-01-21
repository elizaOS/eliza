#!/usr/bin/env python3
from __future__ import annotations

import _bootstrap  # noqa: F401
import argparse
import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Dict, List

from matcher.candidate_graph import build_hybrid_candidate_ids
from matcher.llm_rerank import build_candidates, build_llm_payload, persona_card


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _chat_completions(base_url: str, api_key: str, model: str, payload: Dict[str, object]) -> Dict[str, object]:
    url = base_url.rstrip("/") + "/chat/completions"
    body = json.dumps({"model": model, **payload}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "matching-rerank/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _chat_text(resp: Dict[str, object]) -> str:
    choices = resp.get("choices")
    if isinstance(choices, list) and choices:
        c0 = choices[0]
        if isinstance(c0, dict):
            msg = c0.get("message")
            if isinstance(msg, dict) and isinstance(msg.get("content"), str):
                return msg["content"]
    raise ValueError("Unexpected chat completion response shape")


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="LLM rerank dating matches using baseline scores for coarse filtering.")
    p.add_argument("--model", default="openai/gpt-oss-120b", help="Model name (default: openai/gpt-oss-120b)")
    p.add_argument("--base-url", default="https://api.groq.com/openai/v1", help="OpenAI-compatible base URL (default: Groq)")
    p.add_argument("--city", choices=["San Francisco", "New York"], default=None, help="Limit personas to a city")
    p.add_argument("--persona", default=None, help="Run reranking for a single persona id (e.g. D-SF-001)")
    p.add_argument("--max-personas", type=int, default=None, help="Limit number of personas to process (for cheap testing)")
    p.add_argument("--topK", type=int, default=30, help="How many baseline candidates to send to the LLM per persona (default: 30)")
    p.add_argument("--out", default="data/dating/llm_rankings.json", help="Output JSON path")
    p.add_argument("--sleep", type=float, default=0.0, help="Sleep seconds between API calls (default: 0)")
    p.add_argument("--heuristic-k", type=int, default=30, help="Top-K neighbors by heuristic score per node (default: 30)")
    p.add_argument("--embed-k", type=int, default=20, help="Top-K neighbors by embedding similarity (default: 20)")
    p.add_argument("--expand-hops", type=int, default=1, help="Small-world expansion hops (default: 1)")
    p.add_argument("--max-candidates", type=int, default=50, help="Max candidates after expansion (default: 50)")
    p.add_argument("--embed-model", default="text-embedding-3-small", help="OpenAI embedding model")
    p.add_argument("--embedding-cache", default="data/dating/embeddings.json", help="Embedding cache path")
    return p.parse_args()


def main() -> None:
    api_key = os.environ.get("GROQ_API_KEY")
    if not isinstance(api_key, str) or not api_key:
        raise SystemExit("Set GROQ_API_KEY to run LLM reranking.")

    args = _parse_args()
    root = Path(__file__).resolve().parents[1]
    d = root / "data" / "dating"

    sf = _load(d / "personas_sf.json")
    ny = _load(d / "personas_ny.json")
    personas = sf + ny
    by_id: Dict[str, Dict[str, object]] = {p["id"]: p for p in personas if isinstance(p, dict) and isinstance(p.get("id"), str)}

    matrix = _load(d / "match_matrix.json")
    scores: Dict[str, Dict[str, int]] = matrix["scores"]

    ids: List[str] = list(matrix["personaIds"])
    if args.city is not None:
        ids = [pid for pid in ids if persona_card(by_id[pid]).get("city") == args.city]
    if args.persona is not None:
        pid = str(args.persona)
        if pid not in by_id:
            raise SystemExit(f"Unknown persona id: {pid}")
        ids = [pid]
    if args.max_personas is not None:
        n = int(args.max_personas)
        if n < 1:
            raise SystemExit("--max-personas must be >= 1")
        ids = ids[:n]

    results: Dict[str, object] = {"domain": "dating", "model": args.model, "topK": args.topK, "rankings": {}}
    use_embeddings = bool(os.environ.get("OPENAI_API_KEY"))
    if args.embed_k > 0 and not use_embeddings:
        print("Warning: OPENAI_API_KEY missing; embedding candidates disabled.")

    for pid in ids:
        p = by_id[pid]
        candidate_ids = build_hybrid_candidate_ids(
            persona_id=pid,
            by_id=by_id,
            scores=scores,
            heuristic_k=int(args.heuristic_k),
            embed_k=int(args.embed_k),
            expand_hops=int(args.expand_hops),
            max_candidates=int(args.max_candidates),
            embedding_model=str(args.embed_model),
            embedding_cache_path=root / str(args.embedding_cache),
            use_embeddings=use_embeddings,
        )
        candidates = build_candidates(by_id, scores, pid, int(args.topK), candidate_ids=candidate_ids)
        payload = build_llm_payload(pid, p, candidates, by_id, top_n=10)

        resp = _chat_completions(str(args.base_url), api_key, str(args.model), payload)
        text = _chat_text(resp)
        parsed = json.loads(text)
        results["rankings"][pid] = parsed

        if args.sleep > 0:
            time.sleep(float(args.sleep))

    out_path = root / str(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote LLM rankings to {out_path}")


if __name__ == "__main__":
    main()

