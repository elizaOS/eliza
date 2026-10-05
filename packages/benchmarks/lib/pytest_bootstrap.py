"""Configure suite imports for pytest launched inside any benchmark directory."""

from pathlib import Path
import sys


def configure() -> None:
    root = Path(__file__).resolve().parents[1]
    for path in (root, root / "suites"):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
