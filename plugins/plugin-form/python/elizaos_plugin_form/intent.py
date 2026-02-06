"""
Two-tier intent detection for form interactions.

Tier 1 (this module): Fast regex matching for common English phrases.
Tier 2 (LLM): Fallback for non-English, ambiguous, or complex input.
"""

from __future__ import annotations

import re

from .types import FormIntent


def quick_intent_detect(text: str) -> FormIntent | None:
    """Quick intent detection using English keywords.

    Returns ``None`` if no fast-path match found, signalling the caller
    to fall back to LLM-based detection.
    """
    lower = text.lower().strip()

    # Empty or too short
    if len(lower) < 2:
        return None

    # ═══ LIFECYCLE INTENTS ═══

    # Restore
    if re.search(r"\b(resume|continue|pick up where|go back to|get back to)\b", lower):
        return "restore"

    # Submit
    if re.search(
        r"\b(submit|done|finish|send it|that'?s all|i'?m done|complete|all set)\b",
        lower,
    ):
        return "submit"

    # Stash (exclude "save and submit" / "save and send")
    if re.search(
        r"\b(save|stash|later|hold on|pause|save for later|come back|save this)\b",
        lower,
    ):
        if not re.search(r"\b(save and submit|save and send)\b", lower):
            return "stash"

    # Cancel
    if re.search(
        r"\b(cancel|abort|nevermind|never mind|forget it|stop|quit|exit)\b",
        lower,
    ):
        return "cancel"

    # ═══ UX MAGIC INTENTS ═══

    # Undo
    if re.search(
        r"\b(undo|go back|wait no|change that|oops|that'?s wrong|wrong|not right)\b",
        lower,
    ):
        return "undo"

    # Skip (exclude "skip to")
    if re.search(
        r"\b(skip|pass|don'?t know|next one|next|don'?t have|no idea)\b",
        lower,
    ):
        if not re.search(r"\bskip to\b", lower):
            return "skip"

    # Explain
    if re.search(
        r"\b(why|what'?s that for|explain|what do you mean|what is|purpose|reason)\b\??$",
        lower,
        re.IGNORECASE,
    ):
        return "explain"
    if re.match(r"^why\??$", lower, re.IGNORECASE):
        return "explain"

    # Example
    if re.search(
        r"\b(example|like what|show me|such as|for instance|sample)\b\??$",
        lower,
        re.IGNORECASE,
    ):
        return "example"
    if re.match(r"^(example|e\.?g\.?)\??$", lower, re.IGNORECASE):
        return "example"

    # Progress
    if re.search(
        r"\b(how far|how many left|progress|status|how much more|where are we)\b",
        lower,
    ):
        return "progress"

    # Autofill
    if re.search(
        r"\b(same as|last time|use my usual|like before|previous|from before)\b",
        lower,
    ):
        return "autofill"

    return None


# ============================================================================
# INTENT HELPERS
# ============================================================================


def is_lifecycle_intent(intent: FormIntent) -> bool:
    """Check if *intent* is a lifecycle intent (affects session state)."""
    return intent in {"submit", "stash", "restore", "cancel"}


def is_ux_intent(intent: FormIntent) -> bool:
    """Check if *intent* is a UX intent (helper action, no data)."""
    return intent in {"undo", "skip", "explain", "example", "progress", "autofill"}


def has_data_to_extract(intent: FormIntent) -> bool:
    """Check if *intent* likely contains data to extract."""
    return intent in {"fill_form", "other"}
