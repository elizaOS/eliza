"""``elizaos_mmau`` -- legacy distribution-name shim.

The benchmark implementation now lives in ``elizaos_mmau_audio``. This shim is
kept so legacy ``python -m elizaos_mmau`` invocations continue to work.
"""

import sys
from pathlib import Path

_MMAU_AUDIO_PATH = Path(__file__).resolve().parents[1] / "mmau-audio"
if _MMAU_AUDIO_PATH.is_dir() and str(_MMAU_AUDIO_PATH) not in sys.path:
    sys.path.insert(0, str(_MMAU_AUDIO_PATH))

from elizaos_mmau_audio import *  # noqa: F401, F403
from elizaos_mmau_audio.cli import main

__all__ = ["main"]
