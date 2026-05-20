"""
Compat shim for RL tests.

Tests authored against the babylon layout import from `src.training.<module>`
and `src.models`. After the merge into packages/training, those modules live
under packages/training/scripts/rl/. This conftest:

1. Adds packages/training/scripts to sys.path so `scripts/rl/` resolves as
   the package `rl` (relative imports inside it work).
2. Installs sys.meta_path aliases mapping `src` and `src.training` prefixes
   onto `rl`, so legacy test imports keep working without edits.
"""

from __future__ import annotations

import importlib
import importlib.abc
import importlib.machinery
import sys
import types
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
_RL_DIR = _SCRIPTS_DIR / "rl"

if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

# Some surviving tests do their own `sys.path.insert(..., "../src/training")` and
# then `from <module> import ...` flat. Add scripts/rl to sys.path so those
# unqualified imports resolve to the unified location.
if str(_RL_DIR) not in sys.path:
    sys.path.insert(0, str(_RL_DIR))


class _RLAliasFinder(importlib.abc.MetaPathFinder):
    """Map `src.X`, `src.training.X` -> `rl.X`."""

    _PREFIXES = ("src.training.", "src.")
    _PARENTS = {"src", "src.training"}

    def find_spec(self, fullname: str, path=None, target=None):
        if fullname in self._PARENTS:
            mod = types.ModuleType(fullname)
            mod.__path__ = []  # mark as package
            sys.modules[fullname] = mod
            return importlib.machinery.ModuleSpec(fullname, _NullLoader(), is_package=True)
        for prefix in self._PREFIXES:
            if fullname.startswith(prefix):
                leaf = fullname[len(prefix):]
                if "." in leaf:
                    return None
                if not (_RL_DIR / f"{leaf}.py").exists():
                    return None
                target_name = f"rl.{leaf}"
                try:
                    real = importlib.import_module(target_name)
                except ImportError:
                    return None
                sys.modules[fullname] = real
                return real.__spec__
        return None


class _NullLoader(importlib.abc.Loader):
    def create_module(self, spec):  # noqa: D401
        return None

    def exec_module(self, module):  # noqa: D401
        return None


sys.meta_path.insert(0, _RLAliasFinder())
