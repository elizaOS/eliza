"""Conservative multiple-choice answer grammar shared by scored suites."""

import re

_LEADING = re.compile(r"^\s*[(\*]*([A-Da-d])(?=\s*$|[).:*])")
_MARKED = re.compile(
    r"\b(?:the\s+)?(?:correct\s+)?answer\s*(?:is\s*|:\s*)[(\*]*([A-D])\b", re.IGNORECASE
)
_OPTIONS = re.compile(r"\b([A-D])\b")


def extract_choice_letter(text: str) -> str | None:
    matches = {
        m.group(1).upper()
        for pattern in (_LEADING, _MARKED)
        for m in pattern.finditer(text)
    }
    if len(matches) != 1:
        return None
    answer = next(iter(matches))
    return (
        answer if all(option == answer for option in _OPTIONS.findall(text)) else None
    )
