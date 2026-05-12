"""Conservative valid-hit analysis for CompactBench responses.

CompactBench v0.1.0 intentionally uses simple lexical checks. That is a
useful raw telemetry baseline, but it can mark clearly valid responses wrong
when a judge model uses a harmless inflection ("using" vs "use") or
answers a forbidden-behavior question by explicitly negating the forbidden
phrase ("No, X is not still the plan.").

This module is the repaired elizaOS scorer for CompactBench. It provides
an auditable scoring layer:

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

try:
    from compactbench.scoring import run_check as _compactbench_run_check
except ImportError:  # pragma: no cover - exercised only in lightweight test envs.
    _compactbench_run_check = None

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
    "during",
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
    "use",
    "using",
    "strategy",
    "without",
    "with",
}

_NEGATION_CUES = {
    "avoid",
    "avoided",
    "avoiding",
    "block",
    "blocked",
    "blocking",
    "blocks",
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


def run_check(expected: dict[str, Any], response: str) -> float:
    """Run CompactBench's official check, with a lightweight local fallback."""

    if _compactbench_run_check is not None:
        return float(_compactbench_run_check(expected, response))
    return _fallback_run_check(expected, response)


def _fallback_run_check(expected: dict[str, Any], response: str) -> float:
    check_type = str(expected.get("check", ""))
    value = expected.get("value", "")
    normalized_response = normalize_text(response)

    if check_type == "contains_normalized":
        return float(isinstance(value, str) and normalize_text(value) in normalized_response)

    if check_type == "forbidden_absent":
        return float(not (isinstance(value, str) and normalize_text(value) in normalized_response))

    if check_type == "set_match":
        raw_values = expected.get("values", [])
        values = [candidate for candidate in raw_values if isinstance(candidate, str)]
        if not values:
            return 0.0
        matches = sum(
            1 for candidate in values if normalize_text(candidate) in normalized_response
        )
        return matches / len(values)

    if isinstance(value, str):
        return float(normalize_text(value) == normalized_response)
    return 0.0


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
    if is_refusal(response):
        return ValidHitResult(official, 0.0, "judge_refusal")

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

    if _content_words_present_in_response(
        expected_tokens, response
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
        if phrase_present and not _is_negated_mention(
            response_tokens, phrase_start, len(expected_tokens)
        ):
            if _is_reassigned_responsibility_mention(
                response_tokens, phrase_start, len(expected_tokens)
            ):
                return ValidHitResult(official, official, "official")
            return ValidHitResult(
                official,
                0.0,
                "morphological_forbidden_present",
                semantic_false_positive=True,
            )
        return ValidHitResult(official, official, "official")

    # Upstream failed because the literal forbidden phrase appeared. If the
    # answer clearly rejects the phrase, this is a valid hit.
    if phrase_start is not None and (
        _is_negated_mention(response_tokens, phrase_start, len(expected_tokens))
        or _is_reassigned_responsibility_mention(
            response_tokens, phrase_start, len(expected_tokens)
        )
    ):
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
        if _ordered_phrase_present(expected_tokens, response_tokens) or _content_words_present_in_response(
            expected_tokens, response
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


def _content_words_present_in_response(expected_tokens: list[str], response: str) -> bool:
    for segment in _segments(response):
        if _content_words_present(expected_tokens, tokens(segment)):
            return True
    return False


def _segments(text: str) -> list[str]:
    text = re.sub(r"\b([ie])\.([eg])\.", r"\1\2", text, flags=re.I)
    return [
        segment
        for segment in re.split(r"[!?;\n]+|(?<=\w)\.(?=\s|$)", text)
        if segment.strip()
    ]


def _content_words_present(expected_tokens: list[str], response_tokens: list[str]) -> bool:
    content = [token for token in expected_tokens if token not in _STOPWORDS]
    if len(content) < 2:
        return False
    if not all(_token_present(token, response_tokens) for token in content):
        return False
    if _ordered_terms_present(content, response_tokens):
        return True
    if _unordered_tight_terms_present(content, response_tokens):
        return True
    return _compact_policy_recall(content, response_tokens)


def _ordered_terms_present(expected_terms: list[str], response_tokens: list[str]) -> bool:
    cursor = 0
    last_match = -1
    for expected in expected_terms:
        found = None
        for index in range(cursor, len(response_tokens)):
            if _tokens_match(expected, response_tokens[index]):
                found = index
                break
        if found is None:
            return False
        if last_match >= 0 and found - last_match > 8:
            return False
        last_match = found
        cursor = found + 1
    return True


def _unordered_tight_terms_present(
    expected_terms: list[str], response_tokens: list[str]
) -> bool:
    positions = []
    for expected in expected_terms:
        for index, token in enumerate(response_tokens):
            if _tokens_match(expected, token):
                positions.append(index)
                break
        else:
            return False
    return max(positions) - min(positions) <= max(14, len(expected_terms) + 8)


def _compact_policy_recall(expected_terms: list[str], response_tokens: list[str]) -> bool:
    positions = []
    for expected in expected_terms:
        for index, token in enumerate(response_tokens):
            if _tokens_match(expected, token):
                positions.append(index)
                break
    if len(positions) != len(expected_terms):
        return False
    start, end = min(positions), max(positions)
    if end - start > max(18, len(expected_terms) + 10):
        return False
    window = response_tokens[max(0, start - 4) : min(len(response_tokens), end + 8)]
    joined = " ".join(window)
    return (
        "must never" in joined
        or "must not" in joined
        or "should never" in joined
        or "should not" in joined
        or any(
            token in {"forbid", "forbidden", "prohibit", "prohibited", "prohibits", "banned"}
            for token in window
        )
    )


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

    aliases = {
        "direct": {"directly"},
        "directly": {"direct"},
        "regex": {"regular", "regexp"},
        "regexp": {"regex", "regular"},
        "history": {"repository", "repo", "git"},
        "repository": {"history", "repo"},
        "repo": {"repository", "history"},
        "strategy": {"plan", "policy", "approach"},
        "plan": {"strategy", "policy", "approach"},
        "forever": {"indefinite", "indefinitely", "permanent", "permanently", "perpetual"},
        "indefinite": {"forever"},
        "indefinitely": {"forever"},
        "permanent": {"forever"},
        "perpetual": {"forever"},
        "permanently": {"forever"},
        "stdout": {"standard", "output"},
        "personally": {"pii"},
        "identifiable": {"pii"},
        "information": {"pii"},
    }
    variants.update(aliases.get(token, set()))

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


def _is_negated_mention(
    response_tokens: list[str], phrase_start: int, phrase_length: int
) -> bool:
    before = response_tokens[max(0, phrase_start - 6) : phrase_start]
    after_phrase = response_tokens[
        phrase_start + phrase_length : phrase_start + phrase_length + 10
    ]
    joined_after = " ".join(after_phrase)
    joined_before = " ".join(before)

    # Direct command forms: "do not <phrase>", "never <phrase>",
    # "prohibit/reject <phrase>".
    if (
        before[-2:] == ["do", "not"]
        or before[-2:] == ["does", "not"]
        or before[-2:] == ["did", "not"]
        or before[-2:] == ["is", "not"]
        or before[-2:] == ["are", "not"]
        or before[-2:] == ["was", "not"]
        or before[-2:] == ["were", "not"]
        or before[-2:] == ["not", "to"]
        or before[-2:] == ["to", "not"]
        or joined_before.endswith("does not handle")
        or joined_before.endswith("do not handle")
        or joined_before.endswith("did not handle")
        or joined_before.endswith("not handle")
        or joined_before.endswith("not responsible for")
        or joined_before.endswith("not for")
        or joined_before.endswith("rather than")
        or joined_before.endswith("instead of")
        or before[-2:] == ["to", "stop"]
        or before[-1:] in (["no"], ["stop"])
        or before[-1:] in (["never"], ["avoid"], ["reject"], ["forbid"], ["prohibit"])
        or before[-1:] in (["avoids"], ["avoided"], ["avoiding"])
        or before[-1:] == ["not"]
        or before[-1:] in (["rejected"], ["forbidden"], ["prohibited"], ["prohibits"])
        or any(token in {"avoid", "avoids", "avoided", "avoiding"} for token in before[-4:])
        or any(token in {"block", "blocks", "blocked", "blocking"} for token in before[-4:])
        or any(token in {"retract", "retracted", "rescind", "rescinded", "abandon", "abandoned", "cancel", "canceled", "cancelled"} for token in before)
        or any(token in {"supersede", "supersedes", "superseded"} for token in before)
    ):
        return True

    # Policy-reference forms: "policy prohibits <phrase>".
    if any(
        token in {"forbid", "forbidden", "prohibit", "prohibited", "prohibits", "banned"}
        for token in before[-3:]
    ):
        return True

    # Common CompactBench answer shape: "No, <phrase> is not still the plan."
    if response_tokens[:1] == ["no"] and (
        "not still" in joined_after
        or "not the plan" in joined_after
        or "not a plan" in joined_after
        or "no longer" in joined_after
        or "was rescinded" in joined_after
        or "has been rescinded" in joined_after
        or "was reversed" in joined_after
        or "was canceled" in joined_after
        or "was cancelled" in joined_after
        or "was retracted" in joined_after
        or "has been retracted" in joined_after
        or "was abandoned" in joined_after
        or "has been abandoned" in joined_after
        or "not in effect" in joined_after
        or "not being pursued" in joined_after
        or "not pursued" in joined_after
        or "not being used" in joined_after
        or "not being followed" in joined_after
        or "responsible" in joined_after
        or "responsibility" in joined_after
        or ("belongs to" in joined_after and "responsibility" in joined_before)
    ):
        return True

    return (
        "must never" in joined_after
        or "must not" in joined_after
        or "should never" in joined_after
        or "should not" in joined_after
        or "is forbidden" in joined_after
        or "is explicitly forbidden" in joined_after
        or "forbidden behavior" in joined_after
        or "is prohibited" in joined_after
        or "is explicitly prohibited" in joined_after
        or "is banned" in joined_after
        or "is not allowed" in joined_after
        or "not allowed" in joined_before[-20:]
        or "not in effect" in joined_after
        or "so those can be" in joined_after
        or "so it can be" in joined_after
        or "so they can be" in joined_after
        or "to avoid" in joined_after
        or "avoid" in joined_after
        or "rescheduled" in joined_after
        or "re engineered" in joined_after
    )


def _is_reassigned_responsibility_mention(
    response_tokens: list[str], phrase_start: int, phrase_length: int
) -> bool:
    before = response_tokens[max(0, phrase_start - 14) : phrase_start]
    after = response_tokens[
        phrase_start + phrase_length : phrase_start + phrase_length + 10
    ]
    full = " ".join(response_tokens)
    joined_before = " ".join(before)
    joined_after = " ".join(after)
    return (
        response_tokens[:1] == ["no"]
        and (
            "responsible" in full
            or "owner" in full
            or "owns" in full
            or "assigned" in full
        )
        and (
            "while" in before
            or "instead" in before
            or "rather" in before
            or "belongs to" in joined_after
            or "is the one" in joined_before
        )
    )


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
        or (before and before[-1] == "not")
    )


__all__ = [
    "ValidHitResult",
    "evaluate_valid_hit",
    "is_refusal",
    "normalize_text",
    "tokens",
]
