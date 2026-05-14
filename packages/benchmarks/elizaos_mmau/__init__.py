"""``elizaos_mmau`` -- backwards-compatible shim for ``elizaos_mmau_audio``.

The real benchmark package lives under ``packages/benchmarks/mmau-audio``.
Keep this module so older documented invocations continue to work.
"""

from __future__ import annotations

import sys
from pathlib import Path

_AUDIO_ROOT = Path(__file__).resolve().parents[1] / "mmau-audio"
if str(_AUDIO_ROOT) not in sys.path:
    sys.path.insert(0, str(_AUDIO_ROOT))

from elizaos_mmau_audio import *  # noqa: F401, F403
from elizaos_mmau_audio import __all__ as _AUDIO_ALL
from elizaos_mmau_audio.cli import main

__all__ = [*_AUDIO_ALL, "main"]
