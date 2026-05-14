"""Unit tests for MMAU answer-letter extraction and aggregation."""

from __future__ import annotations

import pytest

from benchmarks.mmau.evaluator import (
    MMAUEvaluator,
    choice_letters,
    extract_answer_letter,
    extract_letter_from_option,
)
from benchmarks.mmau.types import MMAUCategory, MMAUPrediction, MMAUSample


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("(A)", "A"),
        ("( A )", "A"),
        ("A.", "A"),
        ("A)", "A"),
        ("A: Man", "A"),
        ("A", "A"),
        ("a", "A"),
        ("The answer is A", "A"),
        ("The answer is (B).", "B"),
        ("Answer: C", "C"),
        ("answer: c", "C"),
        ("Option D", "D"),
        ("choice = b", "B"),
        ("response is (D)", "D"),
        ("A) The answer is correct because ...", "A"),
        ("Based on the audio I believe the answer is B because ...", "B"),
        ("After listening, the speaker is clearly (C) Child.", "C"),
        ("Looking at the choices, B fits best.", "B"),
        ("D. acoustic guitar", "D"),
    ],
)
def test_extract_answer_letter_common_shapes(raw: str, expected: str) -> None:
    assert extract_answer_letter(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "I don't know",
        "Some long answer with no MCQ letter at all.",
        "9",
        "###",
    ],
)
def test_extract_answer_letter_unparseable(raw: str) -> None:
    assert extract_answer_letter(raw) == ""


def test_extract_answer_letter_respects_valid_letters() -> None:
    assert extract_answer_letter("Answer: E", valid_letters="ABCD") == ""
    assert extract_answer_letter("Answer: E", valid_letters="ABCDE") == "E"


def test_extract_letter_from_option_shapes() -> None:
    assert extract_letter_from_option("(A) Man") == "A"
    assert extract_letter_from_option("B) Woman") == "B"
    assert extract_letter_from_option("C. Child") == "C"
    assert extract_letter_from_option("not labelled") == ""
    assert extract_letter_from_option("") == ""


def test_choice_letters() -> None:
    assert choice_letters(["x", "y", "z"]) == "ABC"
    assert choice_letters(["a"]) == "A"
    assert choice_letters([]) == ""
    with pytest.raises(ValueError):
        choice_letters(["a"] * 27)


def _sample(
    sample_id: str,
    *,
    answer: str = "A",
    category: MMAUCategory = MMAUCategory.SPEECH,
    skill: str = "Speaker Identification",
    info_cat: str = "Information Extraction",
    difficulty: str = "easy",
) -> MMAUSample:
    return MMAUSample(
        id=sample_id,
        question="Question?",
        choices=("(A) one", "(B) two", "(C) three", "(D) four"),
        answer_letter=answer,
        answer_text=f"({answer}) text",
        category=category,
        skill=skill,
        information_category=info_cat,
        difficulty=difficulty,
        dataset="test",
    )


def test_evaluator_scores_correct_letter_correct() -> None:
    sample = _sample("s1", answer="C")
    evaluator = MMAUEvaluator()
    result = evaluator.evaluate(
        sample,
        MMAUPrediction(sample_id="s1", predicted_letter="C", raw_answer="(C) three"),
    )
    assert result.is_correct
    assert result.predicted_letter == "C"
    assert result.expected_letter == "C"


def test_evaluator_falls_back_to_raw_answer_parsing() -> None:
    sample = _sample("s2", answer="B")
    evaluator = MMAUEvaluator()
    result = evaluator.evaluate(
        sample,
        MMAUPrediction(sample_id="s2", raw_answer="The answer is B."),
    )
    assert result.is_correct
    assert result.predicted_letter == "B"


def test_evaluator_marks_wrong_letter_incorrect() -> None:
    sample = _sample("s3", answer="A")
    evaluator = MMAUEvaluator()
    result = evaluator.evaluate(
        sample,
        MMAUPrediction(sample_id="s3", predicted_letter="D"),
    )
    assert not result.is_correct


def test_evaluator_marks_empty_prediction_incorrect() -> None:
    sample = _sample("s4", answer="A")
    evaluator = MMAUEvaluator()
    result = evaluator.evaluate(
        sample,
        MMAUPrediction(sample_id="s4", raw_answer="I don't know."),
    )
    assert not result.is_correct
    assert result.predicted_letter == ""


def test_evaluator_marks_error_prediction_incorrect() -> None:
    sample = _sample("s5", answer="A")
    evaluator = MMAUEvaluator()
    result = evaluator.evaluate(
        sample,
        MMAUPrediction(sample_id="s5", predicted_letter="A", error="timeout"),
    )
    assert not result.is_correct
    assert result.error == "timeout"


def test_aggregate_per_category_and_skill() -> None:
    evaluator = MMAUEvaluator()
    samples = [
        _sample("s1", answer="A", category=MMAUCategory.SPEECH, skill="Speaker Identification"),
        _sample("s2", answer="B", category=MMAUCategory.SPEECH, skill="Speaker Identification"),
        _sample("s3", answer="C", category=MMAUCategory.MUSIC, skill="Instrument Identification"),
        _sample("s4", answer="D", category=MMAUCategory.SOUND, skill="Temporal Event Reasoning"),
    ]
    predictions = [
        MMAUPrediction(sample_id="s1", predicted_letter="A"),  # correct
        MMAUPrediction(sample_id="s2", predicted_letter="A"),  # wrong
        MMAUPrediction(sample_id="s3", predicted_letter="C"),  # correct
        MMAUPrediction(sample_id="s4", predicted_letter="A"),  # wrong
    ]
    results = [evaluator.evaluate(s, p) for s, p in zip(samples, predictions, strict=True)]
    agg = evaluator.aggregate(results)
    assert agg["overall_accuracy"] == 0.5
    by_cat = agg["accuracy_by_category"]
    assert isinstance(by_cat, dict)
    assert by_cat["speech"] == 0.5
    assert by_cat["music"] == 1.0
    assert by_cat["sound"] == 0.0
    by_skill = agg["accuracy_by_skill"]
    assert isinstance(by_skill, dict)
    assert by_skill["Speaker Identification"] == 0.5
    assert by_skill["Instrument Identification"] == 1.0
    counts = agg["counts_by_category"]
    assert isinstance(counts, dict)
    assert counts["speech"] == 2
    assert counts["music"] == 1
    assert counts["sound"] == 1


def test_aggregate_empty_results() -> None:
    evaluator = MMAUEvaluator()
    agg = evaluator.aggregate([])
    assert agg["overall_accuracy"] == 0.0
    assert agg["accuracy_by_category"] == {}
    assert agg["error_count"] == 0
