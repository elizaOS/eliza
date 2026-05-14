"""``elizaos_mmau`` -- backwards-compatible shim for ``elizaos_mmau_audio``.

The real benchmark package lives under ``packages/benchmarks/mmau-audio``.
Keep this module so older documented invocations continue to work.
"""

from elizaos_mmau_audio import *  # noqa: F401, F403
from elizaos_mmau_audio.cli import main

__all__ = ["main"]
