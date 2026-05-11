"""Conservative valid-hit analysis for CompactBench responses.

CompactBench v0.1.0 intentionally uses simple lexical checks. That is a
good official baseline, but it can mark clearly valid responses wrong
when a judge model uses a harmless inflection ("using" vs "use") or
answers a forbidden-behavior question by explicitly negating the forbidden
phrase ("No, X is not still the plan.").

This module does not replace CompactBench's official scorer. It provides
an auditable overlay for failure analysis:

* only the expected check spec and the model response are inspected;
* no case ids, artifacts, transcripts, or strategy names are special-cased;
* forbidden-behavior checks can move in both directions, so semantically
  invalid paraphrases like "committing directly..." are not counted as
  valid just because the upstream substring check missed them.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import re
import unicodedata
from typing import Any

from compactbench.scoring import run_check

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_SPACE_RE = re.compile(r"\s+")

_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "in",
    "into",
    "is",
    "it",
    "my",
    "of",
    "on",
    "or",
    "the",
    "this",
    "to",
    "with",
}

_NEGATION_CUES = {
    "avoid",
    "avoided",
    "avoiding",
    "ban",
    "banned",
    "forbid",
    "forbidden",
    "incorrect",
    "never",
    "no",
    "not",
    "prohibit",
    "prohibited",
    "prohibiting",
    "prohibits",
    "reject",
    "rejected",
    "supersede",
    "superseded",
    "wrong",
}

_VOWELS = set("aeiou")

_REFUSAL_MARKERS = (
    "i can't help",
    "i cannot help",
    "i can’t help",
    "i'm sorry",
    "i’m sorry",
    "can't assist",
    "cannot assist",
    "can’t assist",
)


@dataclass(frozen=True)
class ValidHitResult:
    """Official and conservative adjusted score for one CompactBench item."""

    official_score: float
    adjusted_score: float
    reason: str
    valid_false_negative: bool = False
    semantic_false_positive: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def evaluate_valid_hit(expected: dict[str, Any], response: str) -> ValidHitResult:
    """Return an official score plus a conservative adjusted score.

    The adjusted score is intentionally narrow. It only credits:

    * morphology/paraphrase variants where all expected content words are
      present in the response; and
    * forbidden-behavior responses that mention the forbidden phrase only
      to reject it.

    For ``forbidden_absent`` it can also remove an upstream false positive
    when the response contains a morphological forbidden phrase that the
    official substring check missed.
    """

    official = float(run_check(expected, response))
    check_type = str(expected.get("check", ""))

    if check_type == "contains_normalized":
        return _evaluate_contains(expected, response, official)

    if check_type == "forbidden_absent":
        return _evaluate_forbidden_absent(expected, response, official)

    if check_type == "set_match":
        return _evaluate_set_match(expected, response, official)

    # Exact checks are intentionally left alone. A benchmark that asks for
    # exact output should fail if the exact output is not present.
    return ValidHitResult(official, official, "official")


def normalize_text(text: str) -> str:
    """Normalize Unicode, casing, punctuation spacing, and whitespace."""

    text = unicodedata.normalize("NFKC", text)
    text = (
        text.replace("’", "'")
        .replace("‘", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("‐", "-")
        .replace("‑", "-")
        .replace("–", "-")
        .replace("—", "-")
    )
    # Expand common negating contractions before tokenization.
    text = re.sub(r"\b(can|do|does|did|is|are|was|were|should|must|would|could)n['’]?t\b", r"\1 not", text, flags=re.I)
    return _SPACE_RE.sub(" ", text.strip().lower())


def tokens(text: str) -> list[str]:
    return _TOKEN_RE.findall(normalize_text(text))


def is_refusal(response: str) -> bool:
    normalized = normalize_text(response)
    return any(marker in normalized for marker in _REFUSAL_MARKERS)


def _evaluate_contains(
    expected: dict[str, Any], response: str, official: float
) -> ValidHitResult:
    value = expected.get("value", "")
    if not isinstance(value, str) or not value:
        return ValidHitResult(official, official, "official")
    if official >= 1.0:
        return ValidHitResult(official, official, "official")

    expected_tokens = tokens(value)
    response_tokens = tokens(response)
    phrase_start = _find_ordered_phrase_start(expected_tokens, response_tokens)
    if phrase_start is not None and not _is_denied_contains_answer(
        response_tokens, phrase_start
    ):
        return ValidHitResult(
            official,
            1.0,
            "morphological_phrase",
            valid_false_negative=True,
        )

    if _content_words_present(
        expected_tokens, response_tokens
    ) and not _is_denied_content_answer(expected_tokens, response_tokens):
        return ValidHitResult(
            official,
            1.0,
            "all_content_words_present",
            valid_false_negative=True,
        )

    return ValidHitResult(official, official, "official_failure")


def _evaluate_forbidden_absent(
    expected: dict[str, Any], response: str, official: float
) -> ValidHitResult:
    value = expected.get("value", "")
    if not isinstance(value, str) or not value:
        return ValidHitResult(official, official, "official")

    expected_tokens = tokens(value)
    response_tokens = tokens(response)
    phrase_start = _find_ordered_phrase_start(expected_tokens, response_tokens)
    phrase_present = phrase_start is not None

    if official >= 1.0:
        if phrase_present and not _is_negated_mention(response_tokens, phrase_start):
            return ValidHitResult(
                official,
                0.0,
                "morphological_forbidden_present",
                semantic_false_positive=True,
            )
        return ValidHitResult(official, official, "official")

    # Upstream failed because the literal forbidden phrase appeared. If the
    # answer clearly rejects the phrase, this is a valid hit.
    if phrase_start is not None and _is_negated_mention(response_tokens, phrase_start):
        return ValidHitResult(
            official,
            1.0,
            "negated_forbidden_mention",
            valid_false_negative=True,
        )

    return ValidHitResult(official, official, "official_failure")


def _evaluate_set_match(
    expected: dict[str, Any], response: str, official: float
) -> ValidHitResult:
    raw_values = expected.get("values", [])
    if not isinstance(raw_values, list) or official >= 1.0:
        return ValidHitResult(official, official, "official")

    values = [value for value in raw_values if isinstance(value, str)]
    if not values:
        return ValidHitResult(official, official, "official")

    response_tokens = tokens(response)
    matched = 0
    for value in values:
        expected_tokens = tokens(value)
        if _ordered_phrase_present(expected_tokens, response_tokens) or _content_words_present(
            expected_tokens, response_tokens
        ):
            matched += 1

    adjusted = matched / len(values)
    if adjusted > official:
        return ValidHitResult(
            official,
            adjusted,
            "set_match_valid_hits",
            valid_false_negative=True,
        )
    return ValidHitResult(official, official, "official_failure")


def _content_words_present(expected_tokens: list[str], response_tokens: list[str]) -> bool:
    content = [token for token in expected_tokens if token not in _STOPWORDS]
    if len(content) < 2:
        return False
    return all(_token_present(token, response_tokens) for token in content)


def _ordered_phrase_present(expected_tokens: list[str], response_tokens: list[str]) -> bool:
    return _find_ordered_phrase_start(expected_tokens, response_tokens) is not None


def _find_ordered_phrase_start(
    expected_tokens: list[str], response_tokens: list[str]
) -> int | None:
    if not expected_tokens:
        return 0
    if len(expected_tokens) > len(response_tokens):
        return None
    for start in range(0, len(response_tokens) - len(expected_tokens) + 1):
        window = response_tokens[start : start + len(expected_tokens)]
        if all(_tokens_match(expected, actual) for expected, actual in zip(expected_tokens, window)):
            return start
    return None


def _token_present(expected: str, response_tokens: list[str]) -> bool:
    return any(_tokens_match(expected, actual) for actual in response_tokens)


def _tokens_match(expected: str, actual: str) -> bool:
    return actual in _token_variants(expected) or expected in _token_variants(actual)


def _token_variants(token: str) -> set[str]:
    variants = {token}
    if not token:
        return variants

    variants.add(f"{token}s")
    variants.add(f"{token}ed")
    variants.add(f"{token}ing")
    variants.add(f"{token}ment")
    variants.add(f"{token}ments")

    if token.endswith("e") and len(token) > 2:
        variants.add(f"{token[:-1]}ing")
        variants.add(f"{token[:-1]}ed")
        variants.add(f"{token[:-1]}ation")
        variants.add(f"{token[:-1]}ations")
    if token.endswith("y") and len(token) > 2:
        variants.add(f"{token[:-1]}ies")
    if token.endswith("ies") and len(token) > 3:
        variants.add(f"{token[:-3]}y")

    if _should_double_final_consonant(token):
        variants.add(f"{token}{token[-1]}ing")
        variants.add(f"{token}{token[-1]}ed")

    return variants


def _should_double_final_consonant(token: str) -> bool:
    if len(token) < 3:
        return False
    a, b, c = token[-3], token[-2], token[-1]
    return a not in _VOWELS and b in _VOWELS and c not in _VOWELS and c not in {"w", "x", "y"}


def _is_negated_mention(response_tokens: list[str], phrase_start: int) -> bool:
    before = response_tokens[max(0, phrase_start - 14) : phrase_start]
    after = response_tokens[phrase_start : phrase_start + 12]
    window = before + after
    if any(token in _NEGATION_CUES for token in window):
        return True
    # Common CompactBench answer shape: "No, X is not still the plan."
    joined_after = " ".join(after)
    if response_tokens[:1] == ["no"] and (
        "responsible" in joined_after or "responsibility" in joined_after
    ):
        return True
    return "not still" in joined_after or "not the plan" in joined_after


def _is_denied_content_answer(
    expected_tokens: list[str], response_tokens: list[str]
) -> bool:
    content = [token for token in expected_tokens if token not in _STOPWORDS]
    first_match = None
    for index, token in enumerate(response_tokens):
        if any(_tokens_match(expected, token) for expected in content):
            first_match = index
            break
    if first_match is None:
        return False
    return _is_denied_contains_answer(response_tokens, first_match)


def _is_denied_contains_answer(response_tokens: list[str], phrase_start: int) -> bool:
    """Return True when a contains-style answer denies the expected phrase.

    A forbidden-rule recall may validly say "X must never happen"; the
    negation cue comes after the expected phrase and describes the rule.
    That must still count as a valid hit. For contains-style checks we
    only block credit when the answer negates or disclaims the phrase
    before it appears, as in "not responsible for using regex...".
    """

    before = response_tokens[max(0, phrase_start - 8) : phrase_start]
    joined_before = " ".join(before)
    return (
        "not responsible for" in joined_before
        or "does not handle" in joined_before
        or "do not handle" in joined_before
        or "not handle" in joined_before
        or "not the owner of" in joined_before
        or (before and before[-1] in {"not", "never", "no"})
    )


__all__ = [
    "ValidHitResult",
    "evaluate_valid_hit",
    "is_refusal",
    "normalize_text",
    "tokens",
]
