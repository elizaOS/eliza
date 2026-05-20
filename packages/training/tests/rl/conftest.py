"""
Compat shim: tests authored against the babylon layout import from
`src.training.<module>` and `src.models`. After the merge into
packages/training, those modules live under packages/training/scripts/rl/.

This conftest installs sys.modules aliases so legacy test imports keep
working without touching every test file. New code should import the
modules directly from `scripts.rl.<module>` (with `packages/training`
on sys.path) or run via the scripts/rl __init__.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

_RL_DIR = Path(__file__).resolve().parent.parent.parent / "scripts" / "rl"

if str(_RL_DIR) not in sys.path:
    sys.path.insert(0, str(_RL_DIR))

# Build virtual `src` and `src.training` packages whose attribute lookups
# resolve to the real modules in scripts/rl. We lazy-import each child
# module on first attribute access so we don't pay collection cost for
# unused modules and so we surface real errors at the call site.

class _RLProxyPackage(types.ModuleType):
    """Package whose attribute / submodule access lazily resolves into scripts/rl."""

    __path__: list[str] = []

    def __getattr__(self, name: str):
        try:
            real = importlib.import_module(name)
        except ImportError as exc:
            raise AttributeError(name) from exc
        setattr(self, name, real)
        sys.modules[f"{self.__name__}.{name}"] = real
        return real


class _RLFinder:
    """Meta-path finder that maps `src.X` and `src.training.X` -> `X` (scripts/rl)."""

    _prefixes = ("src.training.", "src.")

    def find_spec(self, fullname: str, path=None, target=None):  # noqa: D401
        for prefix in self._prefixes:
            if fullname.startswith(prefix):
                leaf = fullname[len(prefix):]
                if "." in leaf:
                    return None
                if not (_RL_DIR / f"{leaf}.py").exists():
                    return None
                real = importlib.import_module(leaf)
                sys.modules[fullname] = real
                return real.__spec__
        return None


sys.modules.setdefault("src", _RLProxyPackage("src"))
sys.modules.setdefault("src.training", _RLProxyPackage("src.training"))
sys.meta_path.append(_RLFinder())
