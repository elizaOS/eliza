"""
Compat shim for RL tests.

Tests authored against the babylon layout import from `src.training.<module>`
and `src.models`. After the merge into packages/training, those modules live
under packages/training/scripts/rl/. This conftest:

1. Adds packages/training/scripts to sys.path so `scripts/rl/` resolves as
   the package `rl` (relative imports inside it work).
2. Installs sys.meta_path aliases mapping `src` and `src.training` prefixes
   onto `rl`, so legacy test imports keep working without edits.
3. Skips tests whose imported module needs an optional ML dep (torch,
   transformers, atroposlib, …) that isn't installed in the unit-test env.
   Those tests are still runnable when the `[train]` extras are installed.
"""

from __future__ import annotations

import importlib
import importlib.abc
import importlib.machinery
import sys
import types
from pathlib import Path

import pytest

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
            # Mirror the real `rl` package so `from src.training import X` works
            # for symbols exported by scripts/rl/__init__.py.
            try:
                real_rl = importlib.import_module("rl")
            except ImportError:
                real_rl = None
            mod = types.ModuleType(fullname)
            mod.__path__ = []  # mark as package
            if real_rl is not None:
                for _attr_name, _attr_val in real_rl.__dict__.items():
                    if not _attr_name.startswith("__"):
                        setattr(mod, _attr_name, _attr_val)
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
                except ImportError as exc:
                    pytest.skip(
                        f"optional ML dep missing for {fullname}: {exc}",
                        allow_module_level=True,
                    )
                sys.modules[fullname] = real
                return real.__spec__
        return None


class _NullLoader(importlib.abc.Loader):
    def create_module(self, spec):  # noqa: D401
        return None

    def exec_module(self, module):  # noqa: D401
        return None


sys.meta_path.insert(0, _RLAliasFinder())


# Some tests `import torch` (or other heavy deps) at module-top, before any
# alias-finder logic runs. Skip them at collection time when the dep is
# missing so the unit suite stays green without `[train]` extras.
_HEAVY_DEP_TESTS = {
    "test_local_inference.py": "transformers",
    "test_continuous_rl.py": "transformers",
    "test_lr_scheduler.py": "transformers",
}

collect_ignore: list[str] = []
for _file, _dep in _HEAVY_DEP_TESTS.items():
    try:
        importlib.import_module(_dep)
    except ImportError:
        collect_ignore.append(_file)
