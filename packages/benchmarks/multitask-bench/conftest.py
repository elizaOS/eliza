"""Pytest bootstrap: put the benchmark package roots on ``sys.path``.

MultitaskBench imports ``eliza_lifeops_bench`` (from the sibling lifeops-bench
package) and ``orchestrator_lifecycle`` (a namespace package rooted at
``packages/benchmarks``). Neither is pip-installed in the repo checkout, so we
add both roots here the way ``lifeops-bench/conftest.py`` does for its own
adapters — otherwise the imports raise at collection time.
"""

from __future__ import annotations

import sys
from pathlib import Path

_BENCHMARKS_ROOT = Path(__file__).resolve().parent.parent
_LIFEOPS_ROOT = _BENCHMARKS_ROOT / "lifeops-bench"

for _root in (_BENCHMARKS_ROOT, _LIFEOPS_ROOT):
    _str = str(_root)
    if _str not in sys.path:
        sys.path.insert(0, _str)
