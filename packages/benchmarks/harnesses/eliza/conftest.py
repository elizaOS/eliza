"""Apply the shared benchmark pytest bootstrap for standalone suite runs."""

from pathlib import Path
import sys
import tomllib

_BENCHMARKS_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_BENCHMARKS_ROOT.parent))
from benchmarks.lib.pytest_bootstrap import configure

configure()

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Repository-level pytest does not load this harness's pyproject settings.
# Use the same declared suite dependencies for both entry points.
_HARNESS_ROOT = Path(__file__).resolve().parent
with (_HARNESS_ROOT / "pyproject.toml").open("rb") as _manifest:
    _config = tomllib.load(_manifest)
for _relative_path in _config["tool"]["pytest"]["ini_options"]["pythonpath"]:
    _path = str((_HARNESS_ROOT / _relative_path).resolve())
    if _path not in sys.path:
        sys.path.insert(0, _path)
