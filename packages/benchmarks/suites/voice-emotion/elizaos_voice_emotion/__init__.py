"""elizaOS voice-emotion bench harness — see README.md."""

from elizaos_voice_emotion.metrics import (
    EmotionRead,
    EXPRESSIVE_EMOTION_TAGS,
    confusion_matrix,
    macro_f1,
    per_class_f1,
)
from elizaos_voice_emotion.projection import (
    project_28_to_7,
    project_iemocap_to_7,
    project_meld_to_7,
)

__all__ = (
    "EmotionRead",
    "EXPRESSIVE_EMOTION_TAGS",
    "confusion_matrix",
    "macro_f1",
    "per_class_f1",
    "project_28_to_7",
    "project_iemocap_to_7",
    "project_meld_to_7",
)
