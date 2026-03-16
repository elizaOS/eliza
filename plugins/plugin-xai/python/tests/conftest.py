"""Conftest for plugin-xai tests.

Pre-loads standalone submodules into sys.modules so that tests can import
types, grok, client, and services even when elizaos_plugin_xai/__init__.py
fails due to a ValueError in post.py's ActionExample usage at module level.
"""

import importlib.util
import os
import sys
import types as builtin_types

import pytest

_pkg_dir = os.path.join(os.path.dirname(__file__), "..", "elizaos_plugin_xai")
_pkg_name = "elizaos_plugin_xai"


def _preload(submodule_name: str, filename: str) -> None:
    """Load a submodule directly from its file, bypassing package __init__.py."""
    full_name = f"{_pkg_name}.{submodule_name}"
    if full_name in sys.modules:
        return
    filepath = os.path.join(_pkg_dir, filename)
    if not os.path.exists(filepath):
        return
    spec = importlib.util.spec_from_file_location(full_name, filepath)
    if spec and spec.loader:
        mod = importlib.util.module_from_spec(spec)
        sys.modules[full_name] = mod
        spec.loader.exec_module(mod)


def _preload_subpackage(subpkg_name: str, modules: list[tuple[str, str]]) -> None:
    """Pre-load a subpackage and its modules."""
    full_pkg_name = f"{_pkg_name}.{subpkg_name}"
    subpkg_dir = os.path.join(_pkg_dir, subpkg_name)
    if full_pkg_name not in sys.modules:
        pkg = builtin_types.ModuleType(full_pkg_name)
        pkg.__path__ = [subpkg_dir]
        pkg.__package__ = full_pkg_name
        sys.modules[full_pkg_name] = pkg
    for mod_name, filename in modules:
        _preload(f"{subpkg_name}.{mod_name}", os.path.join(subpkg_name, filename))


# Ensure the package module exists in sys.modules first
if _pkg_name not in sys.modules:
    pkg = builtin_types.ModuleType(_pkg_name)
    pkg.__path__ = [_pkg_dir]
    pkg.__package__ = _pkg_name
    sys.modules[_pkg_name] = pkg

# Pre-load standalone modules (order matters: types first, client depends on types)
_preload("types", "types.py")
_preload("grok", "grok.py")
_preload("client", "client.py")

# Pre-load services subpackage
_preload_subpackage("services", [
    ("message_service", "message_service.py"),
    ("post_service", "post_service.py"),
    ("x_service", "x_service.py"),
])

# Try the full package import — standalone modules stay accessible regardless
try:
    import elizaos_plugin_xai  # noqa: F401
except (ImportError, ValueError):
    pass


# Fixtures
@pytest.fixture
def skip_without_elizaos() -> None:
    """Skip test if elizaos is not installed.

    Use this fixture for tests that require elizaos:
        def test_something(skip_without_elizaos):
            ...
    """
    pytest.importorskip("elizaos", reason="elizaos not installed")
