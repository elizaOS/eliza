"""Apply the shared benchmark pytest bootstrap for standalone suite runs."""

from pathlib import Path
import sys

_BENCHMARKS_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_BENCHMARKS_ROOT.parent))
from benchmarks.lib.pytest_bootstrap import configure

configure()
