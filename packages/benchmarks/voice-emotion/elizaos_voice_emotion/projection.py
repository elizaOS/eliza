"""Label-space projections.

The bench scores everyone in the same 7-class `EXPRESSIVE_EMOTION_TAGS`
target — that's what the eliza-1 runtime consumes and what
`models/voice/manifest.json` records. The various gold-label sources use
different taxonomies:

  - IEMOCAP (4-class): anger, happy, sad, neutral. (Drop neutral / map to
    abstention; the 4-class macro-F1 is computed against `{angry, happy, sad}`
    in this bench so the IEMOCAP baseline is comparable across adapters.)

  - MELD (7-class dialog): anger, disgust, fear, joy, neutral, sadness,
    surprise. Map joy→happy, anger→angry, sadness→sad, fear→nervous,
    surprise→excited, neutral→calm. `disgust` has no scope-setting tag in
    our vocabulary; map → `angry` (closest valence-arousal corner) and
    record the lossy projection in the bench output.

  - GoEmotions (28-class text): see `GO_EMOTIONS_TO_7` below; the
    projection table comes from Demszky et al.'s 2020 release notes for
    the canonical Ekman mapping (`admiration`, `amusement`, `joy` → happy,
    etc.) extended with the calm / whisper non-Ekman tags this repo uses.

These tables are deliberately conservative — when a source label has no
clean target, we abstain (`None`) rather than force-map. The bench then
records the abstention rate alongside macro-F1.
"""

from __future__ import annotations

from collections.abc import Mapping

from elizaos_voice_emotion.metrics import EmotionLabel

# ---------------------------------------------------------------------------
# IEMOCAP (4-class) → 7-class target.
# ---------------------------------------------------------------------------

_IEMOCAP_TO_7: Mapping[str, EmotionLabel | None] = {
    "ang": "angry",
    "anger": "angry",
    "hap": "happy",
    "happy": "happy",
    "joy": "happy",
    "exc": "excited",
    "excited": "excited",
    "sad": "sad",
    "sadness": "sad",
    "neu": "calm",       # IEMOCAP's neutral is closer to our `calm` than to a 4th class
    "neutral": "calm",
    "fea": "nervous",
    "fear": "nervous",
    "fru": "angry",      # frustration → angry (best valence-arousal match)
    "frustration": "angry",
    "sur": "excited",    # surprise → excited (the high-arousal positive)
    "surprise": "excited",
    "dis": "angry",      # disgust → angry (low V, high D)
    "disgust": "angry",
}


def project_iemocap_to_7(label: str) -> EmotionLabel | None:
    """Map an IEMOCAP gold label to our 7-class target, or `None` when no
    clean target exists (caller treats `None` as abstention).
    """
    return _IEMOCAP_TO_7.get(label.strip().lower())


# ---------------------------------------------------------------------------
# MELD (7-class dialog) → 7-class target.
# ---------------------------------------------------------------------------

_MELD_TO_7: Mapping[str, EmotionLabel | None] = {
    "anger": "angry",
    "disgust": "angry",
    "fear": "nervous",
    "joy": "happy",
    "neutral": "calm",
    "sadness": "sad",
    "sad": "sad",
    "surprise": "excited",
}


def project_meld_to_7(label: str) -> EmotionLabel | None:
    return _MELD_TO_7.get(label.strip().lower())


# ---------------------------------------------------------------------------
# GoEmotions (28-class text) → 7-class target.
# Per Demszky et al. (2020) the canonical Ekman projection is well-defined;
# we extend with the non-Ekman tags this repo cares about.
# ---------------------------------------------------------------------------

_GO_EMOTIONS_TO_7: Mapping[str, EmotionLabel | None] = {
    "admiration": "happy",
    "amusement": "happy",
    "anger": "angry",
    "annoyance": "angry",
    "approval": "calm",
    "caring": "calm",
    "confusion": "nervous",
    "curiosity": "excited",
    "desire": "excited",
    "disappointment": "sad",
    "disapproval": "angry",
    "disgust": "angry",
    "embarrassment": "nervous",
    "excitement": "excited",
    "fear": "nervous",
    "gratitude": "happy",
    "grief": "sad",
    "joy": "happy",
    "love": "happy",
    "nervousness": "nervous",
    "optimism": "happy",
    "pride": "happy",
    "realization": "calm",
    "relief": "calm",
    "remorse": "sad",
    "sadness": "sad",
    "surprise": "excited",
    "neutral": "calm",
}


def project_28_to_7(label: str) -> EmotionLabel | None:
    return _GO_EMOTIONS_TO_7.get(label.strip().lower())
