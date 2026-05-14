"""``elizaos_mmau`` -- distribution name shim for ``benchmarks.mmau``.

The benchmark module lives under ``benchmarks.mmau`` to match the rest of
the ``packages/benchmarks/`` tree. This shim is exposed so the CLI
``python -m elizaos_mmau`` matches the documented invocation in the
package README and registry entry.
"""

from benchmarks.mmau import *  # noqa: F401, F403
from benchmarks.mmau.cli import main

__all__ = ["main"]
