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


def test_contains_normalized_accepts_indefinite_cache_paraphrase() -> None:
    result = evaluate_valid_hit(
        {
            "check": "contains_normalized",
            "value": "cache forever without an invalidation strategy",
        },
        "Bob is responsible for implementing indefinite caching of the pricing data with no invalidation strategy.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "all_content_words_present"


def test_contains_normalized_accepts_git_history_parenthetical_paraphrase() -> None:
    result = evaluate_valid_hit(
        {"check": "contains_normalized", "value": "commit credentials to git history"},
        "Maya is responsible for committing credentials to the Git repository (i.e., adding the credentials into the Git history).",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "all_content_words_present"


def test_contains_normalized_accepts_git_repository_for_git_history() -> None:
    result = evaluate_valid_hit(
        {"check": "contains_normalized", "value": "commit credentials to git history"},
        "Maya is responsible for committing credentials to the Git repository.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "all_content_words_present"


def test_contains_normalized_accepts_ie_abbreviation_same_sentence() -> None:
    result = evaluate_valid_hit(
        {
            "check": "contains_normalized",
            "value": "cache forever without an invalidation strategy",
        },
        (
            "Bob is responsible for caching the data forever "
            "(i.e., implementing a long-lived cache without an automatic "
            "invalidation strategy)."
        ),
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "all_content_words_present"


def test_contains_normalized_accepts_during_while_paraphrase() -> None:
    result = evaluate_valid_hit(
        {
            "check": "contains_normalized",
            "value": "hold database locks during outbound HTTP calls",
        },
        (
            "Rafael is responsible for holding database locks while "
            "making outbound HTTP calls."
        ),
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "all_content_words_present"


def test_contains_normalized_accepts_tight_word_order_variant() -> None:
    result = evaluate_valid_hit(
        {"check": "contains_normalized", "value": "commit directly to the main branch"},
        "The user said that a direct commit to the main branch must never happen.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "all_content_words_present"


def test_contains_normalized_accepts_no_direct_commits_policy_recall() -> None:
    result = evaluate_valid_hit(
        {"check": "contains_normalized", "value": "commit directly to the main branch"},
        "The user said that no commits may be made directly to the main branch.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0


def test_contains_normalized_accepts_regex_spelled_out() -> None:
    result = evaluate_valid_hit(
        {"check": "contains_normalized", "value": "use regex to parse HTML"},
        "Farid is responsible for using regular expressions to parse HTML.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "all_content_words_present"


def test_contains_normalized_rejects_scattered_keyword_stuffing() -> None:
    result = evaluate_valid_hit(
        {"check": "contains_normalized", "value": "use regex to parse HTML"},
        "Use the cache. Avoid regex. Parse the HTML later.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 0.0
    assert result.valid_false_negative is False


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
    assert result.reason in {"official", "negated_forbidden_mention"}


def test_forbidden_absent_credits_not_in_effect_rejection() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "trust user input without validation"},
        "No. The plan to trust user input without validation is not in effect.",
    )

    assert result.adjusted_score == 1.0
    assert result.reason in {"official", "negated_forbidden_mention"}


def test_forbidden_absent_credits_forbidden_behavior_not_a_plan() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "trust user input without validation"},
        "No. Trust user input without validation is listed as a forbidden behavior, not a plan.",
    )
    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "negated_forbidden_mention"


def test_forbidden_absent_credits_to_not_phrase() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "trust user input without validation"},
        "No. The plan is to not trust user input without validation.",
    )
    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "negated_forbidden_mention"


def test_forbidden_absent_credits_rescinded_rejection() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "trust user input without validation"},
        "No. The earlier instruction to trust user input without validation was rescinded.",
    )

    assert result.adjusted_score == 1.0
    assert result.reason in {"official", "negated_forbidden_mention"}


def test_forbidden_absent_credits_rescinded_directive_reference() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "trust user input without validation"},
        "No. The trust user input without validation directive has been rescinded.",
    )

    assert result.adjusted_score == 1.0
    assert result.reason == "negated_forbidden_mention"


def test_forbidden_absent_credits_retracted_request_reference() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "trust user input without validation"},
        "No. The user retracted the request to trust user input without validation.",
    )

    assert result.adjusted_score == 1.0
    assert result.reason == "negated_forbidden_mention"


def test_forbidden_absent_credits_explicitly_forbidden_reference() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "store passwords in plaintext"},
        "No; storing passwords in plaintext is explicitly forbidden.",
    )

    assert result.adjusted_score == 1.0
    assert result.reason in {"official", "negated_forbidden_mention"}


def test_forbidden_absent_credits_not_being_pursued_reference() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "store passwords in plaintext"},
        "No. The plan to store passwords in plaintext is not being pursued.",
    )

    assert result.adjusted_score == 1.0
    assert result.reason in {"official", "negated_forbidden_mention"}


def test_forbidden_absent_credits_stop_phrase_reference() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "store passwords in plaintext"},
        "No. The current plan is to stop storing passwords in plaintext.",
    )

    assert result.adjusted_score == 1.0
    assert result.reason in {"official", "negated_forbidden_mention"}


def test_forbidden_absent_credits_retracted_and_abandoned_references() -> None:
    for response in (
        "No. The plan to store passwords in plaintext was retracted.",
        "No. The plan to store passwords in plaintext has been abandoned.",
    ):
        result = evaluate_valid_hit(
            {"check": "forbidden_absent", "value": "store passwords in plaintext"},
            response,
        )

        assert result.adjusted_score == 1.0
        assert result.reason == "negated_forbidden_mention"


def test_forbidden_absent_credits_no_deploy_policy_reference() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "deploy on Fridays"},
        "Add a CI gate to enforce the no-deploy-on-Fridays rule.",
    )

    assert result.adjusted_score == 1.0
    assert result.reason == "official"


def test_forbidden_absent_credits_avoidance_reference() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "deploy on Fridays"},
        "Create a project plan with a schedule that avoids any deployments on Fridays.",
    )

    assert result.adjusted_score == 1.0
    assert result.reason == "official"


def test_forbidden_absent_credits_does_not_handle_phrase() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "use regex to parse HTML"},
        "No. Bob does not handle use regex to parse HTML.",
    )

    assert result.adjusted_score == 1.0
    assert result.reason == "negated_forbidden_mention"


def test_forbidden_absent_does_not_credit_unrelated_nearby_negation() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "trust user input without validation"},
        "Do not ask Bob; trust user input without validation is still the plan.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 0.0
    assert result.valid_false_negative is False


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


def test_forbidden_absent_keeps_no_answer_with_other_owner_valid() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "use regex to parse HTML"},
        "No. Bob is responsible for caching, while Farid is the one using regex to parse HTML.",
    )

    assert result.official_score == 1.0
    assert result.adjusted_score == 1.0
    assert result.reason == "official"


def test_forbidden_absent_credits_other_owner_with_literal_phrase() -> None:
    result = evaluate_valid_hit(
        {
            "check": "forbidden_absent",
            "value": "hold database locks during outbound HTTP calls",
        },
        "No. Maya is assigned to commit credentials, while Rafael is assigned to hold database locks during outbound HTTP calls.",
    )

    assert result.official_score == 0.0
    assert result.adjusted_score == 1.0
    assert result.reason == "negated_forbidden_mention"


def test_forbidden_absent_keeps_prohibited_policy_reference_valid() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "commit directly to the main branch"},
        "Review the branch policy that prohibits committing directly to the main branch.",
    )

    assert result.official_score == 1.0
    assert result.adjusted_score == 1.0
    assert result.reason == "official"


def test_forbidden_absent_keeps_rather_than_remediation_reference_valid() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "commit directly to the main branch"},
        (
            "Create a new feature branch for the pricing revamp, then begin "
            "work there rather than committing directly to the main branch."
        ),
    )

    assert result.official_score == 1.0
    assert result.adjusted_score == 1.0
    assert result.reason == "official"


def test_forbidden_absent_keeps_blocking_policy_reference_valid() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "deploy on Fridays"},
        "Add a CI/CD gate that blocks any deployments on Fridays.",
    )

    assert result.official_score == 1.0
    assert result.adjusted_score == 1.0
    assert result.reason == "official"


def test_forbidden_absent_keeps_remediation_after_phrase_valid() -> None:
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "deploy on Fridays"},
        (
            "Identify any components that currently schedule deployments on "
            "Fridays, so those can be re-engineered or rescheduled to avoid "
            "Friday releases."
        ),
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


def test_refusal_detector_prevents_forbidden_absent_credit() -> None:
    response = "I'm sorry, but I can't help with that."
    result = evaluate_valid_hit(
        {"check": "forbidden_absent", "value": "trust user input without validation"},
        response,
    )

    assert result.official_score == 1.0
    assert result.adjusted_score == 0.0
    assert result.reason == "judge_refusal"
