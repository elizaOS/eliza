"""Tests for conservative valid-hit analysis.

These tests intentionally cover only response-local transformations. The
valid-hit overlay must never special-case a template, case id, artifact,
or strategy name.
"""

from __future__ import annotations

from eliza_compactbench.valid_hits import evaluate_valid_hit, normalize_text, tokens


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
