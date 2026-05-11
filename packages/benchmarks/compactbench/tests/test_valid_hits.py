"""Tests for conservative valid-hit analysis.

These tests intentionally cover only response-local transformations. The
valid-hit overlay must never special-case a template, case id, artifact,
or strategy name.
"""

from __future__ import annotations

from eliza_compactbench.valid_hits import (
    evaluate_valid_hit,
    is_refusal,
    normalize_text,
    tokens,
)


def test_normalize_text_collapses_unicode_spacing_and_punctuation() -> None:
    assert normalize_text("Ramon\u202fRamirez") == "ramon ramirez"
    assert tokens("Don’t commit directly") == ["do", "not", "commit", "directly"]


def test_contains_normalized_accepts_safe_morphological_variant() -> None:
    result = evaluate_valid_hit(
        {"check": "contains_normalized", "value": "commit directly to the main branch"},
        "The rule was about committing directly to the main branch.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.valid_false_negative is True
    assert result.reason == "morphological_phrase"


def test_contains_normalized_accepts_forbidden_rule_recall_with_never_after_phrase() -> None:
    result = evaluate_valid_hit(
        {"check": "contains_normalized", "value": "commit directly to the main branch"},
        "The user said committing directly to the main branch must never happen.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "morphological_phrase"


def test_contains_normalized_accepts_all_content_words_without_template_knowledge() -> None:
    result = evaluate_valid_hit(
        {
            "check": "contains_normalized",
            "value": "cache forever without an invalidation strategy",
        },
        "Bob owns the cache that persists forever without an invalidation strategy.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "all_content_words_present"


def test_contains_normalized_accepts_passive_forbidden_rule_recall() -> None:
    result = evaluate_valid_hit(
        {"check": "contains_normalized", "value": "commit credentials to git history"},
        "The user said that credentials must never be committed to the Git history.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "all_content_words_present"


def test_contains_normalized_accepts_noun_form_forbidden_rule_recall() -> None:
    result = evaluate_valid_hit(
        {"check": "contains_normalized", "value": "deploy on Fridays"},
        "The user said deployments must never happen on Fridays.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "all_content_words_present"


def test_contains_normalized_does_not_credit_negated_answer() -> None:
    result = evaluate_valid_hit(
        {"check": "contains_normalized", "value": "use regex to parse HTML"},
        "Farid is not responsible for using regex to parse HTML.",
    )

    assert result.adjusted_score == 0.0
    assert result.valid_false_negative is False


def test_forbidden_absent_credits_explicit_rejection_of_forbidden_phrase() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "trust user input without validation"},
        "No, trust user input without validation is not still the plan.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "negated_forbidden_mention"


def test_forbidden_absent_removes_morphological_false_positive() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "commit directly to the main branch"},
        "The next step is committing directly to the main branch.",
    )

    assert result.official_score == 1.0
    assert result.adjusted_score == 0.0
    assert result.semantic_false_positive is True
    assert result.reason == "morphological_forbidden_present"


def test_forbidden_absent_keeps_clean_official_positive() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "use regex to parse HTML"},
        "Bob handles the cache task; Farid owns the parsing task.",
    )

    assert result.official_score == 1.0
    assert result.adjusted_score == 1.0
    assert result.reason == "official"


def test_forbidden_absent_keeps_reassigned_responsibility_answer_valid() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "return raw exception messages to end users"},
        (
            "No. Quinn is responsible for validation; returning raw exception "
            "messages to end users is Jamal's responsibility."
        ),
    )

    assert result.official_score == 1.0
    assert result.adjusted_score == 1.0
    assert result.reason == "official"


def test_forbidden_absent_keeps_prohibited_policy_reference_valid() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "commit directly to the main branch"},
        "Review the branch policy that prohibits committing directly to the main branch.",
    )

    assert result.official_score == 1.0
    assert result.adjusted_score == 1.0
    assert result.reason == "official"


def test_refusal_detector_identifies_judge_refusal_without_counting_as_valid_hit() -> None:
    response = "I’m sorry, but I can’t help with that."
    result = evaluate_valid_hit(
        {"check": "contains_normalized", "value": "commit credentials to git history"},
        response,
    )

    assert is_refusal(response) is True
    assert result.adjusted_score == 0.0
