from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any


GENERATED_ARTIFACT_SCORE_IDS = (
    "summary_factuality",
    "action_item_owner_date",
    "decision_extraction",
    "open_question_extraction",
    "memory_entity_correctness",
    "hallucination_rate",
    "omission_rate",
    "source_grounding",
)


def _normalize(value: object) -> str:
    text = str(value or "").lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _key(row: dict[str, Any], *fields: str) -> tuple[str, ...]:
    return tuple(_normalize(row.get(field)) for field in fields)


def _rows(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [row for row in value if isinstance(row, dict)]


def _span_text(transcript_segments: list[dict[str, Any]], span_ids: Iterable[object]) -> str:
    wanted = {_normalize(span_id) for span_id in span_ids}
    parts = []
    for segment in transcript_segments:
        segment_id = _normalize(segment.get("id"))
        if segment_id in wanted:
            parts.append(str(segment.get("text") or ""))
    return " ".join(parts)


def _valid_span_ids(transcript_segments: list[dict[str, Any]]) -> set[str]:
    return {_normalize(segment.get("id")) for segment in transcript_segments}


def _has_valid_grounding(row: dict[str, Any], valid_span_ids: set[str]) -> bool:
    span_ids = row.get("source_span_ids")
    if not isinstance(span_ids, list) or not span_ids:
        return False
    return all(_normalize(span_id) in valid_span_ids for span_id in span_ids)


def _claim_supported(row: dict[str, Any], transcript_segments: list[dict[str, Any]]) -> bool:
    span_ids = row.get("source_span_ids")
    if not isinstance(span_ids, list):
        return False
    claim = _normalize(row.get("text") or row.get("claim") or row.get("title"))
    if not claim:
        return False
    source = _normalize(_span_text(transcript_segments, span_ids))
    return bool(source) and (claim in source or source in claim)


def _precision_recall_f1(generated: set[tuple[str, ...]], reference: set[tuple[str, ...]]) -> dict[str, float]:
    if not generated and not reference:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0}
    if not generated:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0}
    true_positive = len(generated & reference)
    precision = true_positive / len(generated)
    recall = true_positive / len(reference) if reference else 1.0
    f1 = 0.0 if precision + recall == 0 else (2 * precision * recall) / (precision + recall)
    return {
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(f1, 6),
    }


def _unsupported_count(
    generated_rows: list[dict[str, Any]],
    reference_keys: set[tuple[str, ...]],
    key_fields: tuple[str, ...],
    transcript_segments: list[dict[str, Any]],
) -> int:
    count = 0
    for row in generated_rows:
        if _key(row, *key_fields) not in reference_keys and not _claim_supported(row, transcript_segments):
            count += 1
    return count


def score_generated_artifacts(
    *,
    transcript_segments: list[dict[str, Any]],
    generated_artifacts: dict[str, Any],
    reference_artifacts: dict[str, Any],
) -> dict[str, Any]:
    valid_span_ids = _valid_span_ids(transcript_segments)
    summary_rows = _rows(generated_artifacts.get("summary_claims"))
    supported_summary = sum(1 for row in summary_rows if _claim_supported(row, transcript_segments))
    summary_factuality = supported_summary / len(summary_rows) if summary_rows else 1.0

    generated_action_rows = _rows(generated_artifacts.get("action_items"))
    generated_decision_rows = _rows(generated_artifacts.get("decisions"))
    generated_question_rows = _rows(generated_artifacts.get("open_questions"))
    generated_memory_rows = _rows(generated_artifacts.get("memory_entities"))

    generated_actions = {_key(row, "text", "owner", "due") for row in generated_action_rows}
    reference_actions = {_key(row, "text", "owner", "due") for row in _rows(reference_artifacts.get("action_items"))}
    action_scores = _precision_recall_f1(generated_actions, reference_actions)

    generated_decisions = {_key(row, "text") for row in generated_decision_rows}
    reference_decisions = {_key(row, "text") for row in _rows(reference_artifacts.get("decisions"))}
    decision_scores = _precision_recall_f1(generated_decisions, reference_decisions)

    generated_questions = {_key(row, "text") for row in generated_question_rows}
    reference_questions = {_key(row, "text") for row in _rows(reference_artifacts.get("open_questions"))}
    question_scores = _precision_recall_f1(generated_questions, reference_questions)

    generated_memory = {
        _key(row, "entity_id", "name", "fact") for row in generated_memory_rows
    }
    reference_memory = {
        _key(row, "entity_id", "name", "fact") for row in _rows(reference_artifacts.get("memory_entities"))
    }
    memory_scores = _precision_recall_f1(generated_memory, reference_memory)

    generated_summary_keys = {_key(row, "text") for row in summary_rows}
    reference_summary_keys = {_key(row, "text") for row in _rows(reference_artifacts.get("summary_claims"))}
    unsupported = 0
    unsupported += _unsupported_count(summary_rows, reference_summary_keys, ("text",), transcript_segments)
    unsupported += _unsupported_count(
        generated_action_rows,
        reference_actions,
        ("text", "owner", "due"),
        transcript_segments,
    )
    unsupported += _unsupported_count(
        generated_decision_rows,
        reference_decisions,
        ("text",),
        transcript_segments,
    )
    unsupported += _unsupported_count(
        generated_question_rows,
        reference_questions,
        ("text",),
        transcript_segments,
    )
    generated_total_rows = (
        len(summary_rows)
        + len(generated_action_rows)
        + len(generated_decision_rows)
        + len(generated_question_rows)
        + len(generated_memory_rows)
    )
    hallucination_rate = unsupported / generated_total_rows if generated_total_rows else 0.0

    reference_total = (
        len(reference_summary_keys)
        + len(reference_actions)
        + len(reference_decisions)
        + len(reference_questions)
        + len(reference_memory)
    )
    covered = (
        len(generated_summary_keys & reference_summary_keys)
        + len(generated_actions & reference_actions)
        + len(generated_decisions & reference_decisions)
        + len(generated_questions & reference_questions)
        + len(generated_memory & reference_memory)
    )
    omission_rate = (reference_total - covered) / reference_total if reference_total else 0.0

    grounded_rows = []
    for section in ("summary_claims", "action_items", "decisions", "open_questions", "memory_entities"):
        grounded_rows.extend(_rows(generated_artifacts.get(section)))
    grounded_count = sum(1 for row in grounded_rows if _has_valid_grounding(row, valid_span_ids))
    source_grounding = grounded_count / len(grounded_rows) if grounded_rows else 1.0

    return {
        "summary_factuality": round(summary_factuality, 6),
        "action_item_owner_date": action_scores["f1"],
        "decision_extraction": decision_scores["f1"],
        "open_question_extraction": question_scores["f1"],
        "memory_entity_correctness": memory_scores["f1"],
        "hallucination_rate": round(hallucination_rate, 6),
        "omission_rate": round(omission_rate, 6),
        "source_grounding": round(source_grounding, 6),
        "details": {
            "action_items": action_scores,
            "decisions": decision_scores,
            "open_questions": question_scores,
            "memory_entities": memory_scores,
            "unsupported_generated_items": unsupported,
            "generated_items": generated_total_rows,
            "reference_items": reference_total,
            "grounded_items": grounded_count,
        },
    }
