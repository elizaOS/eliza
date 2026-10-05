from __future__ import annotations

import pytest

from elizaos_meeting_transcription_proof.artifact_scoring import score_generated_artifacts


TRANSCRIPT_SEGMENTS = [
    {"id": "s1", "text": "Alice will send the budget by Friday."},
    {"id": "s2", "text": "The team decided to launch beta."},
    {"id": "s3", "text": "Bob asked whether legal approved."},
    {"id": "s4", "text": "Alice owns the budget follow-up."},
]


def _reference_artifacts() -> dict[str, object]:
    return {
        "summary_claims": [
            {"text": "Alice will send the budget by Friday", "source_span_ids": ["s1"]},
        ],
        "action_items": [
            {
                "text": "Alice will send the budget by Friday",
                "owner": "Alice",
                "due": "Friday",
                "source_span_ids": ["s1"],
            }
        ],
        "decisions": [
            {"text": "The team decided to launch beta", "source_span_ids": ["s2"]},
        ],
        "open_questions": [
            {"text": "Bob asked whether legal approved", "source_span_ids": ["s3"]},
        ],
        "memory_entities": [
            {
                "entity_id": "person-alice",
                "name": "Alice",
                "fact": "owns the budget follow-up",
                "source_span_ids": ["s4"],
            }
        ],
    }


def test_scores_perfect_generated_artifacts() -> None:
    artifacts = _reference_artifacts()

    scores = score_generated_artifacts(
        transcript_segments=TRANSCRIPT_SEGMENTS,
        generated_artifacts=artifacts,
        reference_artifacts=artifacts,
    )

    assert scores["summary_factuality"] == pytest.approx(1.0)
    assert scores["action_item_owner_date"] == pytest.approx(1.0)
    assert scores["decision_extraction"] == pytest.approx(1.0)
    assert scores["open_question_extraction"] == pytest.approx(1.0)
    assert scores["memory_entity_correctness"] == pytest.approx(1.0)
    assert scores["hallucination_rate"] == pytest.approx(0.0)
    assert scores["omission_rate"] == pytest.approx(0.0)
    assert scores["source_grounding"] == pytest.approx(1.0)


def test_unsupported_claim_raises_hallucination_and_grounding_rates() -> None:
    reference = _reference_artifacts()
    generated = dict(reference)
    generated["summary_claims"] = [
        *reference["summary_claims"],
        {"text": "Pricing was approved", "source_span_ids": ["missing"]},
    ]

    scores = score_generated_artifacts(
        transcript_segments=TRANSCRIPT_SEGMENTS,
        generated_artifacts=generated,
        reference_artifacts=reference,
    )

    assert scores["summary_factuality"] == pytest.approx(0.5)
    assert scores["hallucination_rate"] > 0
    assert scores["source_grounding"] < 1


def test_duplicate_unsupported_claims_keep_hallucination_rate_in_range() -> None:
    generated = {
        "summary_claims": [
            {"text": "Pricing was approved", "source_span_ids": ["missing"]},
            {"text": "Pricing was approved", "source_span_ids": ["missing"]},
        ],
    }

    scores = score_generated_artifacts(
        transcript_segments=TRANSCRIPT_SEGMENTS,
        generated_artifacts=generated,
        reference_artifacts=_reference_artifacts(),
    )

    assert scores["hallucination_rate"] == pytest.approx(1.0)


def test_wrong_memory_entity_counts_as_incorrect_and_omitted() -> None:
    reference = _reference_artifacts()
    generated = dict(reference)
    generated["memory_entities"] = [
        {
            "entity_id": "person-wrong",
            "name": "Alice",
            "fact": "owns the budget follow-up",
            "source_span_ids": ["s4"],
        }
    ]

    scores = score_generated_artifacts(
        transcript_segments=TRANSCRIPT_SEGMENTS,
        generated_artifacts=generated,
        reference_artifacts=reference,
    )

    assert scores["memory_entity_correctness"] == pytest.approx(0.0)
    assert scores["omission_rate"] > 0
