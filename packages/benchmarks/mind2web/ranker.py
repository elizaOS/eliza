"""DeBERTa-v3 candidate ranker for Mind2Web (MindAct stage 1).

Reproduces the candidate-generation step from the MindAct two-stage pipeline
described in Deng et al. 2023 (https://arxiv.org/abs/2306.06070):

  1. **Candidate ranker (this module)**: a DeBERTa-v3 cross-encoder scores every
     DOM candidate on the page against the task instruction and recent action
     history. The top-K (default 50) are passed to the LLM.
  2. **Action predictor (the LLM / agent)**: picks one element from the top-K
     and emits the (operation, value).

Production runs use OSU's checksum-pinned released candidate-score artifact so
each comparison harness receives the exact same stage-1 output. The pretrained
checkpoint at ``osunlp/MindAct_CandidateGeneration_deberta-v3-base`` remains
available here to reproduce and audit those scores.

Both the score artifact and optional cross-encoder are loaded once per process.

Recall@K is the standard published metric for this stage; ``score_candidates``
returns enough information for the caller to compute it.
"""

from __future__ import annotations

import logging
import os
import pickle
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from numbers import Integral, Real
from pathlib import Path
from typing import Any

from benchmarks.mind2web.types import Mind2WebActionStep, Mind2WebElement

logger = logging.getLogger(__name__)

DEFAULT_RANKER_MODEL = "osunlp/MindAct_CandidateGeneration_deberta-v3-base"
DEFAULT_RANKER_REVISION = "92d3ddcb079b1749015d72293c82d640b0b9a1da"
DEFAULT_TOP_K = 50
DEFAULT_MAX_SEQ_LENGTH = 512


# ---------------------------------------------------------------------------
# Module-level singleton (lazy loaded, thread-safe)
# ---------------------------------------------------------------------------


_RANKER_LOCK = threading.Lock()
_RANKER_CACHE: dict[str, _LoadedRanker] = {}
_PRECOMPUTED_CACHE: dict[str, _PrecomputedRankings] = {}


@dataclass
class _LoadedRanker:
    tokenizer: Any
    model: Any
    device: Any
    max_seq_length: int


@dataclass
class _PrecomputedRankings:
    scores: Mapping[object, object]
    ranks: Mapping[object, object]


def _load_precomputed_rankings() -> _PrecomputedRankings:
    """Load OSU's checksum-pinned stage-1 outputs once per process."""
    from benchmarks.mind2web.dataset import ensure_ranker_scores_available

    scores_path = ensure_ranker_scores_available().resolve()
    cache_key = str(scores_path)
    with _RANKER_LOCK:
        cached = _PRECOMPUTED_CACHE.get(cache_key)
        if cached is not None:
            return cached

        # The checksum is verified before this trusted upstream pickle is read.
        with Path(scores_path).open("rb") as handle:
            payload = pickle.load(handle)  # noqa: S301
        if not isinstance(payload, dict):
            raise ValueError("Mind2Web ranker-score artifact must contain an object")
        scores = payload.get("scores")
        ranks = payload.get("ranks")
        if not isinstance(scores, Mapping) or not isinstance(ranks, Mapping):
            raise ValueError("Mind2Web ranker-score artifact lacks scores/ranks mappings")
        loaded = _PrecomputedRankings(scores=scores, ranks=ranks)
        _PRECOMPUTED_CACHE[cache_key] = loaded
        return loaded


def _load_ranker(
    model_name: str = DEFAULT_RANKER_MODEL,
    revision: str = DEFAULT_RANKER_REVISION,
    max_seq_length: int = DEFAULT_MAX_SEQ_LENGTH,
    device: str | None = None,
) -> _LoadedRanker:
    """Load (or return cached) tokenizer + cross-encoder model."""
    cache_key = f"{model_name}@{revision}|{max_seq_length}|{device or 'auto'}"
    with _RANKER_LOCK:
        cached = _RANKER_CACHE.get(cache_key)
        if cached is not None:
            return cached

        try:
            import torch
            from transformers import (
                AutoModelForSequenceClassification,
                AutoTokenizer,
            )
        except ImportError as exc:
            raise RuntimeError(
                "The Mind2Web DeBERTa candidate ranker requires the 'transformers' "
                "and 'torch' Python packages. Install with: "
                "pip install 'elizaos-mind2web[ranker]'  (or "
                "pip install transformers torch sentence-transformers)."
            ) from exc

        resolved_device: Any
        if device:
            resolved_device = torch.device(device)
        elif torch.cuda.is_available():
            resolved_device = torch.device("cuda")
        else:
            resolved_device = torch.device("cpu")

        logger.info(
            "Loading Mind2Web candidate ranker '%s' on %s (first call downloads ~750MB)",
            model_name,
            resolved_device,
        )

        # This checkpoint ships the SentencePiece model used by upstream
        # MindAct. A tokenizer conversion would change the scored inputs.
        tokenizer = AutoTokenizer.from_pretrained(
            model_name,
            revision=revision,
            use_fast=False,
        )
        model = AutoModelForSequenceClassification.from_pretrained(
            model_name,
            revision=revision,
        )
        model.to(resolved_device)
        model.eval()

        loaded = _LoadedRanker(
            tokenizer=tokenizer,
            model=model,
            device=resolved_device,
            max_seq_length=max_seq_length,
        )
        _RANKER_CACHE[cache_key] = loaded
        return loaded


# ---------------------------------------------------------------------------
# Candidate text formatting (uses vendored upstream DOM utils)
# ---------------------------------------------------------------------------


def _candidate_text(
    dom_tree: Any, element: Mind2WebElement
) -> str:
    """Format a single candidate exactly as MindAct stage 1 does."""
    from benchmarks.mind2web.dom_utils import format_candidate

    return format_candidate(dom_tree, element.backend_node_id)


def _parse_dom(cleaned_html: str) -> Any:
    """Parse the official ``cleaned_html`` blob used by the ranker."""
    if not cleaned_html or not cleaned_html.strip():
        raise ValueError("Mind2Web ranker received empty cleaned_html")
    from lxml import etree

    return etree.fromstring(cleaned_html.encode("utf-8"))


# ---------------------------------------------------------------------------
# Query construction (matches upstream dataloader)
# ---------------------------------------------------------------------------


def build_query(task_description: str, previous_actions: list[str]) -> str:
    """Build the ranker query string. Matches upstream verbatim.

    Upstream uses the last 3 previous actions only.
    """
    prev = "; ".join(previous_actions[-3:])
    return f"task is: {task_description}\nPrevious actions: {prev}"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@dataclass
class RankedCandidate:
    element: Mind2WebElement
    score: float
    is_pos: bool  # whether this element appears in the GT pos_candidates list


def score_candidates(
    step: Mind2WebActionStep,
    *,
    task_description: str,
    previous_actions: list[str],
    top_k: int = DEFAULT_TOP_K,
    model_name: str = DEFAULT_RANKER_MODEL,
    revision: str = DEFAULT_RANKER_REVISION,
    batch_size: int = 32,
    max_seq_length: int = DEFAULT_MAX_SEQ_LENGTH,
    device: str | None = None,
) -> list[RankedCandidate]:
    """Score every candidate (pos + neg) and return the top-K by score.

    Args:
        step: A Mind2Web ground-truth action step (provides candidates + DOM).
        task_description: The natural-language task instruction.
        previous_actions: List of human-readable previous actions (action_reprs).
        top_k: Number of top candidates to return.
        model_name: HF identifier or local path of the DeBERTa cross-encoder.
        batch_size: Batch size for inference.
        max_seq_length: Tokenizer truncation length.
        device: Force device ("cpu", "cuda", "cuda:0"). None = auto.

    Returns:
        A list of at most ``top_k`` ``RankedCandidate`` objects sorted by score
        descending. ``is_pos`` is True if the element's backend_node_id appears
        in ``step.pos_candidates`` — used for Recall@K computation.
    """
    import torch

    loaded = _load_ranker(
        model_name=model_name,
        revision=revision,
        max_seq_length=max_seq_length,
        device=device,
    )

    all_candidates = step.pos_candidates + step.neg_candidates
    if not all_candidates:
        return []

    pos_ids = {c.backend_node_id for c in step.pos_candidates}
    dom_tree = _parse_dom(step.cleaned_html)

    query = build_query(task_description, previous_actions)

    # Upstream CrossEncoder receives [query, candidate] pairs in this order.
    texts_a: list[str] = []
    texts_b: list[str] = []
    for cand in all_candidates:
        texts_a.append(query)
        texts_b.append(_candidate_text(dom_tree, cand))

    scores: list[float] = []
    with torch.no_grad():
        for i in range(0, len(texts_a), batch_size):
            batch_a = texts_a[i : i + batch_size]
            batch_b = texts_b[i : i + batch_size]
            enc = loaded.tokenizer(
                batch_a,
                batch_b,
                padding=True,
                truncation=True,
                max_length=max_seq_length,
                return_tensors="pt",
            )
            enc = {k: v.to(loaded.device) for k, v in enc.items()}
            outputs = loaded.model(**enc)
            logits = outputs.logits.detach()
            # Model has num_labels=1 (regression-style ranking). Flatten.
            if logits.ndim == 2 and logits.shape[-1] == 1:
                logits = logits.view(-1)
            elif logits.ndim == 2 and logits.shape[-1] > 1:
                # Some checkpoints expose 2-way classification; use class-1 logit.
                logits = logits[:, -1]
            scores.extend(float(x) for x in logits.cpu().tolist())

    if len(scores) != len(all_candidates):
        raise RuntimeError(
            "Mind2Web ranker output count mismatch: "
            f"expected {len(all_candidates)}, got {len(scores)}"
        )

    ranked = sorted(
        (
            RankedCandidate(
                element=cand,
                score=score,
                is_pos=cand.backend_node_id in pos_ids,
            )
            for cand, score in zip(all_candidates, scores, strict=True)
        ),
        key=lambda r: r.score,
        reverse=True,
    )
    return ranked[:top_k]


def recall_at_k(ranked: list[RankedCandidate], step: Mind2WebActionStep) -> float:
    """Compute Recall@K for a single step given ranker output.

    Returns 1.0 if any GT positive appears in the top-K, 0.0 otherwise. If there
    are no positives at all, returns ``float("nan")`` so callers can skip the
    step in aggregation.
    """
    if not step.pos_candidates:
        return float("nan")
    pos_ids = {c.backend_node_id for c in step.pos_candidates}
    for cand in ranked:
        if cand.element.backend_node_id in pos_ids:
            return 1.0
    return 0.0


def score_precomputed_candidates(
    step: Mind2WebActionStep,
    *,
    task_id: str,
    top_k: int = DEFAULT_TOP_K,
) -> list[RankedCandidate]:
    """Return top-K candidates from OSU's released MindAct score artifact."""
    payload = _load_precomputed_rankings()
    step_key = f"{task_id}_{step.action_uid}"
    score_values = payload.scores.get(step_key)
    rank_values = payload.ranks.get(step_key)
    if not isinstance(score_values, Mapping) or not isinstance(rank_values, Mapping):
        raise KeyError(f"Mind2Web ranker scores contain no step {step_key!r}")

    candidates = step.pos_candidates + step.neg_candidates
    candidate_ids = {candidate.backend_node_id for candidate in candidates}
    if candidate_ids != set(rank_values) or candidate_ids != set(score_values):
        raise ValueError(f"Mind2Web ranker-score candidates mismatch for {step_key}")

    pos_ids = {candidate.backend_node_id for candidate in step.pos_candidates}
    ranked: list[tuple[int, RankedCandidate]] = []
    for candidate in candidates:
        candidate_id = candidate.backend_node_id
        rank = rank_values[candidate_id]
        score = score_values[candidate_id]
        if isinstance(rank, bool) or not isinstance(rank, Integral):
            raise ValueError(f"Mind2Web rank for {step_key}/{candidate_id} is invalid")
        if isinstance(score, bool) or not isinstance(score, Real):
            raise ValueError(f"Mind2Web score for {step_key}/{candidate_id} is invalid")
        ranked.append(
            (
                int(rank),
                RankedCandidate(
                    element=candidate,
                    score=float(score),
                    is_pos=candidate_id in pos_ids,
                ),
            )
        )
    ranked.sort(key=lambda item: item[0])
    return [candidate for _rank, candidate in ranked[:top_k]]


# ---------------------------------------------------------------------------
# High-level helper used by agents
# ---------------------------------------------------------------------------


def rank_step_candidates(
    step: Mind2WebActionStep,
    task_description: str,
    previous_actions: list[str],
    *,
    top_k: int = DEFAULT_TOP_K,
    model_name: str | None = None,
    revision: str | None = None,
    device: str | None = None,
    task_id: str | None = None,
) -> tuple[list[Mind2WebElement], float]:
    """Run the ranker for one step and return ``(top_elements, recall_at_k)``.

    ``model_name`` defaults to ``MIND2WEB_RANKER_MODEL`` env var, else
    ``DEFAULT_RANKER_MODEL``.
    """
    resolved_model = model_name or os.environ.get(
        "MIND2WEB_RANKER_MODEL", DEFAULT_RANKER_MODEL
    )
    resolved_revision = revision or os.environ.get(
        "MIND2WEB_RANKER_REVISION", DEFAULT_RANKER_REVISION
    )
    if task_id:
        ranked = score_precomputed_candidates(step, task_id=task_id, top_k=top_k)
    else:
        ranked = score_candidates(
            step,
            task_description=task_description,
            previous_actions=previous_actions,
            top_k=top_k,
            model_name=resolved_model,
            revision=resolved_revision,
            device=device,
        )
    recall = recall_at_k(ranked, step)
    return [r.element for r in ranked], recall
