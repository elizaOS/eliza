"""Two-tier intent detection for form interactions.

Tier 1: Fast path -- English keyword matching via regex (instant, free).
Tier 2: LLM fallback -- for non-English, ambiguous, or complex messages.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from .types import FormIntent

if TYPE_CHECKING:
    pass

# ---------------------------------------------------------------------------
# Fast-path patterns
# ---------------------------------------------------------------------------

_SUBMIT_RE = re.compile(r"\b(submit|done|finish|complete|send|confirm)\b", re.IGNORECASE)
_STASH_RE = re.compile(
    r"\b(stash|save for later|pause|put on hold|come back later)\b", re.IGNORECASE
)
_RESTORE_RE = re.compile(r"\b(restore|resume|continue|pick up where|get back to)\b", re.IGNORECASE)
_CANCEL_RE = re.compile(r"\b(cancel|abort|stop|quit|nevermind|never mind)\b", re.IGNORECASE)
_UNDO_RE = re.compile(r"\b(undo|go back|revert|take that back|oops)\b", re.IGNORECASE)
_SKIP_RE = re.compile(r"\b(skip|pass|next|don't need|not now)\b", re.IGNORECASE)
_EXPLAIN_RE = re.compile(
    r"\b(explain|why do you need|what is this for|help me understand)\b",
    re.IGNORECASE,
)
_EXAMPLE_RE = re.compile(r"\b(example|sample|show me|what should|give me an)\b", re.IGNORECASE)
_PROGRESS_RE = re.compile(r"\b(progress|how far|how much left|status|where am i)\b", re.IGNORECASE)
_AUTOFILL_RE = re.compile(
    r"\b(autofill|use (my )?saved|prefill|fill from|use last)\b", re.IGNORECASE
)


def quick_intent_detect(text: str) -> FormIntent | None:
    """Quick intent detection using English keywords.

    Returns the detected intent or ``None`` if no fast-path match.
    """
    text = text.strip()
    if not text:
        return None

    if _SUBMIT_RE.search(text):
        return "submit"
    if _STASH_RE.search(text):
        return "stash"
    if _RESTORE_RE.search(text):
        return "restore"
    if _CANCEL_RE.search(text):
        return "cancel"
    if _UNDO_RE.search(text):
        return "undo"
    if _SKIP_RE.search(text):
        return "skip"
    if _EXPLAIN_RE.search(text):
        return "explain"
    if _EXAMPLE_RE.search(text):
        return "example"
    if _PROGRESS_RE.search(text):
        return "progress"
    if _AUTOFILL_RE.search(text):
        return "autofill"

    return None


# ---------------------------------------------------------------------------
# Intent classification helpers
# ---------------------------------------------------------------------------

_LIFECYCLE_INTENTS: frozenset[FormIntent] = frozenset({"submit", "stash", "restore", "cancel"})
_UX_INTENTS: frozenset[FormIntent] = frozenset(
    {"undo", "skip", "explain", "example", "progress", "autofill"}
)
_DATA_INTENTS: frozenset[FormIntent] = frozenset({"fill_form", "other"})


def is_lifecycle_intent(intent: FormIntent) -> bool:
    """Return ``True`` if the intent changes session state."""
    return intent in _LIFECYCLE_INTENTS


def is_ux_intent(intent: FormIntent) -> bool:
    """Return ``True`` if the intent is a helper action."""
    return intent in _UX_INTENTS


def has_data_to_extract(intent: FormIntent) -> bool:
    """Return ``True`` if the intent likely contains extractable data."""
    return intent in _DATA_INTENTS
