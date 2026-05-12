"""Deterministic MCQ scoring for MMAU.

MMAU is pure multiple choice -- every sample has a labelled ground-truth
letter, so scoring is exact match on the parsed letter. No LLM-judge is
ever needed. The non-trivial part is robustly extracting the letter
from free-form model output, which ``extract_answer_letter`` handles
across the common response shapes.
"""

from __future__ import annotations

import re
import string

from benchmarks.mmau.types import MMAUPrediction, MMAUResult, MMAUSample


_PARENS_LETTER = re.compile(r"\(\s*([A-Z])\s*\)")
_LEADING_LETTER = re.compile(r"^\s*([A-Z])\s*[\.\):,\-]")
_ANSWER_IS_LETTER = re.compile(
    r"\b(?:answer|choice|option|response)\s*(?:is|:|=)?\s*\(?\s*([A-Z])\s*\)?",
    re.IGNORECASE,
)
_LETTER_THEN_CHOICE = re.compile(r"(?<![A-Za-z])([A-Z])(?![A-Za-z])")
_BARE_LETTER = re.compile(r"^\s*([A-Z])\s*$")


def extract_answer_letter(raw: str, *, valid_letters: str = "ABCDEFGH") -> str:
    """Return the upper-case option letter implied by ``raw``, or ``""``.

    Recognises (in priority order): ``"(A)"``, leading ``"A)"`` /
    ``"A."``, ``"The answer is A"``, a bare ``"A"``, then any embedded
    ``"A ..."`` with a delimiter as last resort. Returns ``""`` if no
    letter inside ``valid_letters`` matches.
    """
    if not raw:
        return ""
    text = raw.strip()
    upper = text.upper()

    parens = _PARENS_LETTER.search(upper)
    if parens and parens.group(1) in valid_letters:
        return parens.group(1)

    bare = _BARE_LETTER.match(upper)
    if bare and bare.group(1) in valid_letters:
        return bare.group(1)

    leading = _LEADING_LETTER.match(upper)
    if leading and leading.group(1) in valid_letters:
        return leading.group(1)

    labelled = _ANSWER_IS_LETTER.search(upper)
    if labelled and labelled.group(1).upper() in valid_letters:
        return labelled.group(1).upper()

    embedded = _LETTER_THEN_CHOICE.search(upper)
    if embedded and embedded.group(1) in valid_letters:
        return embedded.group(1)

    return ""


def extract_letter_from_option(option: str) -> str:
    """Return the leading letter of an option string like ``"(A) Man"``."""
    if not option:
        return ""
    match = _PARENS_LETTER.match(option.strip().upper())
    if match:
        return match.group(1)
    leading = _LEADING_LETTER.match(option.strip().upper())
    if leading:
        return leading.group(1)
    return ""


def choice_letters(choices: tuple[str, ...] | list[str]) -> str:
    """Return the alphabet prefix that covers ``choices`` (e.g. ``"ABCD"``)."""
    n = len(choices)
    if n <= 0:
        return ""
    if n > len(string.ascii_uppercase):
        raise ValueError(f"Too many MMAU choices: {n}")
    return string.ascii_uppercase[:n]


class MMAUEvaluator:
    """Score MMAU MCQ predictions against ground truth."""

    def evaluate(self, sample: MMAUSample, prediction: MMAUPrediction) -> MMAUResult:
        valid = choice_letters(sample.choices)
        predicted = (prediction.predicted_letter or "").strip().upper()
        if not predicted:
            predicted = extract_answer_letter(prediction.raw_answer, valid_letters=valid)
        is_correct = (
            prediction.error is None
            and predicted != ""
            and predicted == sample.answer_letter
        )
        return MMAUResult(
            sample_id=sample.id,
            category=sample.category,
            skill=sample.skill,
            information_category=sample.information_category,
            difficulty=sample.difficulty,
            expected_letter=sample.answer_letter,
            predicted_letter=predicted,
            is_correct=is_correct,
            prediction=prediction,
            latency_ms=prediction.latency_ms,
            error=prediction.error,
        )

    def aggregate(self, results: list[MMAUResult]) -> dict[str, object]:
        if not results:
            return {
                "overall_accuracy": 0.0,
                "accuracy_by_category": {},
                "accuracy_by_skill": {},
                "accuracy_by_information_category": {},
                "accuracy_by_difficulty": {},
                "counts_by_category": {},
                "counts_by_skill": {},
                "average_latency_ms": 0.0,
                "error_count": 0,
            }
        total = len(results)
        correct = sum(1 for r in results if r.is_correct)
        error_count = sum(1 for r in results if r.error is not None)

        by_cat: dict[str, list[bool]] = {}
        by_skill: dict[str, list[bool]] = {}
        by_info: dict[str, list[bool]] = {}
        by_diff: dict[str, list[bool]] = {}
        for r in results:
            by_cat.setdefault(r.category.value, []).append(r.is_correct)
            by_skill.setdefault(r.skill, []).append(r.is_correct)
            by_info.setdefault(r.information_category, []).append(r.is_correct)
            by_diff.setdefault(r.difficulty, []).append(r.is_correct)

        return {
            "overall_accuracy": correct / total,
            "accuracy_by_category": {k: sum(v) / len(v) for k, v in by_cat.items()},
            "accuracy_by_skill": {k: sum(v) / len(v) for k, v in by_skill.items()},
            "accuracy_by_information_category": {
                k: sum(v) / len(v) for k, v in by_info.items()
            },
            "accuracy_by_difficulty": {k: sum(v) / len(v) for k, v in by_diff.items()},
            "counts_by_category": {k: len(v) for k, v in by_cat.items()},
            "counts_by_skill": {k: len(v) for k, v in by_skill.items()},
            "average_latency_ms": sum(r.latency_ms for r in results) / total,
            "error_count": error_count,
        }
